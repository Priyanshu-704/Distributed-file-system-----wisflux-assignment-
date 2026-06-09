import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import * as Minio from "minio";
import { pool } from "../db";
import { logger } from "../logger";
import { validate } from "../middleware/validate";
import { initiateUploadSchema, uploadChunkSchema, mergeChunksSchema } from "../schemas/upload";
import { fileProcessingQueue } from "../queue";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const UPLOAD_ROOT = path.join("/usr/src/app/uploads");
const CHUNKS_DIR = path.join(UPLOAD_ROOT, "chunks");
const MERGED_DIR = path.join(UPLOAD_ROOT, "merged");

// Helper to serialize BigInt fields
const serializeSession = (session: any) => {
  if (!session) return null;
  return {
    ...session,
    fileSize: session.fileSize.toString(),
    processedFile: session.processedFile ? serializeProcessedFile(session.processedFile) : undefined,
  };
};

const serializeProcessedFile = (file: any) => {
  if (!file) return null;
  return {
    ...file,
    fileSize: file.fileSize.toString(),
  };
};

// 1. Initiate Upload Session
router.post(
  "/initiate",
  validate(initiateUploadSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { fileName, fileSize, mimeType, totalChunks } = req.body;

      const resDb = await pool.query(
        `INSERT INTO upload_sessions (file_name, file_size, mime_type, total_chunks, status, uploaded_chunks) 
         VALUES ($1, $2, $3, $4, 'PENDING', '{}') 
         RETURNING id, file_name AS "fileName", file_size AS "fileSize", mime_type AS "mimeType", total_chunks AS "totalChunks", status, uploaded_chunks AS "uploadedChunks", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [fileName, fileSize, mimeType, totalChunks]
      );
      const session = resDb.rows[0];

      logger.info(`Initialized upload session: ${session.id} for ${fileName} (${fileSize} bytes)`);
      res.status(201).json(serializeSession(session));
    } catch (error) {
      next(error);
    }
  }
);

// 2. Upload Chunk
router.post(
  "/:sessionId/chunk",
  upload.single("chunk"),
  validate(uploadChunkSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const chunkIndex = Number(req.query.chunkIndex);
      const clientHash = req.query.hash as string;

      if (!req.file) {
        res.status(400).json({ error: { message: "No chunk file provided", code: "MISSING_CHUNK_FILE" } });
        return;
      }

      // Verify session exists
      const sessionRes = await pool.query(`SELECT id, total_chunks AS "totalChunks" FROM upload_sessions WHERE id = $1`, [sessionId]);
      const session = sessionRes.rows[0];

      if (!session) {
        res.status(404).json({ error: { message: "Upload session not found", code: "SESSION_NOT_FOUND" } });
        return;
      }

      if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
        res.status(400).json({ error: { message: `Chunk index must be between 0 and ${session.totalChunks - 1}`, code: "INVALID_CHUNK_INDEX" } });
        return;
      }

      // Verify Integrity (MD5/SHA-256)
      const calculatedHash = crypto.createHash("md5").update(req.file.buffer).digest("hex");
      if (calculatedHash !== clientHash.toLowerCase()) {
        logger.warn(`Integrity check failed for session ${sessionId}, chunk ${chunkIndex}. Expected: ${clientHash}, got: ${calculatedHash}`);
        res.status(400).json({
          error: {
            message: "Chunk integrity check failed. MD5 hash mismatch.",
            code: "INTEGRITY_CHECK_FAILED",
          },
        });
        return;
      }

      // Write chunk to filesystem
      const sessionChunksDir = path.join(CHUNKS_DIR, sessionId);
      if (!fs.existsSync(sessionChunksDir)) {
        fs.mkdirSync(sessionChunksDir, { recursive: true });
      }

      const chunkPath = path.join(sessionChunksDir, chunkIndex.toString());
      fs.writeFileSync(chunkPath, req.file.buffer);

      // Add to uploadedChunks array in DB atomically
      await pool.query(
        `UPDATE upload_sessions
         SET 
           uploaded_chunks = (
             SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::integer[])
             FROM unnest(array_append(uploaded_chunks, $1::integer)) AS x
           ),
           status = 'UPLOADING',
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [chunkIndex, sessionId]
      );

      const updatedSessionRes = await pool.query(
        `SELECT id, file_name AS "fileName", file_size AS "fileSize", mime_type AS "mimeType", total_chunks AS "totalChunks", status, uploaded_chunks AS "uploadedChunks", created_at AS "createdAt", updated_at AS "updatedAt" FROM upload_sessions WHERE id = $1`,
        [sessionId]
      );
      const updatedSession = updatedSessionRes.rows[0];

      if (!updatedSession) {
        res.status(404).json({ error: { message: "Upload session not found", code: "SESSION_NOT_FOUND" } });
        return;
      }

      logger.info(`Saved chunk ${chunkIndex}/${session.totalChunks - 1} for session ${sessionId}`);
      res.status(200).json(serializeSession(updatedSession));
    } catch (error) {
      next(error);
    }
  }
);

