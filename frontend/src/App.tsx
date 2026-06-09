import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Server, Activity, Cable, RefreshCw, BarChart2, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { useSocket } from "./useSocket";
import { FileUploader } from "./components/FileUploader";
import { Dashboard } from "./components/Dashboard";
import { api } from "./api";
import type { UploadSession, JobUpdate } from "./types";

function App() {
  const [sessions, setSessions] = useState<UploadSession[]>([]);
  const [loading, setLoading] = useState(false);
  const { connected: socketConnected, subscribe } = useSocket();
  const [backendStatus, setBackendStatus] = useState<"Online" | "Offline">("Offline");
  const [activeSessionIds, setActiveSessionIds] = useState<string[]>([]);

  // Ref and State for resuming interrupted sessions
  const resumeFileInputRef = useRef<HTMLInputElement>(null);
  const activeFilesRef = useRef<Map<string, File>>(new Map());
  const [resumingSession, setResumingSession] = useState<UploadSession | null>(null);
  const [resumeRequest, setResumeRequest] = useState<{ sessionId: string; file: File } | null>(null);

  // Custom Toast System
  const [toasts, setToasts] = useState<Array<{ id: string; message: string; type: "success" | "error" | "info" }>>([]);
  const showToast = useCallback((message: string, type: "success" | "error" | "info" = "info") => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  // Custom Modal Confirmation System
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // Custom Session Ingestion Metrics System
  const [sessionStats, setSessionStats] = useState({
    totalSelected: 0,
    successCount: 0,
    failCount: 0,
    processingDurations: [] as number[],
  });

  const handleActiveSessionsChange = useCallback((ids: string[]) => {
    setActiveSessionIds(ids);
  }, []);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.upload.getAllSessions();
      setSessions(data);
      setBackendStatus("Online");
    } catch (err) {
      console.error("Failed to load upload history:", err);
      setBackendStatus("Offline");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch history on load
  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Subscribe to real-time updates
  useEffect(() => {
    const unsubscribe = subscribe("app-main-refactor", (data: JobUpdate) => {
      setSessions((prev) =>
        prev.map((session) => {
          if (session.id === data.sessionId) {
            const existingProc = session.processedFile;

            return {
              ...session,
              status: data.status === "COMPLETED" ? "COMPLETED" : session.status,
              processedFile: {
                id: data.processedFileId,
                uploadSessionId: data.sessionId,
                originalName: session.fileName,
                processedName: data.processedFile?.processedName || existingProc?.processedName || `processed_${session.fileName}`,
                fileSize: session.fileSize,
                mimeType: session.mimeType,
                filePath: data.processedFile?.filePath || existingProc?.filePath || "",
                minioKey: data.processedFile?.minioKey || existingProc?.minioKey || null,
                processingDuration: data.processedFile?.processingDuration || existingProc?.processingDuration || 0,
                status: data.status === "RETRYING" ? "PROCESSING" : (data.status as any),
                errorMessage: data.errorMessage || null,
                createdAt: existingProc?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            };
          }
          return session;
        })
      );
    });
    return unsubscribe;
  }, [subscribe]);

  const handleUploadComplete = useCallback(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleFilesSelected = useCallback((count: number) => {
    setSessionStats((prev) => ({
      ...prev,
      totalSelected: prev.totalSelected + count,
    }));
    showToast(`Added ${count} file(s) to the active ingestor queue.`, "info");
  }, [showToast]);

  const handleJobFinished = useCallback((status: "COMPLETED" | "FAILED", durationMs: number) => {
    setSessionStats((prev) => {
      const isSuccess = status === "COMPLETED";
      return {
        ...prev,
        successCount: prev.successCount + (isSuccess ? 1 : 0),
        failCount: prev.failCount + (isSuccess ? 0 : 1),
        processingDurations: isSuccess && durationMs > 0
          ? [...prev.processingDurations, durationMs]
          : prev.processingDurations,
      };
    });
    if (status === "COMPLETED") {
      showToast("Ingestion task and database serialization succeeded!", "success");
    } else {
      showToast("Queue processing task execution failed on worker node.", "error");
    }
  }, [showToast]);

  const handleDeleteSession = useCallback((sessionId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: "Delete Session Record",
      message: "Are you sure you want to delete this session and permanently clean up all associated chunk files and output binaries? This cannot be undone.",
      onConfirm: async () => {
        try {
          await api.upload.delete(sessionId);
          showToast("Session record and files successfully deleted from storage node.", "success");
          fetchHistory();
        } catch (err: any) {
          showToast(`Failed to delete session: ${err.message || err}`, "error");
        }
      }
    });
  }, [fetchHistory, showToast]);

  const handleSessionInitiated = useCallback((sessionId: string, file: File) => {
    activeFilesRef.current.set(sessionId, file);
  }, []);

  const handleResumeSession = useCallback((session: UploadSession) => {
    const existingFile = activeFilesRef.current.get(session.id);
    if (existingFile) {
      setResumeRequest({ sessionId: session.id, file: existingFile });
      showToast(`Resuming session ${session.id.substring(0, 8)} immediately...`, "info");
    } else {
      setResumingSession(session);
      if (resumeFileInputRef.current) {
        resumeFileInputRef.current.click();
      }
    }
  }, [showToast]);

  const handleResumeFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0 && resumingSession) {
      const file = e.target.files[0];
      const expectedSize = Number(resumingSession.fileSize);
      if (file.name !== resumingSession.fileName || file.size !== expectedSize) {
        showToast(`Selected file does not match "${resumingSession.fileName}" (${expectedSize} bytes).`, "error");
      } else {
        setResumeRequest({ sessionId: resumingSession.id, file });
        showToast(`Resuming session ${resumingSession.id.substring(0, 8)}...`, "info");
      }
    }
    e.target.value = "";
  };

  // Derived dashboard statistics
  const stats = useMemo(() => {
    const total = sessions.length;
    const completed = sessions.filter((s) => s.processedFile?.status === "COMPLETED").length;
    const failed = sessions.filter((s) => s.processedFile?.status === "FAILED").length;
    const successRate = total > 0 ? Math.round((completed / (completed + failed || 1)) * 100) : 0;

    return {
      total,
      completed,
      failed,
      successRate: total > 0 ? (completed + failed > 0 ? successRate : 100) : 100,
    };
  }, [sessions]);

  const avgSessionTime = useMemo(() => {
    if (sessionStats.processingDurations.length === 0) return 0;
    const total = sessionStats.processingDurations.reduce((a, b) => a + b, 0);
    return Math.round(total / sessionStats.processingDurations.length);
  }, [sessionStats.processingDurations]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col items-center p-4 md:p-8 w-full">
      <div className="w-full space-y-6">

        {/* Header Section */}
        <header className="premium-card p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl md:text-2xl font-black text-slate-900 tracking-tight">
              Ingest & Processing Pipeline
            </h1>
            <p className="text-xs text-slate-400 mt-0.5 font-mono">
              Distributed worker coordination node
            </p>
          </div>

          {/* Services Health Monitor */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200">
              <Server size={13} className={backendStatus === "Online" ? "text-emerald-600" : "text-rose-500"} />
              <span className="text-xs font-semibold text-slate-700">API Gateway</span>
            </div>

            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200">
              <Cable size={13} className={socketConnected ? "text-emerald-600 animate-pulse" : "text-rose-500"} />
              <span className="text-xs font-semibold text-slate-700">Socket.IO</span>
            </div>

            <button
              onClick={fetchHistory}
              className="p-1.5 rounded-xl border border-slate-200 text-slate-400 hover:text-slate-700 bg-white hover:bg-slate-50 transition-all"
              title="Sync Stats"
            >
              <RefreshCw size={13} />
            </button>
          </div>
        </header>

        {/* Quick Stats Ribbon */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">

          <div className="premium-card p-5 flex items-center gap-4">
            <div className="p-3.5 rounded-xl bg-blue-50 text-blue-600">
              <BarChart2 size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Total Uploads</p>
              <h3 className="text-xl font-bold text-slate-900 mt-0.5">{stats.total} files</h3>
            </div>
          </div>

          <div className="premium-card p-5 flex items-center gap-4">
            <div className="p-3.5 rounded-xl bg-emerald-50 text-emerald-600">
              <CheckCircle2 size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Completed Processing</p>
              <h3 className="text-xl font-bold text-slate-900 mt-0.5">{stats.completed} runs</h3>
            </div>
          </div>

          <div className="premium-card p-5 flex items-center gap-4">
            <div className="p-3.5 rounded-xl bg-amber-50 text-amber-500">
              <AlertCircle size={20} />
            </div>
            <div>
              <p className="text-xs text-slate-400 font-semibold uppercase tracking-wider">Success Ratio</p>
              <h3 className="text-xl font-bold text-slate-900 mt-0.5">{stats.successRate}%</h3>
            </div>
          </div>

        </section>

        {/* Responsive Grid Layout for Uploader and Metrics */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Active Ingestor Column */}
          <div className="lg:col-span-2">
            <section className="premium-card p-6 h-full">
              <div className="pb-3 mb-4 border-b border-slate-100">
                <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <Activity className="text-blue-600" size={16} />
                  Active Ingestor Panel
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Select or drop files to initiate binary chunk slicing and queue processing
                </p>
              </div>
              <FileUploader
                onUploadComplete={handleUploadComplete}
                socketSubscribe={subscribe}
                onActiveSessionsChange={handleActiveSessionsChange}
                onFilesSelected={handleFilesSelected}
                onJobFinished={handleJobFinished}
                resumeRequest={resumeRequest}
                onResumeRequestProcessed={() => setResumeRequest(null)}
                onSessionInitiated={handleSessionInitiated}
              />
            </section>
          </div>

          {/* Current Ingestion Metrics Side Panel */}
          <div className="self-start w-full">
            <section className="premium-card p-6 flex flex-col justify-between h-[300px]">
              <div>
                <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2 pb-3 mb-4 border-b border-slate-100">
                  <Clock className="text-blue-600" size={16} />
                  Session Metrics
                </h2>

                <div className="space-y-4">
                  <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                    <span className="text-slate-500 font-medium">Selected Files</span>
                    <span className="font-semibold text-slate-950 font-mono">{sessionStats.totalSelected} files</span>
                  </div>

                  <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                    <span className="text-slate-500 font-medium">Success Uploads</span>
                    <span className="font-semibold text-emerald-600 font-mono">{sessionStats.successCount} files</span>
                  </div>

                  <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                    <span className="text-slate-500 font-medium">Failed Runs</span>
                    <span className="font-semibold text-rose-600 font-mono">{sessionStats.failCount} files</span>
                  </div>

                  <div className="flex justify-between items-center text-sm border-b border-slate-50 pb-2">
                    <span className="text-slate-500 font-medium">Avg Time Taken</span>
                    <span className="font-mono text-xs text-slate-700 bg-slate-100 px-2 py-0.5 rounded font-semibold">
                      {avgSessionTime > 0 ? `${(avgSessionTime / 1000).toFixed(2)}s` : "0.00s"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-slate-100 text-[10px] text-slate-400 font-mono uppercase tracking-wider">
                Tracks current tab session
              </div>
            </section>
          </div>

        </div>

        {/* Historical Pipeline Logs Section */}
        <section className="premium-card p-6">
          <Dashboard
            sessions={sessions}
            loading={loading}
            onDeleteSession={handleDeleteSession}
            onResumeSession={handleResumeSession}
            activeSessionIds={activeSessionIds}
          />
        </section>

        {/* Hidden input for resuming files */}
        <input
          type="file"
          ref={resumeFileInputRef}
          onChange={handleResumeFileChange}
          style={{ display: "none" }}
        />



      </div>

      {/* Toast Container */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full">
        {toasts.slice(-3).map((toast) => (
          <div
            key={toast.id}
            className={`relative overflow-hidden p-4 rounded-xl shadow-lg border text-sm font-semibold flex items-center justify-between gap-3 animate-slide-in-right transition-all bg-white ${toast.type === "success"
              ? "border-emerald-100 bg-emerald-50 text-emerald-800 animate-pulse-once"
              : toast.type === "error"
                ? "border-rose-100 bg-rose-50 text-rose-800"
                : "border-slate-200 bg-slate-50 text-slate-800"
              }`}
          >
            <span>{toast.message}</span>
            <button
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="text-slate-400 hover:text-slate-700 font-bold text-lg leading-none z-10"
            >
              &times;
            </button>
            <div
              className={`absolute bottom-0 left-0 h-1 animate-toast-progress ${toast.type === "success"
                ? "bg-emerald-500"
                : toast.type === "error"
                  ? "bg-rose-500"
                  : "bg-blue-500"
                }`}
            />
          </div>
        ))}
      </div>

      {/* Custom Confirmation Modal */}
      {confirmDialog && confirmDialog.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm transition-opacity">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl border border-slate-100 transform transition-all scale-100">
            <h3 className="text-lg font-bold text-slate-900">{confirmDialog.title}</h3>
            <p className="text-sm text-slate-500 mt-2 leading-relaxed">
              {confirmDialog.message}
            </p>
            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 border border-slate-200 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  confirmDialog.onConfirm();
                  setConfirmDialog(null);
                }}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-xl transition-all shadow-sm shadow-rose-100"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
