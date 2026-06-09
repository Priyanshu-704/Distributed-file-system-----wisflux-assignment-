// Types for the Distributed File Processing Pipeline

export interface UploadSession {
  id: string;
  fileName: string;
  fileSize: string; // BigInt serialized as string
  mimeType: string;
  totalChunks: number;
  uploadedChunks: number[];
  status: 'PENDING' | 'UPLOADING' | 'COMPLETED' | 'FAILED';
  createdAt: string;
  updatedAt: string;
  processedFile?: ProcessedFile;
}

export interface ProcessedFile {
  id: string;
  uploadSessionId: string;
  originalName: string;
  processedName: string;
  fileSize: string;
  mimeType: string;
  filePath: string;
  minioKey?: string | null;
  processingDuration: number;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobUpdate {
  sessionId: string;
  processedFileId: string;
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETRYING';
  progress: number;
  attemptsMade: number;
  errorMessage?: string;
  processedFile?: Partial<ProcessedFile>;
}

export interface ChunkUploadProgress {
  sessionId: string;
  fileName: string;
  totalChunks: number;
  uploadedChunks: number;
  phase: 'hashing' | 'uploading' | 'merging' | 'queued' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  processingProgress: number; // from worker 0-100
  error?: string;
}
