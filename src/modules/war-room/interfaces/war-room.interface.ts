export interface WarRoomAuthData {
  tenantId: string;
  userId: string;
  role: string;
  tokenPayload?: Record<string, unknown>;
}

export interface WarRoomMetricsDelta {
  openCount?: number;
  atRiskCount?: number;
  breachedCount?: number;
  activeAgents?: number;
  totalTickets?: number;
  assignedCount?: number;
  inProgressCount?: number;
  onHoldCount?: number;
  resolvedCount?: number;
}

export interface SlaWarRoomAlert {
  ticketId: string;
  ticketNumber?: string;
  priority: string;
  status: string;
  type: 'WARNING' | 'BREACH';
  breachedAt?: string;
  warningAt?: string;
  assignedAgentId?: string | null;
}

export interface AgentAssignmentPayload {
  ticketId: string;
  ticketNumber: string;
  priority: string;
  requiredSkills?: string[];
  assignedAt: string;
}