// 3. Merge Chunks & Queue Processing
router.post(
  "/merge",
  validate(mergeChunksSchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.body;

      const sessionRes = await pool.query(`SELECT id, file_name AS "fileName", file_size AS "fileSize", mime_type AS "mimeType", total_chunks AS "totalChunks" FROM upload_sessions WHERE id = $1`, [sessionId]);
      const session = sessionRes.rows[0];

      if (!session) {
        res.status(404).json({ error: { message: "Upload session not found", code: "SESSION_NOT_FOUND" } });
        return;
      }

      // Verify all chunks are uploaded
      const missingChunks: number[] = [];
      const sessionChunksDir = path.join(CHUNKS_DIR, sessionId);

      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(sessionChunksDir, i.toString());
        if (!fs.existsSync(chunkPath)) {
          missingChunks.push(i);
        }
      }

      if (missingChunks.length > 0) {
        logger.warn(`Merge failed for session ${sessionId}: missing ${missingChunks.length} chunks`);
        res.status(400).json({
          error: {
            message: "Cannot merge. Some chunks are missing.",
            code: "MISSING_CHUNKS",
            details: { missingChunks },
          },
        });
        return;
      }

      // Create merged directory
      if (!fs.existsSync(MERGED_DIR)) {
        fs.mkdirSync(MERGED_DIR, { recursive: true });
      }

      // Perform stream merge
      const ext = path.extname(session.fileName);
      const mergedFileName = `${sessionId}${ext}`;
      const mergedFilePath = path.join(MERGED_DIR, mergedFileName);

      const writeStream = fs.createWriteStream(mergedFilePath);
      
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(sessionChunksDir, i.toString());
        const readStream = fs.createReadStream(chunkPath);
        
        await new Promise<void>((resolve, reject) => {
          readStream.pipe(writeStream, { end: false });
          readStream.on("end", resolve);
          readStream.on("error", reject);
        });
      }

      writeStream.end();

      // Ensure write stream is finished writing to disk
      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });

      logger.info(`Successfully merged all chunks for session ${sessionId} to ${mergedFilePath}`);

      // Clean up chunk files asynchronously
      fs.rm(sessionChunksDir, { recursive: true, force: true }, (err) => {
        if (err) logger.error(`Failed to clean up chunk directory for session ${sessionId}: ${err.message}`);
      });

      // Update session status and create processed file record using a transaction
      const client = await pool.connect();
      let updatedSession, processedFile;
      try {
        await client.query('BEGIN');
        
        const updateRes = await client.query(
          `UPDATE upload_sessions SET status = 'COMPLETED', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id, file_name AS "fileName", file_size AS "fileSize", mime_type AS "mimeType", total_chunks AS "totalChunks", status, uploaded_chunks AS "uploadedChunks", created_at AS "createdAt", updated_at AS "updatedAt"`,
          [sessionId]
        );
        updatedSession = updateRes.rows[0];

        const pfRes = await client.query(
          `INSERT INTO processed_files (upload_session_id, original_name, processed_name, file_size, mime_type, file_path, status) 
           VALUES ($1, $2, $3, $4, $5, $6, 'PROCESSING') 
           RETURNING id, upload_session_id AS "uploadSessionId", original_name AS "originalName", processed_name AS "processedName", file_size AS "fileSize", mime_type AS "mimeType", file_path AS "filePath", processing_duration AS "processingDuration", status, error_message AS "errorMessage", created_at AS "createdAt", updated_at AS "updatedAt"`,
          [sessionId, session.fileName, `processed_${session.fileName}`, session.fileSize, session.mimeType, mergedFilePath]
        );
        processedFile = pfRes.rows[0];

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      // Queue file processing job in BullMQ
      const job = await fileProcessingQueue.add(
        "process-file",
        {
          sessionId,
          processedFileId: processedFile.id,
          filePath: mergedFilePath,
          fileName: session.fileName,
          mimeType: session.mimeType,
        },
        {
          jobId: sessionId, // ensures duplicate prevention for this session
        }
      );

      logger.info(`Queued processing job ${job.id} for session ${sessionId}`);

      res.status(200).json({
        status: "success",
        message: "File successfully merged and processing job queued.",
        session: serializeSession(updatedSession),
        processedFile: serializeProcessedFile(processedFile),
      });
    } catch (error) {
      next(error);
    }
  }
);

// 4. Get all sessions (for dashboard list)
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const resDb = await pool.query(
        `SELECT 
           u.id, u.file_name AS "fileName", u.file_size AS "fileSize", u.mime_type AS "mimeType", u.total_chunks AS "totalChunks", u.status, u.uploaded_chunks AS "uploadedChunks", u.created_at AS "createdAt", u.updated_at AS "updatedAt",
           json_build_object(
             'id', p.id,
             'uploadSessionId', p.upload_session_id,
             'originalName', p.original_name,
             'processedName', p.processed_name,
             'fileSize', p.file_size,
             'mimeType', p.mime_type,
             'filePath', p.file_path,
             'minioKey', p.minio_key,
             'processingDuration', p.processing_duration,
             'status', p.status,
             'errorMessage', p.error_message,
             'createdAt', p.created_at,
             'updatedAt', p.updated_at
           ) AS "processedFile"
         FROM upload_sessions u
         LEFT JOIN processed_files p ON u.id = p.upload_session_id
         ORDER BY u.created_at DESC`
      );
      
      const sessions = resDb.rows.map(row => {
        if (row.processedFile && !row.processedFile.id) {
          row.processedFile = null;
        }
        return row;
      });

      res.status(200).json(sessions.map(serializeSession));
    } catch (error) {
      next(error);
    }
  }
);

