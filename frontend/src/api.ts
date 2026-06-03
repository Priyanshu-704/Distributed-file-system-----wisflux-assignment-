const API_BASE = 'http://localhost:5000/api';

export const api = {
  upload: {
    initiate: async (data: { fileName: string; fileSize: number; mimeType: string; totalChunks: number }) => {
      const res = await fetch(`${API_BASE}/upload/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to initiate upload');
      }
      return res.json();
    },

    uploadChunk: async (sessionId: string, chunkIndex: number, hash: string, chunk: Blob) => {
      const formData = new FormData();
      formData.append('chunk', chunk, `chunk_${chunkIndex}`);
      const res = await fetch(
        `${API_BASE}/upload/${sessionId}/chunk?chunkIndex=${chunkIndex}&hash=${hash}`,
        { method: 'POST', body: formData }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || `Failed to upload chunk ${chunkIndex}`);
      }
      return res.json();
    },

    merge: async (sessionId: string) => {
      const res = await fetch(`${API_BASE}/upload/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to merge chunks');
      }
      return res.json();
    },

    getSession: async (sessionId: string) => {
      const res = await fetch(`${API_BASE}/upload/${sessionId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to fetch session');
      }
      return res.json();
    },

    getAllSessions: async () => {
      const res = await fetch(`${API_BASE}/upload`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to fetch sessions');
      }
      return res.json();
    },

    delete: async (sessionId: string) => {
      const res = await fetch(`${API_BASE}/upload/${sessionId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to delete session');
      }
      return res.json();
    },
  },

  health: async () => {
    const res = await fetch('http://localhost:5000/health');
    if (!res.ok) throw new Error('Backend unhealthy');
    return res.json();
  },
};
