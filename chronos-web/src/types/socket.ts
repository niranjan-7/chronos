export type SocketConnectionStatus = 'LIVE' | 'RECONNECTING' | 'OFFLINE';

export interface MetricsUpdatedPayload {
  event: 'metrics.updated';
  tenantId: string;
  delta: {
    openCount?: number;
    atRiskCount?: number;
    breachedCount?: number;
    activeAgents?: number;
    totalTickets?: number;
  };
  timestamp: string;
}

export interface SocketAuthenticatedAck {
  status: 'CONNECTED';
  tenantId: string;
  userId: string;
  role: string;
  rooms: string[];
  timestamp: string;
}
