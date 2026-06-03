import React, { useState, useRef, useEffect } from "react";
import { Upload, FileText, AlertCircle, Pause, Play, RotateCcw, CheckCircle, Loader2, X } from "lucide-react";
import { api } from "../api";
import { md5, CHUNK_SIZE, formatBytes } from "../utils";
import type { JobUpdate } from "../types";

export interface ActiveFileState {
  sessionId: string;
  file: File;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  uploadedChunks: number[];
  currentChunkIndex: number;
  status: "hashing" | "uploading" | "paused" | "merging" | "processing" | "completed" | "failed";
  progress: number;
  processingProgress: number;
  error?: string;
}

interface FileUploaderProps {
  onUploadComplete: () => void;
  socketSubscribe: (key: string, handler: (data: JobUpdate) => void) => () => void;
  onActiveSessionsChange: (sessionIds: string[]) => void;
  onFilesSelected: (count: number) => void;
  onJobFinished: (status: "COMPLETED" | "FAILED", durationMs: number) => void;
  resumeRequest?: { sessionId: string; file: File } | null;
  onResumeRequestProcessed?: () => void;
  onSessionInitiated?: (sessionId: string, file: File) => void;
}

export const FileUploader: React.FC<FileUploaderProps> = ({
  onUploadComplete,
  socketSubscribe,
  onActiveSessionsChange,
  onFilesSelected,
  onJobFinished,
  resumeRequest,
  onResumeRequestProcessed,
  onSessionInitiated,
}) => {
  const [dragActive, setDragActive] = useState(false);
  const [uploads, setUploads] = useState<Map<string, ActiveFileState>>(new Map());
  
  const uploadsRef = useRef<Map<string, ActiveFileState>>(new Map());
  const pausedFlagsRef = useRef<Map<string, boolean>>(new Map()); // sessionId -> isPaused
  const runningLoopsRef = useRef<Set<string>>(new Set()); // sessionId -> isRunning
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync ref to avoid stale closures in sequential loops
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  // Sync active sessions up to App.tsx
  useEffect(() => {
    const activeIds = Array.from(uploads.values())
      .map((u) => u.sessionId)
      .filter((id) => id !== "");
    onActiveSessionsChange(activeIds);
  }, [uploads, onActiveSessionsChange]);

  // Handle incoming resume requests from App.tsx
  useEffect(() => {
    if (resumeRequest) {
      handleResumeInterrupted(resumeRequest.sessionId, resumeRequest.file);
      if (onResumeRequestProcessed) {
        onResumeRequestProcessed();
      }
    }
  }, [resumeRequest, onResumeRequestProcessed]);

  const handleResumeInterrupted = async (sessionId: string, file: File) => {
    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const session = await api.upload.getSession(sessionId);
      const uploadedChunks = session.uploadedChunks || [];
      const progress = Math.round((uploadedChunks.length / totalChunks) * 100);

      const resumedState: ActiveFileState = {
        sessionId,
        file,
        fileName: file.name,
        fileSize: file.size,
        totalChunks,
        uploadedChunks,
        currentChunkIndex: 0,
        status: "uploading",
        progress,
        processingProgress: 0,
      };

      setUploads((prev) => {
        const next = new Map(prev);
        next.set(sessionId, resumedState);
        return next;
      });

      uploadsRef.current.set(sessionId, resumedState);
      pausedFlagsRef.current.set(sessionId, false);

      if (onSessionInitiated) {
        onSessionInitiated(sessionId, file);
      }

      setTimeout(() => {
        processChunks(sessionId);
      }, 50);
    } catch (err: any) {
      console.error("Failed to resume session:", err);
      alert(`Failed to resume session: ${err.message || err}`);
    }
  };

  // Subscribe to Socket.IO real-time processing events
  useEffect(() => {
    const unsubscribe = socketSubscribe("file-uploader-controls-multi", (data: JobUpdate) => {
      setUploads((prev) => {
        const next = new Map(prev);
        const existing = next.get(data.sessionId);
        if (!existing) return prev;
        
        if (data.status === "COMPLETED") {
          setTimeout(() => onUploadComplete(), 800);
          onJobFinished("COMPLETED", data.processedFile?.processingDuration || 0);
          next.set(data.sessionId, {
            ...existing,
            status: "completed",
            progress: 100,
            processingProgress: 100,
          });
        } else if (data.status === "FAILED") {
          setTimeout(() => onUploadComplete(), 800);
          onJobFinished("FAILED", 0);
          next.set(data.sessionId, {
            ...existing,
            status: "failed",
            error: data.errorMessage || "Simulated processing failure occurred.",
            processingProgress: 0,
          });
        } else if (data.status === "RETRYING") {
          next.set(data.sessionId, {
            ...existing,
            status: "processing",
            processingProgress: 0,
            error: `Error encountered. Retrying pipeline task (attempt ${data.attemptsMade}/3)...`,
          });
        } else {
          next.set(data.sessionId, {
            ...existing,
            status: "processing",
            processingProgress: data.progress,
            error: undefined,
          });
        }
        return next;
      });
    });

    return unsubscribe;
  }, [socketSubscribe, onUploadComplete]);

  // Sequential chunk push processor with parallel worker pool
  const processChunks = async (sessionId: string) => {
    if (runningLoopsRef.current.has(sessionId)) {
      return;
    }
    runningLoopsRef.current.add(sessionId);

    try {
      const CONCURRENCY = 4;
      const inFlight = new Set<number>();
      
      const uploadWorker = async (): Promise<void> => {
        while (true) {
          // Check if paused
          if (pausedFlagsRef.current.get(sessionId) === true) {
            return;
          }

          const current = uploadsRef.current.get(sessionId);
          if (!current) return;
          const { file, totalChunks, uploadedChunks } = current;

          // Find next non-uploaded, not-in-flight chunk index
          let nextIndex = -1;
          for (let i = 0; i < totalChunks; i++) {
            if (!uploadedChunks.includes(i) && !inFlight.has(i)) {
              nextIndex = i;
              break;
            }
          }

          if (nextIndex === -1) {
            return; // No more chunks left
          }

          inFlight.add(nextIndex);

          try {
            // Update status to uploading and specify active chunk index
            setUploads((prev) => {
              const next = new Map(prev);
              const curr = next.get(sessionId);
              if (curr) {
                next.set(sessionId, {
                  ...curr,
                  currentChunkIndex: nextIndex,
                  status: "uploading",
                });
              }
              return next;
            });

            // Slice chunk
            const start = nextIndex * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunkBlob = file.slice(start, end);
            
            // Compute hash
            const chunkBuffer = await chunkBlob.arrayBuffer();
            const hash = md5(chunkBuffer);

            // Check pause state again after async hash calculation
            if (pausedFlagsRef.current.get(sessionId) === true) {
              return;
            }

            // API push
            const response = await api.upload.uploadChunk(sessionId, nextIndex, hash, chunkBlob);

            // Update uploadedChunks array and progress
            setUploads((prev) => {
              const next = new Map(prev);
              const curr = next.get(sessionId);
              if (curr) {
                const combined = Array.from(new Set([...curr.uploadedChunks, ...response.uploadedChunks]));
                const updatedState = {
                  ...curr,
                  uploadedChunks: combined,
                  progress: Math.round((combined.length / totalChunks) * 100),
                };
                next.set(sessionId, updatedState);
                uploadsRef.current.set(sessionId, updatedState);
              }
              return next;
            });

          } finally {
            inFlight.delete(nextIndex);
          }
        }
      };

      // Spawn concurrent upload workers
      const workers = Array.from({ length: CONCURRENCY }, () => uploadWorker());
      await Promise.all(workers);

      // Final check before merging
      if (pausedFlagsRef.current.get(sessionId) === true) return;

      // Verify all chunks are uploaded
      const finalCheck = uploadsRef.current.get(sessionId);
      if (!finalCheck || finalCheck.uploadedChunks.length < finalCheck.totalChunks) {
        return;
      }

      setUploads((prev) => {
        const next = new Map(prev);
        const curr = next.get(sessionId);
        if (curr) next.set(sessionId, { ...curr, status: "merging", progress: 100 });
        return next;
      });

      await api.upload.merge(sessionId);

      setUploads((prev) => {
        const next = new Map(prev);
        const curr = next.get(sessionId);
        if (curr) next.set(sessionId, { ...curr, status: "processing", processingProgress: 0 });
        return next;
      });

    } catch (err: any) {
      setUploads((prev) => {
        const next = new Map(prev);
        const curr = next.get(sessionId);
        if (curr) {
          next.set(sessionId, {
            ...curr,
            status: "failed",
            error: err.message || "An error occurred during chunk ingestion.",
          });
        }
        return next;
      });
    } finally {
      runningLoopsRef.current.delete(sessionId);
    }
  };

  const handleFile = async (file: File) => {
    onFilesSelected(1);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const tempKey = `temp_${Date.now()}_${file.name}`;

    // 1. Set initial file selection state under temp key
    const freshState: ActiveFileState = {
      sessionId: "",
      file,
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
      uploadedChunks: [],
      currentChunkIndex: 0,
      status: "hashing",
      progress: 0,
      processingProgress: 0,
    };

    setUploads((prev) => {
      const next = new Map(prev);
      next.set(tempKey, freshState);
      return next;
    });

    try {
      // 2. Initiate session
      const session = await api.upload.initiate({
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || "application/octet-stream",
        totalChunks,
      });

      const initializedState: ActiveFileState = {
        ...freshState,
        sessionId: session.id,
        status: "uploading",
      };

      // Swap temp key with real session ID
      setUploads((prev) => {
        const next = new Map(prev);
        next.delete(tempKey);
        next.set(session.id, initializedState);
        return next;
      });

      pausedFlagsRef.current.set(session.id, false);

      if (onSessionInitiated) {
        onSessionInitiated(session.id, file);
      }

      // Force instant updates sync to ref before calling processor loop
      uploadsRef.current.set(session.id, initializedState);

      // 3. Begin sequential push
      await processChunks(session.id);

    } catch (err: any) {
      setUploads((prev) => {
        const next = new Map(prev);
        next.delete(tempKey);
        return next;
      });
      alert(`Failed to initiate upload session: ${err.message || err}`);
    }
  };

  const triggerPause = (sessionId: string) => {
    pausedFlagsRef.current.set(sessionId, true);
    setUploads((prev) => {
      const next = new Map(prev);
      const curr = next.get(sessionId);
      if (curr) {
        next.set(sessionId, { ...curr, status: "paused" });
      }
      return next;
    });
  };

  const triggerResume = async (sessionId: string) => {
    try {
      pausedFlagsRef.current.set(sessionId, false);
      setUploads((prev) => {
        const next = new Map(prev);
        const curr = next.get(sessionId);
        if (curr) {
          next.set(sessionId, { ...curr, status: "uploading", error: undefined });
        }
        return next;
      });

      // Query database for latest uploaded offset mapping
      const session = await api.upload.getSession(sessionId);
      
      setUploads((prev) => {
        const next = new Map(prev);
        const curr = next.get(sessionId);
        if (curr) {
          next.set(sessionId, {
            ...curr,
            uploadedChunks: session.uploadedChunks,
            progress: Math.round((session.uploadedChunks.length / curr.totalChunks) * 100),
          });
        }
        return next;
      });

      // Restart loop
      await processChunks(sessionId);
    } catch (err: any) {
      setUploads((prev) => {
        const next = new Map(prev);
        const curr = next.get(sessionId);
        if (curr) {
          next.set(sessionId, {
            ...curr,
            status: "failed",
            error: `Failed to resume session: ${err.message}`,
          });
        }
        return next;
      });
    }
  };

  const triggerRestart = async (sessionId: string) => {
    const current = uploadsRef.current.get(sessionId);
    if (!current) return;
    
    // Reset control variables and re-initialize completely
    pausedFlagsRef.current.set(sessionId, false);
    
    // Remove old session ID mapping from list
    setUploads((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });

    await handleFile(current.file);
  };

  const triggerDismiss = (key: string) => {
    setUploads((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    pausedFlagsRef.current.delete(key);
  };

  // Drag and drop events
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      Array.from(e.dataTransfer.files).forEach((file) => handleFile(file));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      Array.from(e.target.files).forEach((file) => handleFile(file));
      e.target.value = ""; // Reset value to allow selecting same file again
    }
  };

  // State machine styling & badges helpers
  const getBadgeStyle = (status: string) => {
    switch (status) {
      case "hashing":
        return "bg-slate-100 text-slate-700 border-slate-200";
      case "uploading":
        return "bg-blue-50 text-blue-700 border-blue-100 animate-pulse";
      case "paused":
        return "bg-amber-50 text-amber-700 border-amber-200 font-semibold";
      case "merging":
        return "bg-purple-50 text-purple-700 border-purple-100";
      case "processing":
        return "bg-indigo-50 text-indigo-700 border-indigo-100 font-medium";
      case "completed":
        return "bg-emerald-50 text-emerald-700 border-emerald-200";
      case "failed":
        return "bg-rose-50 text-rose-700 border-rose-200";
      default:
        return "bg-slate-100 text-slate-700 border-slate-200";
    }
  };

  const getStatusText = (upload: ActiveFileState) => {
    switch (upload.status) {
      case "hashing":
        return "Calculating cryptographic integrity hash...";
      case "uploading":
        return `Uploading chunk ${upload.currentChunkIndex + 1} of ${upload.totalChunks}`;
      case "paused":
        return "PAUSED";
      case "merging":
        return "Ingestion complete. Reassembling chunk binaries...";
      case "processing":
        return "Processing Asset on Worker Node...";
      case "completed":
        return "Asset fully processed & registered.";
      case "failed":
        return "Operation interrupted.";
      default:
        return "Queue initialized.";
    }
  };

  const queueList = Array.from(uploads.entries()).filter(
    ([_, u]) => u.status !== "completed"
  );

  const activeOperationsList = Array.from(uploads.values()).filter(
    (u) => !["idle", "completed"].includes(u.status)
  );

  return (
    <div className="space-y-6">
      
      {/* Dropzone Interface (Allows Multiple Selection) */}
      <div
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`relative cursor-pointer rounded-2xl border border-dashed p-10 text-center transition-all duration-300 ${
          dragActive
            ? "border-blue-600 bg-blue-50/50 shadow-sm"
            : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />
        <div className="flex flex-col items-center gap-4">
          <div className="p-4 rounded-full bg-slate-50 text-slate-400 border border-slate-100">
            <Upload size={28} strokeWidth={1.75} />
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800">
              Drag and drop your files/videos here, or <span className="text-blue-600 font-medium">browse local files</span>
            </p>
            <p className="text-xs text-slate-400 mt-1">
              Supports selecting multiple files concurrently with individual pause/resume controls.
            </p>
          </div>
        </div>
      </div>

      {/* Selected File Details Badges */}
      {queueList.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider">
            Ingestion Queue ({queueList.length} active)
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {queueList.map(([key, upload]) => (
              <div key={key} className="premium-card p-3 flex items-center justify-between gap-3 animate-fade-in-up bg-slate-50/50">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2 rounded-xl bg-white border border-slate-200 text-slate-500">
                    <FileText size={16} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-800 truncate">
                      {upload.fileName}
                    </p>
                    <p className="text-[10px] text-slate-400">
                      Size: {formatBytes(upload.fileSize)} • Status: <span className="capitalize">{upload.status}</span>
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => triggerDismiss(upload.sessionId || key)}
                  className="p-1 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors"
                  title="Remove from Ingestor"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active Operations Panel (Visible for each active run) */}
      {activeOperationsList.length > 0 && (
        <div className="space-y-4">
          <div className="pb-2 border-b border-slate-100">
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider">
              Pipeline Control Stations
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Monitor and control active processing runs in real-time
            </p>
          </div>
          
          <div className="space-y-4">
            {activeOperationsList.map((upload) => {
              const sessionKey = upload.sessionId || `temp_${upload.fileName}`;
              return (
                <div key={sessionKey} className="premium-card p-5 space-y-4 animate-fade-in-up">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-sm font-bold text-slate-800 truncate">
                        {upload.fileName}
                      </h4>
                      <p className="text-[10px] text-slate-400 font-mono">
                        Session: {upload.sessionId || "initializing..."}
                      </p>
                    </div>
                    
                    {/* Status Badge */}
                    <div className={`px-2.5 py-1 rounded-full text-xs font-semibold border flex items-center gap-1.5 ${getBadgeStyle(upload.status)}`}>
                      {["hashing", "merging"].includes(upload.status) && (
                        <Loader2 size={10} className="animate-spin" />
                      )}
                      {upload.status === "processing" && (
                        <Loader2 size={10} className="animate-spin" />
                      )}
                      {upload.status === "completed" && (
                        <CheckCircle size={10} />
                      )}
                      <span className="capitalize">{getStatusText(upload)}</span>
                    </div>
                  </div>

                  {/* Progress Section */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[11px] font-medium text-slate-500">
                      <span>
                        {upload.status === "processing" ? "Worker Progress" : "Uploading Offset"}
                      </span>
                      <span className="font-mono">
                        {upload.status === "processing"
                          ? `${upload.processingProgress}%`
                          : `${upload.progress}%`}
                      </span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          upload.status === "paused"
                            ? "bg-amber-500"
                            : upload.status === "failed"
                            ? "bg-rose-500"
                            : upload.status === "processing"
                            ? "bg-indigo-600"
                            : "bg-blue-600"
                        }`}
                        style={{
                          width: `${
                            upload.status === "processing"
                              ? upload.processingProgress
                              : upload.progress
                          }%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Error notice */}
                  {upload.error && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-rose-50 border border-rose-100 text-rose-700 text-xs">
                      <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                      <span>{upload.error}</span>
                    </div>
                  )}

                  {/* Dynamic Action Buttons Group */}
                  <div className="flex flex-wrap items-center gap-2">
                    {upload.status === "uploading" && (
                      <button
                        onClick={() => triggerPause(upload.sessionId)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white transition-all shadow-sm"
                      >
                        <Pause size={12} />
                        Pause Upload
                      </button>
                    )}

                    {upload.status === "paused" && (
                      <>
                        <button
                          onClick={() => triggerResume(upload.sessionId)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-all shadow-sm"
                        >
                          <Play size={12} />
                          Resume Upload
                        </button>
                        <button
                          onClick={() => triggerRestart(upload.sessionId)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-200 hover:border-slate-300 text-slate-600 hover:bg-slate-50 transition-all bg-white"
                        >
                          <RotateCcw size={12} />
                          Restart From Scratch
                        </button>
                      </>
                    )}

                    {/* Muted restart button if failed */}
                    {upload.status === "failed" && (
                      <button
                        onClick={() => triggerRestart(upload.sessionId)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-all shadow-sm"
                      >
                        <RotateCcw size={12} />
                        Retry / Restart Fresh
                      </button>
                    )}

                    {/* Disable notice if processing on BullMQ */}
                    {upload.status === "processing" && (
                      <p className="text-[11px] text-slate-400 italic">
                        Processing active on worker node. Controls locked.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
