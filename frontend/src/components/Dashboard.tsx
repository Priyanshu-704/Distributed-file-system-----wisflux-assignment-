import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Clock, CheckCircle2, XCircle, Loader2, Database, Copy, Check, Download, Trash2, Play, X, HardDrive } from "lucide-react";
import { formatBytes, formatDuration, formatDate } from "../utils";
import type { UploadSession } from "../types";

interface DashboardProps {
  sessions: UploadSession[];
  loading: boolean;
  onDeleteSession: (sessionId: string) => void;
  onResumeSession: (session: UploadSession) => void;
  activeSessionIds: string[];
}

export const Dashboard: React.FC<DashboardProps> = ({
  sessions,
  loading,
  onDeleteSession,
  onResumeSession,
  activeSessionIds,
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  const [selectedSession, setSelectedSession] = useState<UploadSession | null>(null);

  useEffect(() => {
    if (selectedSession) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [selectedSession]);

  const totalPages = Math.ceil(sessions.length / itemsPerPage);
  const paginatedSessions = sessions.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const triggerCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const getStatusBadge = (status: string, sessionId: string) => {
    switch (status) {
      case "COMPLETED":
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
            <CheckCircle2 size={12} />
            Success
          </span>
        );
      case "FAILED":
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-100">
            <XCircle size={12} />
            Failed
          </span>
        );
      case "PROCESSING":
      case "UPLOADING":
        const isActive = activeSessionIds.includes(sessionId);
        if (status === "UPLOADING" && !isActive) {
          return (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
              <Clock size={12} />
              Paused / Interrupted
            </span>
          );
        }
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-100 animate-pulse">
            <Loader2 size={12} className="animate-spin" />
            {status === "PROCESSING" ? "Worker Node Active" : "Uploading Chunks"}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-50 text-slate-600 border border-slate-200">
            Queued
          </span>
        );
    }
  };

  return (
    <div className="space-y-4">
      
      {/* Header Log Ribbon */}
      <div className="flex items-center justify-between pb-3 border-b border-slate-100">
        <div>
          <h2 className="text-base font-bold text-slate-800 flex items-center gap-2">
            <Database className="text-blue-600" size={18} />
            Pipeline Historical Logs
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Audit processing outcomes, throughput, and merged paths
          </p>
        </div>
        {loading && <Loader2 className="animate-spin text-slate-400" size={16} />}
      </div>

      {sessions.length === 0 ? (
        <div className="premium-card p-12 text-center text-slate-400">
          <Clock size={36} className="mx-auto mb-3 opacity-40 text-slate-300" />
          <p className="text-sm font-medium text-slate-600">Audit trail currently empty</p>
          <p className="text-xs mt-1 text-slate-400">Upload assets using the controls above to trigger worker node sessions.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="overflow-x-auto w-full">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/75 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
                  <th className="px-6 py-4">File Name & Session ID</th>
                  <th className="px-6 py-4">Original Size</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Pipeline Latency</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {paginatedSessions.map((session) => {
                  const isActive = activeSessionIds.includes(session.id);
                  const isCompleted = session.processedFile?.status === "COMPLETED" || session.status === "COMPLETED";
                  const isFailed = session.processedFile?.status === "FAILED" || session.status === "FAILED";
                  const canDelete = isCompleted || isFailed || !isActive;
                  const outputName = session.processedFile?.processedName || "";
                  
                  return (
                    <tr 
                      key={session.id} 
                      onClick={() => setSelectedSession(session)}
                      className="hover:bg-slate-50/50 transition-colors cursor-pointer"
                    >
                      
                      {/* Name & Session ID info */}
                      <td className="px-6 py-4 max-w-xs md:max-w-sm">
                        <div className="font-semibold text-slate-800 truncate">
                          {session.fileName}
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5 truncate select-all">
                          Session: {session.id}
                        </div>
                      </td>
                      
                      {/* Size and Date metadata */}
                      <td className="px-6 py-4 whitespace-nowrap text-slate-600">
                        <div>{formatBytes(session.fileSize)}</div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                          {formatDate(session.createdAt)}
                        </div>
                      </td>
  
                      {/* Status Badge */}
                      <td className="px-6 py-4 whitespace-nowrap text-slate-600">
                        {getStatusBadge(session.processedFile?.status || session.status, session.id)}
                      </td>
  
                      {/* Latency / Execution stats */}
                      <td className="px-6 py-4 whitespace-nowrap text-slate-600">
                        {isCompleted && session.processedFile ? (
                          <span className="font-mono text-xs text-slate-700">
                            {formatDuration(session.processedFile.processingDuration)}
                          </span>
                        ) : isFailed ? (
                          <span className="text-xs text-rose-600 font-semibold" title={session.processedFile?.errorMessage || ""}>
                            Failure in queue
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400 italic">Pending execution</span>
                        )}
                      </td>
  
                      {/* Table Actions */}
                      <td className="px-6 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-2">
                          {isCompleted && (
                            <>
                              {/* Copy output path */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  triggerCopy(outputName, session.id);
                                }}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 bg-white hover:bg-slate-50 transition-colors"
                                title="Copy output filename"
                              >
                                {copiedId === session.id ? (
                                  <Check size={14} className="text-emerald-600" />
                                ) : (
                                  <Copy size={14} />
                                )}
                              </button>
                              {/* Download action (triggers generic prompt/action) */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  alert(`Merged asset location:\n${session.processedFile?.filePath}`);
                                }}
                                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-700 bg-white hover:bg-slate-50 transition-colors"
                                title="Inspect output file location"
                              >
                                <Download size={14} />
                              </button>
                            </>
                          )}
                          {isFailed && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                alert(`Error details:\n${session.processedFile?.errorMessage || "Unknown error"}`);
                              }}
                              className="px-2.5 py-1 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 text-xs font-semibold transition-colors"
                            >
                              Details
                            </button>
                          )}
                          {session.status === "UPLOADING" && !isActive && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onResumeSession(session);
                              }}
                              className="p-1.5 rounded-lg border border-amber-200 text-amber-600 hover:text-amber-700 bg-amber-50/50 hover:bg-amber-50 transition-colors"
                              title="Resume upload session"
                            >
                              <Play size={14} className="fill-amber-600" />
                            </button>
                          )}
                          {canDelete && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteSession(session.id);
                              }}
                              className="p-1.5 rounded-lg border border-slate-200 text-slate-400 hover:text-rose-600 bg-white hover:bg-rose-50 transition-colors"
                              title="Delete session & files"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                          {!canDelete && (
                            <span 
                              className="text-xs text-slate-400 italic px-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Locks active
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          
          {/* Pagination Controls */}
          {sessions.length > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-6 py-4 border-t border-slate-100 bg-slate-50/50 rounded-b-xl text-xs w-full">
              <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4 text-center sm:text-left w-full sm:w-auto">
                <span className="text-slate-500 font-medium">
                  Showing {Math.min(sessions.length, (currentPage - 1) * itemsPerPage + 1)}-{Math.min(sessions.length, currentPage * itemsPerPage)} of {sessions.length} sessions
                </span>
                <div className="flex items-center gap-1.5 text-slate-500 font-medium justify-center">
                  <span className="hidden sm:inline">•</span>
                  <span>Show</span>
                  <select
                    value={itemsPerPage}
                    onChange={(e) => {
                      setItemsPerPage(Number(e.target.value));
                      setCurrentPage(1);
                    }}
                    className="px-2 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500 text-xs font-semibold cursor-pointer shadow-sm"
                  >
                    {[5, 10, 20, 50, 100].map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                  <span>per page</span>
                </div>
              </div>
              <div className="flex gap-2 w-full sm:w-auto justify-center sm:justify-end">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:pointer-events-none transition-all text-xs font-semibold shadow-sm w-1/2 sm:w-auto text-center"
                >
                  Previous
                </button>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages || totalPages === 0}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:pointer-events-none transition-all text-xs font-semibold shadow-sm w-1/2 sm:w-auto text-center"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Session Details Modal Overlay rendered at document root */}
      {selectedSession && createPortal(
        <div 
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-900/50 backdrop-blur-md w-screen h-screen"
          onClick={() => setSelectedSession(null)}
        >
          <div 
            className="bg-white rounded-2xl p-6 max-w-lg w-full shadow-2xl border border-slate-100 transform transition-all scale-100 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-xl bg-blue-50 text-blue-600">
                  <Database size={18} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Session File Details</h3>
                  <p className="text-[10px] text-slate-400 font-mono mt-0.5 select-all">ID: {selectedSession.id}</p>
                </div>
              </div>
              <button 
                onClick={() => setSelectedSession(null)}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="mt-4 space-y-4 text-sm">
              <div className="flex justify-between items-start py-2 border-b border-slate-50">
                <span className="text-slate-400 font-semibold text-xs uppercase tracking-wider">File Name</span>
                <span className="font-semibold text-slate-800 text-right max-w-[280px] break-all">{selectedSession.fileName}</span>
              </div>

              <div className="flex justify-between items-center py-2 border-b border-slate-50">
                <span className="text-slate-400 font-semibold text-xs uppercase tracking-wider">Original Size</span>
                <span className="font-semibold text-slate-800 font-mono">{formatBytes(selectedSession.fileSize)}</span>
              </div>

              <div className="flex justify-between items-center py-2 border-b border-slate-50">
                <span className="text-slate-400 font-semibold text-xs uppercase tracking-wider">MIME Type</span>
                <span className="font-semibold text-slate-800 font-mono text-xs">{selectedSession.mimeType || "application/octet-stream"}</span>
              </div>

              <div className="flex justify-between items-center py-2 border-b border-slate-50">
                <span className="text-slate-400 font-semibold text-xs uppercase tracking-wider">Initiated At</span>
                <span className="font-semibold text-slate-800">{formatDate(selectedSession.createdAt)}</span>
              </div>

              <div className="flex justify-between items-center py-2 border-b border-slate-50">
                <span className="text-slate-400 font-semibold text-xs uppercase tracking-wider">Session Status</span>
                <span>{getStatusBadge(selectedSession.processedFile?.status || selectedSession.status, selectedSession.id)}</span>
              </div>

              {selectedSession.processedFile && selectedSession.processedFile.processingDuration > 0 && (
                <div className="flex justify-between items-center py-2 border-b border-slate-50">
                  <span className="text-slate-400 font-semibold text-xs uppercase tracking-wider">Processing Latency</span>
                  <span className="font-mono text-xs text-slate-700 bg-slate-100 px-2 py-0.5 rounded font-semibold">
                    {formatDuration(selectedSession.processedFile.processingDuration)}
                  </span>
                </div>
              )}

              {selectedSession.processedFile?.filePath && (
                <div className="flex flex-col gap-1 py-2 border-b border-slate-50">
                  <span className="text-slate-400 font-semibold text-xs uppercase tracking-wider">Storage Path</span>
                  <span className="font-mono text-[11px] text-slate-600 bg-slate-50 p-2 rounded border border-slate-100 select-all break-all leading-normal">
                    {selectedSession.processedFile.filePath}
                  </span>
                </div>
              )}

              {selectedSession.processedFile?.minioKey && (
                <div className="flex flex-col gap-1 py-2 border-b border-slate-50">
                  <span className="text-slate-400 font-semibold text-xs uppercase tracking-wider">MinIO Storage Object Key</span>
                  <span className="font-mono text-[11px] text-slate-600 bg-slate-50 p-2 rounded border border-slate-100 select-all break-all leading-normal">
                    {selectedSession.processedFile.minioKey}
                  </span>
                </div>
              )}

              {selectedSession.processedFile?.errorMessage && (
                <div className="flex flex-col gap-1 py-2 text-rose-800 bg-rose-50 p-3 rounded-xl border border-rose-100 mt-2">
                  <span className="font-bold text-xs uppercase tracking-wider text-rose-700">Failure Message</span>
                  <p className="text-xs leading-relaxed font-semibold">{selectedSession.processedFile.errorMessage}</p>
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setSelectedSession(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 border border-slate-200 rounded-xl transition-all shadow-sm"
              >
                Close Details
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
