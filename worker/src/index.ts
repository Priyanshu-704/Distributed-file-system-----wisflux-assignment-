import { Worker, Job } from "bullmq";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { pipeline } from "stream";
import { promisify } from "util";
import { createClient } from "redis";
import * as Minio from "minio";
import Jimp from "jimp";
import { pool } from "./db";
import { logger } from "./logger";

const pipe = promisify(pipeline);

const compressFile = async (inputPath: string, outputPath: string) => {
  const source = fs.createReadStream(inputPath);
  const destination = fs.createWriteStream(outputPath);
  const gzip = zlib.createGzip();
  await pipe(source, gzip, destination);
};

const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || "minio",
  port: parseInt(process.env.MINIO_PORT || "9000"),
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY || "minio_admin",
  secretKey: process.env.MINIO_SECRET_KEY || "minio_password_123",
});

const redisConnection = {
  host: process.env.REDIS_HOST || "redis",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
};

const PROCESSED_DIR = path.join("/usr/src/app/uploads/processed");

// Ensure processed directory exists
if (!fs.existsSync(PROCESSED_DIR)) {
  fs.mkdirSync(PROCESSED_DIR, { recursive: true });
}

// Set up Redis Publisher
const redisUrl = `redis://:${process.env.REDIS_PASSWORD || ""}@${process.env.REDIS_HOST || "redis"}:${process.env.REDIS_PORT || "6379"}`;
const redisPublisher = createClient({ url: redisUrl });

redisPublisher.on("error", (err) => logger.error(`Redis Publisher Error: ${err.message}`));

const initPublisher = async () => {
  try {
    await redisPublisher.connect();
    logger.info("Redis Publisher connected successfully for worker Pub/Sub.");
  } catch (err: any) {
    logger.error(`Redis Publisher connection failed: ${err.message}`);
  }
};
initPublisher();

const publishUpdate = async (payload: any) => {
  try {
    if (!redisPublisher.isOpen) {
      await redisPublisher.connect();
    }
    await redisPublisher.publish("job-updates", JSON.stringify(payload));
  } catch (err: any) {
    logger.error(`Failed to publish Redis update: ${err.message}`);
  }
};

interface FileJobData {
  sessionId: string;
  processedFileId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
}

