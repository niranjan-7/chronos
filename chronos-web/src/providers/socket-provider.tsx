'use client';

import React, { createContext, useContext, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useTenantStore } from '../stores/tenant-store';
import { useTelemetryStore } from '../stores/telemetry-store';
import {
  MetricsUpdatedPayload,
  SocketConnectionStatus,
} from '../types/socket';
import { LiveDashboardMetrics, SlaWarRoomAlert, TicketAssignmentEvent } from '../types/telemetry';

interface WarRoomSocketContextValue {
  socket: Socket | null;
  connectionStatus: SocketConnectionStatus;
  latencyMs: number;
}

const WarRoomSocketContext = createContext<WarRoomSocketContextValue>({
  socket: null,
  connectionStatus: 'OFFLINE',
  latencyMs: 0,
});

export function WarRoomSocketProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const activeTenant = useTenantStore((s) => s.activeTenant);
  const activePersona = useTenantStore((s) => s.activePersona);
  const token = useTenantStore((s) => s.token);

  const {
    connectionStatus,
    latencyMs,
    setConnectionStatus,
    setLatencyMs,
    addAlert,
    addAssignment,
  } = useTelemetryStore();

  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token) return;

    const socketUrl =
      process.env.NEXT_PUBLIC_SOCKET_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      'http://localhost:3000';

    setConnectionStatus('RECONNECTING');

    const connectStartTime = Date.now();
    const socket = io(`${socketUrl}/war-room`, {
      transports: ['websocket'],
      auth: { token },
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 5000,
      forceNew: true,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      const latency = Date.now() - connectStartTime;
      setLatencyMs(Math.max(4, latency));
      setConnectionStatus('LIVE');
    });

    socket.on('authenticated', () => {
      setConnectionStatus('LIVE');
    });

    socket.on('connect_error', () => {
      setConnectionStatus('RECONNECTING');
    });

    socket.on('disconnect', () => {
      setConnectionStatus('OFFLINE');
    });

    // 1. Live Metrics Telemetry (250ms debounced updates from backend)
    socket.on('metrics.updated', (payload: MetricsUpdatedPayload) => {
      queryClient.setQueryData<LiveDashboardMetrics>(
        ['liveDashboardMetrics', payload.tenantId],
        (old) => {
          if (!old) return old;
          const { delta } = payload;
          return {
            ...old,
            cachedAt: payload.timestamp,
            summary: {
              ...old.summary,
              openCount: Math.max(0, (old.summary.openCount || 0) + (delta.openCount || 0)),
              atRiskCount: Math.max(0, (old.summary.atRiskCount || 0) + (delta.atRiskCount || 0)),
              breachedCount: Math.max(0, (old.summary.breachedCount || 0) + (delta.breachedCount || 0)),
              totalTickets: Math.max(0, (old.summary.totalTickets || 0) + (delta.totalTickets || 0)),
            },
          };
        },
      );
    });

    // 2. SLA Warning Alert (80% resolution limit)
    socket.on('sla.warning', (alert: SlaWarRoomAlert) => {
      addAlert(alert);
      queryClient.setQueryData<LiveDashboardMetrics>(
        ['liveDashboardMetrics', alert.ticketId ? activeTenant.id : activeTenant.id],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            summary: {
              ...old.summary,
              atRiskCount: (old.summary.atRiskCount || 0) + 1,
            },
          };
        },
      );
      queryClient.invalidateQueries({ queryKey: ['tickets', activeTenant.id] });
    });

    // 3. SLA Breach Alert (100% resolution limit + escalation)
    socket.on('sla.breach', (alert: SlaWarRoomAlert) => {
      addAlert(alert);
      queryClient.setQueryData<LiveDashboardMetrics>(
        ['liveDashboardMetrics', activeTenant.id],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            summary: {
              ...old.summary,
              breachedCount: (old.summary.breachedCount || 0) + 1,
              atRiskCount: Math.max(0, (old.summary.atRiskCount || 0) - 1),
            },
          };
        },
      );
      queryClient.invalidateQueries({ queryKey: ['tickets', activeTenant.id] });
    });

    // 4. Ticket Claimed / Personal Push-Routed Assignment
    socket.on('ticket.assigned', (assignment: TicketAssignmentEvent) => {
      addAssignment(assignment);
      queryClient.invalidateQueries({ queryKey: ['tickets', activeTenant.id] });
      queryClient.invalidateQueries({ queryKey: ['liveDashboardMetrics', activeTenant.id] });
    });

    socket.on('ticket.claimed', (assignment: TicketAssignmentEvent) => {
      addAssignment(assignment);
      queryClient.invalidateQueries({ queryKey: ['tickets', activeTenant.id] });
      queryClient.invalidateQueries({ queryKey: ['liveDashboardMetrics', activeTenant.id] });
    });

    // Periodic ping to refresh latency pill measurement
    const pingInterval = setInterval(() => {
      if (socket.connected) {
        const start = Date.now();
        // Measure socket roundtrip
        socket.emit('ping', () => {
          setLatencyMs(Math.max(2, Date.now() - start));
        });
      }
    }, 10000);

    return () => {
      clearInterval(pingInterval);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [
    token,
    activeTenant.id,
    activePersona.id,
    queryClient,
    setConnectionStatus,
    setLatencyMs,
    addAlert,
    addAssignment,
  ]);

  return (
    <WarRoomSocketContext.Provider
      value={{
        socket: socketRef.current,
        connectionStatus,
        latencyMs,
      }}
    >
      {children}
    </WarRoomSocketContext.Provider>
  );
}

export function useWarRoomSocket(): WarRoomSocketContextValue {
  return useContext(WarRoomSocketContext);
}
