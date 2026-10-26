import { TicketPriority, TicketStatus } from '@prisma/client';

export class TicketCreatedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly ticketId: string,
    public readonly ticketNumber: string,
    public readonly priority: TicketPriority,
    public readonly slaPolicyId: string | null,
    public readonly createdAt: Date,
  ) {}
}

export class TicketTransitionedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly ticketId: string,
    public readonly previousStatus: TicketStatus,
    public readonly newStatus: TicketStatus,
    public readonly actorId?: string,
    public readonly reason?: string,
    public readonly transitionedAt: Date = new Date(),
  ) {}
}

export class SlaWarningEvent {
  constructor(
    public readonly tenantId: string,
    public readonly ticketId: string,
    public readonly ticketNumber: string,
    public readonly targetDeadline: string,
    public readonly warningAt: Date = new Date(),
  ) {}
}

export class SlaBreachedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly ticketId: string,
    public readonly ticketNumber: string,
    public readonly originalPriority: TicketPriority,
    public readonly escalatedPriority: TicketPriority,
    public readonly breachedAt: Date = new Date(),
  ) {}
}

export class AgentCapacityFreedEvent {
  constructor(
    public readonly tenantId: string,
    public readonly agentId: string,
    public readonly freedAt: Date = new Date(),
  ) {}
}