const worker = new Worker(
  "file-processing",
  async (job: Job<FileJobData>) => {
    const { sessionId, processedFileId, filePath, fileName, mimeType } = job.data;
    const startTime = Date.now();

    logger.info(`Started job ${job.id} for session ${sessionId} (Attempt ${job.attemptsMade + 1}/3)`);

    // 1. Update DB to PROCESSING
    await pool.query(
      `UPDATE processed_files SET status = 'PROCESSING', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [processedFileId]
    );

    // Publish start event
    await publishUpdate({
      sessionId,
      processedFileId,
      status: "PROCESSING",
      progress: 0,
      attemptsMade: job.attemptsMade,
    });

    // 2. Simulate failure if requested (e.g. filename has 'fail' or 'corrupt')
    if (fileName.toLowerCase().includes("fail") || fileName.toLowerCase().includes("corrupt")) {
      // Simulate partial work before failure
      await new Promise((resolve) => setTimeout(resolve, 2000));
      logger.warn(`Simulating job failure for file: ${fileName} (Attempt ${job.attemptsMade + 1})`);
      throw new Error(`Simulated processing error for file: ${fileName}`);
    }

    // 3. Simulate processing steps (e.g., transcoding/resizing simulation)
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1500)); // total ~6 seconds
      const progress = Math.round((i / steps) * 100);
      await job.updateProgress(progress);
      logger.info(`Job ${job.id} progress: ${progress}%`);

      // Publish progress update
      await publishUpdate({
        sessionId,
        processedFileId,
        status: "PROCESSING",
        progress,
        attemptsMade: job.attemptsMade,
      });
    }

    // 4. Simulate actual output file generation
    if (!fs.existsSync(filePath)) {
      throw new Error(`Merged file not found at path: ${filePath}`);
    }

    const processedFileName = `processed_${sessionId}_${fileName}`;
    const processedFilePath = path.join(PROCESSED_DIR, processedFileName);

    const isImage = (mimeType && mimeType.startsWith("image/")) || 
                    /\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(fileName);

    let minioKey: string | null = null;
    
    if (isImage) {
      // 1. Upload original file to MinIO image bucket
      try {
        const bucketName = process.env.MINIO_BUCKET || "pipeline-uploads";
        const bucketExists = await minioClient.bucketExists(bucketName);
        if (!bucketExists) {
          await minioClient.makeBucket(bucketName, "us-east-1");
          logger.info(`Created MinIO bucket: ${bucketName}`);
        }
        
        const objectName = `${sessionId}_${fileName}`;
        logger.info(`Uploading original image to MinIO bucket ${bucketName} as ${objectName}...`);
        await minioClient.fPutObject(bucketName, objectName, filePath);
        minioKey = objectName;
        logger.info(`Successfully uploaded original image to MinIO.`);
      } catch (err: any) {
        logger.error(`MinIO upload failed: ${err.message}`);
        throw new Error(`Failed to upload original image to MinIO: ${err.message}`);
      }

      // 2. Generate thumbnail using Jimp for images
      try {
        logger.info(`Generating thumbnail using Jimp for ${fileName}...`);
        const image = await Jimp.read(filePath);
        await image
          .resize(300, Jimp.AUTO)
          .quality(75)
          .writeAsync(processedFilePath);
        logger.info(`Successfully generated and saved thumbnail at ${processedFilePath}`);
      } catch (err: any) {
        logger.warn(`Jimp thumbnail generation failed: ${err.message}. Falling back to copying original file.`);
        fs.copyFileSync(filePath, processedFilePath);
      }
    } else {
      // 1. Compress the file using gzip
      const compressedTempPath = `${filePath}.gz`;
      try {
        logger.info(`Compressing non-image file ${fileName} using gzip...`);
        await compressFile(filePath, compressedTempPath);
        logger.info(`Successfully compressed to ${compressedTempPath}`);
      } catch (err: any) {
        logger.error(`Compression failed: ${err.message}`);
        throw new Error(`Failed to compress file: ${err.message}`);
      }

      // 2. Upload compressed file to MinIO files bucket
      try {
        const bucketName = (process.env.MINIO_BUCKET || "pipeline-uploads") + "-files";
        const bucketExists = await minioClient.bucketExists(bucketName);
        if (!bucketExists) {
          await minioClient.makeBucket(bucketName, "us-east-1");
          logger.info(`Created MinIO bucket: ${bucketName}`);
        }
        
        const objectName = `${sessionId}_${fileName}.gz`;
        logger.info(`Uploading compressed file to MinIO bucket ${bucketName} as ${objectName}...`);
        await minioClient.fPutObject(bucketName, objectName, compressedTempPath);
        minioKey = objectName;
        logger.info(`Successfully uploaded compressed file to MinIO.`);
      } catch (err: any) {
        logger.error(`MinIO upload failed: ${err.message}`);
        throw new Error(`Failed to upload compressed file to MinIO: ${err.message}`);
      } finally {
        // Clean up temporary compressed file
        if (fs.existsSync(compressedTempPath)) {
          fs.unlinkSync(compressedTempPath);
        }
      }

      // 3. Read input and write to output file for non-images (videos, zip files, etc.)
      fs.copyFileSync(filePath, processedFilePath);
    }

    const duration = Date.now() - startTime;

    // 5. Update DB to COMPLETED
    const updatedProcessedFileRes = await pool.query(
      `UPDATE processed_files 
       SET status = 'COMPLETED', processed_name = $1, file_path = $2, minio_key = $3, processing_duration = $4, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $5 
       RETURNING id, processed_name AS "processedName", file_path AS "filePath", minio_key AS "minioKey", processing_duration AS "processingDuration", status`,
      [processedFileName, processedFilePath, minioKey, duration, processedFileId]
    );
    const updatedProcessedFile = updatedProcessedFileRes.rows[0];

    // Publish completion event
    await publishUpdate({
      sessionId,
      processedFileId,
      status: "COMPLETED",
      progress: 100,
      attemptsMade: job.attemptsMade,
      processedFile: {
        id: updatedProcessedFile.id,
        processedName: updatedProcessedFile.processedName,
        filePath: updatedProcessedFile.filePath,
        minioKey: updatedProcessedFile.minioKey,
        processingDuration: updatedProcessedFile.processingDuration,
        status: updatedProcessedFile.status,
      },
    });

    logger.info(`Completed job ${job.id} successfully in ${duration}ms. Output: ${processedFilePath}`);
    return { processedFilePath, duration };
  },
  {
    connection: redisConnection,
    concurrency: 5, // process up to 5 jobs concurrently
  }
);

// Worker Event Listeners for structural logging
worker.on("active", (job) => {
  logger.info(`Job ${job.id} is now active.`);
});

worker.on("completed", (job, result) => {
  logger.info(`Job ${job.id} has completed.`);
});

worker.on("failed", async (job, err) => {
  logger.error(`Job ${job?.id} failed: ${err.message}`);
  
  if (job) {
    const { sessionId, processedFileId } = job.data;
    const maxAttempts = job.opts.attempts || 3;
    const attemptsMade = job.attemptsMade;

    if (attemptsMade >= maxAttempts) {
      logger.error(`Job ${job.id} has exhausted all ${maxAttempts} retries. Marking ProcessedFile as FAILED.`);
      
      const updatedProcessedFileRes = await pool.query(
        `UPDATE processed_files 
         SET status = 'FAILED', error_message = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 
         RETURNING id, status, error_message AS "errorMessage"`,
        [err.message, processedFileId]
      );
      const updatedProcessedFile = updatedProcessedFileRes.rows[0];

      // Publish failure event
      await publishUpdate({
        sessionId,
        processedFileId,
        status: "FAILED",
        progress: 0,
        attemptsMade,
        errorMessage: err.message,
        processedFile: {
          id: updatedProcessedFile.id,
          status: updatedProcessedFile.status,
          errorMessage: updatedProcessedFile.errorMessage,
        },
      });
    } else {
      logger.warn(`Job ${job.id} failed, retry scheduled. Attempts made: ${attemptsMade}/${maxAttempts}`);
      
      // Publish attempt failure / retrying event
      await publishUpdate({
        sessionId,
        processedFileId,
        status: "RETRYING",
        progress: 0,
        attemptsMade,
        errorMessage: err.message,
      });
    }
  }
});

worker.on("error", (err) => {
  logger.error(`Worker error: ${err.message}`, { error: err });
});

logger.info("Worker listening to 'file-processing' queue.");