// 5. Get session status (for resumption & dashboard)
router.get(
  "/:sessionId",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;

      const resDb = await pool.query(
        `SELECT 
           u.id, u.file_name AS "fileName", u.file_size AS "fileSize", u.mime_type AS "mimeType", u.total_chunks AS "totalChunks", u.status, u.uploaded_chunks AS "uploadedChunks", u.created_at AS "createdAt", u.updated_at AS "updatedAt",
           json_build_object(
             'id', p.id,
             'uploadSessionId', p.upload_session_id,
             'originalName', p.original_name,
             'processedName', p.processed_name,
             'fileSize', p.file_size,
             'mimeType', p.mime_type,
             'filePath', p.file_path,
             'minioKey', p.minio_key,
             'processingDuration', p.processing_duration,
             'status', p.status,
             'errorMessage', p.error_message,
             'createdAt', p.created_at,
             'updatedAt', p.updated_at
           ) AS "processedFile"
         FROM upload_sessions u
         LEFT JOIN processed_files p ON u.id = p.upload_session_id
         WHERE u.id = $1`,
         [sessionId]
      );
      
      if (resDb.rows.length === 0) {
        res.status(404).json({ error: { message: "Upload session not found", code: "SESSION_NOT_FOUND" } });
        return;
      }

      const session = resDb.rows[0];
      if (session.processedFile && !session.processedFile.id) {
        session.processedFile = null;
      }

      res.status(200).json(serializeSession(session));
    } catch (error) {
      next(error);
    }
  }
);

// 6. Delete Upload Session (and related files/data)
router.delete(
  "/:sessionId",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { sessionId } = req.params;

      const sessionRes = await pool.query(
        `SELECT u.file_name AS "fileName", u.mime_type AS "mimeType", p.file_path AS "filePath", p.minio_key AS "minioKey" 
         FROM upload_sessions u 
         LEFT JOIN processed_files p ON u.id = p.upload_session_id 
         WHERE u.id = $1`,
        [sessionId]
      );
      
      if (sessionRes.rows.length === 0) {
        res.status(404).json({ error: { message: "Upload session not found", code: "SESSION_NOT_FOUND" } });
        return;
      }
      
      const session = sessionRes.rows[0];

      // 1. Delete associated files from disk
      const chunksDir = path.join(CHUNKS_DIR, sessionId);
      if (fs.existsSync(chunksDir)) {
        fs.rmSync(chunksDir, { recursive: true, force: true });
        logger.info(`Deleted chunks directory for session ${sessionId}`);
      }

      const mergedPath = path.join(MERGED_DIR, `${sessionId}_${session.fileName}`);
      if (fs.existsSync(mergedPath)) {
        fs.unlinkSync(mergedPath);
        logger.info(`Deleted merged file at ${mergedPath}`);
      }

      if (session.filePath) {
        if (fs.existsSync(session.filePath)) {
          fs.unlinkSync(session.filePath);
          logger.info(`Deleted processed output file at ${session.filePath}`);
        }
      }

      // Delete from MinIO if exists
      if (session.minioKey) {
        try {
          const minioClient = new Minio.Client({
            endPoint: process.env.MINIO_ENDPOINT || "minio",
            port: parseInt(process.env.MINIO_PORT || "9000"),
            useSSL: process.env.MINIO_USE_SSL === "true",
            accessKey: process.env.MINIO_ACCESS_KEY || "minio_admin",
            secretKey: process.env.MINIO_SECRET_KEY || "minio_password_123",
          });
          const isImage = (session.mimeType && session.mimeType.startsWith("image/")) || 
                          /\.(jpg|jpeg|png|gif|webp|bmp|tiff)$/i.test(session.fileName);
          const bucketName = isImage
            ? (process.env.MINIO_BUCKET || "pipeline-uploads")
            : ((process.env.MINIO_BUCKET || "pipeline-uploads") + "-files");
          await minioClient.removeObject(bucketName, session.minioKey);
          logger.info(`Deleted MinIO object ${session.minioKey} from bucket ${bucketName} for session ${sessionId}`);
        } catch (err: any) {
          logger.error(`Failed to delete object from MinIO: ${err.message}`);
        }
      }

      // 2. Delete database records (ON DELETE CASCADE will remove processed_files row)
      await pool.query(`DELETE FROM upload_sessions WHERE id = $1`, [sessionId]);

      logger.info(`Successfully deleted upload session ${sessionId} and all related database entries / files`);

      res.status(200).json({
        status: "success",
        message: "Session and associated files successfully deleted.",
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
