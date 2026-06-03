import { z } from "zod";

export const initiateUploadSchema = z.object({
  body: z.object({
    fileName: z.string().min(1, "File name is required"),
    fileSize: z.union([z.number().positive(), z.string().regex(/^\d+$/)]).transform((val) => BigInt(val)),
    mimeType: z.string().min(1, "MIME type is required"),
    totalChunks: z.number().int().positive("Total chunks must be a positive integer"),
  }),
});

export const uploadChunkSchema = z.object({
  params: z.object({
    sessionId: z.string().uuid("Invalid session ID format"),
  }),
  query: z.object({
    chunkIndex: z.string().regex(/^\d+$/).transform(Number),
    hash: z.string().min(1, "Hash is required"), // MD5/SHA-256 hash of the chunk
  }),
});

export const mergeChunksSchema = z.object({
  body: z.object({
    sessionId: z.string().uuid("Invalid session ID format"),
  }),
});
