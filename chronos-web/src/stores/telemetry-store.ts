import { create } from 'zustand';
import { SocketConnectionStatus } from '../types/socket';
import { SlaWarRoomAlert, TicketAssignmentEvent } from '../types/telemetry';

export interface TelemetryState {
  connectionStatus: SocketConnectionStatus;
  latencyMs: number;
  lastPingTimestamp: number;
  recentAlerts: SlaWarRoomAlert[];
  recentAssignments: TicketAssignmentEvent[];
  unreadAlertCount: number;

  setConnectionStatus: (status: SocketConnectionStatus) => void;
  setLatencyMs: (ms: number) => void;
  addAlert: (alert: SlaWarRoomAlert) => void;
  addAssignment: (assignment: TicketAssignmentEvent) => void;
  clearUnreadAlerts: () => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  connectionStatus: 'OFFLINE',
  latencyMs: 0,
  lastPingTimestamp: Date.now(),
  recentAlerts: [],
  recentAssignments: [],
  unreadAlertCount: 0,

  setConnectionStatus: (status: SocketConnectionStatus) =>
    set({ connectionStatus: status }),

  setLatencyMs: (ms: number) =>
    set({ latencyMs: ms, lastPingTimestamp: Date.now() }),

  addAlert: (alert: SlaWarRoomAlert) =>
    set((state) => ({
      recentAlerts: [alert, ...state.recentAlerts].slice(0, 50),
      unreadAlertCount: state.unreadAlertCount + 1,
    })),

  addAssignment: (assignment: TicketAssignmentEvent) =>
    set((state) => ({
      recentAssignments: [assignment, ...state.recentAssignments].slice(0, 50),
    })),

  clearUnreadAlerts: () => set({ unreadAlertCount: 0 }),
}));
