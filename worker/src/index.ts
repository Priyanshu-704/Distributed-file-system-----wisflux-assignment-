import { Worker, Job } from "bullmq";
import fs from "fs";
import path from "path";
import { createClient } from "redis";
import { prisma } from "./prisma";
import { logger } from "./logger";

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
}

const worker = new Worker(
  "file-processing",
  async (job: Job<FileJobData>) => {
    const { sessionId, processedFileId, filePath, fileName } = job.data;
    const startTime = Date.now();

    logger.info(`Started job ${job.id} for session ${sessionId} (Attempt ${job.attemptsMade + 1}/3)`);

    // 1. Update DB to PROCESSING
    await prisma.processedFile.update({
      where: { id: processedFileId },
      data: { status: "PROCESSING" },
    });

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

    // Read input and write to output file
    fs.copyFileSync(filePath, processedFilePath);

    const duration = Date.now() - startTime;

    // 5. Update DB to COMPLETED
    const updatedProcessedFile = await prisma.processedFile.update({
      where: { id: processedFileId },
      data: {
        status: "COMPLETED",
        processedName: processedFileName,
        filePath: processedFilePath,
        processingDuration: duration,
      },
    });

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
      
      const updatedProcessedFile = await prisma.processedFile.update({
        where: { id: processedFileId },
        data: {
          status: "FAILED",
          errorMessage: err.message,
        },
      });

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
