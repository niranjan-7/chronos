import { TicketPriority, TicketStatus } from '@prisma/client';

export interface TicketCreatedOutboxPayload {
  tenantId: string;
  ticketId: string;
  priority: TicketPriority;
  status: TicketStatus;
  slaPolicyId?: string | null;
  createdAt: string;
}

export interface TicketStatusChangedOutboxPayload {
  tenantId: string;
  ticketId: string;
  previousStatus: TicketStatus;
  newStatus: TicketStatus;
  actorId?: string | null;
  reason?: string;
  transitionedAt: string;
}

export interface TicketClaimedOutboxPayload {
  tenantId: string;
  ticketId: string;
  agentId: string;
  priority?: TicketPriority;
  status: TicketStatus;
  claimedAt: string;
}

export interface OutboxRow {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: any;
  retry_count: number;
}
