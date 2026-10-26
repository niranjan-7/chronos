export type TicketStatus =
  | 'OPEN'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'ON_HOLD'
  | 'RESOLVED'
  | 'CLOSED';

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface LiveDashboardMetrics {
  tenantId: string;
  source: 'REDIS_PRE_AGGREGATED' | 'CACHE_REBUILD_FALLBACK';
  cachedAt: string;
  summary: {
    totalTickets: number;
    openCount: number;
    assignedCount: number;
    inProgressCount: number;
    onHoldCount: number;
    resolvedCount: number;
    closedCount: number;
    breachedCount: number;
    atRiskCount: number;
  };
  priorities: {
    urgent: number;
    high: number;
    medium: number;
    low: number;
  };
}

export interface SlaWarRoomAlert {
  ticketId: string;
  ticketNumber: string;
  priority: TicketPriority;
  status: TicketStatus;
  type: 'WARNING' | 'BREACH';
  warningAt?: string;
  breachedAt?: string;
  assignedAgentId?: string;
  timestamp: string;
}

export interface TicketAssignmentEvent {
  ticketId: string;
  ticketNumber: string;
  priority: TicketPriority;
  requiredSkills: string[];
  assignedAt: string;
}

export interface Ticket {
  id: string;
  tenantId: string;
  ticketNumber: string;
  title: string;
  description: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignedAgentId?: string | null;
  assignedAgent?: {
    id: string;
    name: string;
    email: string;
  } | null;
  requiredSkills: string[];
  isBreached: boolean;
  isWarningSent: boolean;
  targetResolutionAt?: string | null;
  remainingSlaMs?: number | null;
  createdAt: string;
  updatedAt: string;
}
