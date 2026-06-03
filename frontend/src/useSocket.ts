import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type { JobUpdate } from './types';

const SOCKET_URL = 'http://localhost:5000';

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Map<string, (data: JobUpdate) => void>>(new Map());

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    socket.on('job-update', (data: JobUpdate) => {
      // Broadcast to all registered listeners
      listenersRef.current.forEach((handler) => {
        handler(data);
      });
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const subscribe = useCallback((key: string, handler: (data: JobUpdate) => void) => {
    listenersRef.current.set(key, handler);
    return () => {
      listenersRef.current.delete(key);
    };
  }, []);

  return { connected, subscribe };
}
