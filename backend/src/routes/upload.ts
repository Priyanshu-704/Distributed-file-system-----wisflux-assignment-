import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { prisma } from "../prisma";
import { logger } from "../logger";
import { validate } from "../middleware/validate";
import { initiateUploadSchema, uploadChunkSchema, mergeChunksSchema } from "../schemas/upload";
import { fileProcessingQueue } from "../queue";
import { UploadStatus } from "@prisma/client";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

const UPLOAD_ROOT = path.join("/usr/src/app/uploads");
const CHUNKS_DIR = path.join(UPLOAD_ROOT, "chunks");
const MERGED_DIR = path.join(UPLOAD_ROOT, "merged");

// Helper to serialize BigInt fields in Prisma models
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

      const session = await prisma.uploadSession.create({
        data: {
          fileName,
          fileSize,
          mimeType,
          totalChunks,
          status: "PENDING",
          uploadedChunks: [],
        },
      });

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
      const session = await prisma.uploadSession.findUnique({
        where: { id: sessionId },
      });

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

      // Add to uploadedChunks array in DB atomically to support high concurrency chunk uploads
      await prisma.$executeRaw`
        UPDATE "UploadSession"
        SET 
          "uploadedChunks" = (
            SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::integer[])
            FROM unnest(array_append("uploadedChunks", ${chunkIndex}::integer)) AS x
          ),
          "status" = 'UPLOADING'::"UploadStatus"
        WHERE id = ${sessionId}
      `;

      const updatedSession = await prisma.uploadSession.findUnique({
        where: { id: sessionId },
      });

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

      const session = await prisma.uploadSession.findUnique({
        where: { id: sessionId },
      });

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

      // Update session status and create processed file record
      const result = await prisma.$transaction(async (tx) => {
        const updatedSession = await tx.uploadSession.update({
          where: { id: sessionId },
          data: { status: "COMPLETED" },
        });

        const processedFile = await tx.processedFile.create({
          data: {
            uploadSessionId: sessionId,
            originalName: session.fileName,
            processedName: `processed_${session.fileName}`,
            fileSize: session.fileSize,
            mimeType: session.mimeType,
            filePath: mergedFilePath,
            processingDuration: 0,
            status: "PROCESSING",
          },
        });

        return { session: updatedSession, processedFile };
      });

      // Queue file processing job in BullMQ
      const job = await fileProcessingQueue.add(
        "process-file",
        {
          sessionId,
          processedFileId: result.processedFile.id,
          filePath: mergedFilePath,
          fileName: session.fileName,
        },
        {
          jobId: sessionId, // ensures duplicate prevention for this session
        }
      );

      logger.info(`Queued processing job ${job.id} for session ${sessionId}`);

      res.status(200).json({
        status: "success",
        message: "File successfully merged and processing job queued.",
        session: serializeSession(result.session),
        processedFile: serializeProcessedFile(result.processedFile),
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
      const sessions = await prisma.uploadSession.findMany({
        orderBy: { createdAt: "desc" },
        include: { processedFile: true },
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

      const session = await prisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { processedFile: true },
      });

      if (!session) {
        res.status(404).json({ error: { message: "Upload session not found", code: "SESSION_NOT_FOUND" } });
        return;
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

      const session = await prisma.uploadSession.findUnique({
        where: { id: sessionId },
        include: { processedFile: true },
      });

      if (!session) {
        res.status(404).json({ error: { message: "Upload session not found", code: "SESSION_NOT_FOUND" } });
        return;
      }

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

      if (session.processedFile && session.processedFile.filePath) {
        if (fs.existsSync(session.processedFile.filePath)) {
          fs.unlinkSync(session.processedFile.filePath);
          logger.info(`Deleted processed output file at ${session.processedFile.filePath}`);
        }
      }

      // 2. Delete database records (onDelete: Cascade will remove ProcessedFile row)
      await prisma.uploadSession.delete({
        where: { id: sessionId },
      });

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
