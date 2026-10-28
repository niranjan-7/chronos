import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { OutboxStatus, Prisma, Ticket, TicketAuditLog, TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../../common/database/prisma.service';
import { TenantAwareRepository } from '../../../common/database/tenant-aware.repository';
import { AppClsStore } from '../../../common/context/app-cls.store';
import { CLS_USER_ID } from '../../../common/constants/context.constants';
import { TicketStateMachine } from '../state-machine/ticket-state-machine';

interface LockedTicketRow {
  id: string;
  ticket_number: string;
  priority: TicketPriority;
  status: TicketStatus;
  assigned_agent_id: string | null;
}

export interface ClaimResult {
  claimed: boolean;
  message?: string;
  ticket?: Ticket;
}

@Injectable()
export class TicketsRepository extends TenantAwareRepository<
  Ticket,
  Prisma.TicketFindManyArgs,
  Prisma.TicketFindFirstArgs,
  Prisma.TicketCreateArgs,
  Prisma.TicketUpdateArgs,
  Prisma.TicketDeleteArgs
> {
  constructor(
    private readonly prisma: PrismaService,
    cls: ClsService<AppClsStore>,
    private readonly stateMachine: TicketStateMachine,
  ) {
    super(prisma.ticket, cls, 'Ticket');
  }

  /**
   * Atomically claims the next available OPEN ticket using PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`.
   * Guarantees non-blocking execution: concurrent transactions skip locked rows immediately.
   */
  async claimNextTicket(
    agentId: string,
    preferredPriority?: TicketPriority,
    requiredSkills?: string[],
  ): Promise<ClaimResult> {
    const tenantId = this.getTenantId();

    return this.prisma.$transaction(async (tx) => {
      // 1. Atomically query and lock candidate row with SKIP LOCKED
      const hasSkills = requiredSkills && requiredSkills.length > 0;

      const rows = preferredPriority
        ? hasSkills
          ? await tx.$queryRaw<LockedTicketRow[]>`
              SELECT id, ticket_number, priority, status, assigned_agent_id
              FROM tickets
              WHERE tenant_id = ${tenantId}::uuid
                AND status = 'OPEN'::"TicketStatus"
                AND assigned_agent_id IS NULL
                AND priority = ${preferredPriority}::"TicketPriority"
                AND (
                  required_skills = '{}'
                  OR cardinality(required_skills) = 0
                  OR required_skills <@ ${requiredSkills}::text[]
                )
              ORDER BY created_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED;
            `
          : await tx.$queryRaw<LockedTicketRow[]>`
              SELECT id, ticket_number, priority, status, assigned_agent_id
              FROM tickets
              WHERE tenant_id = ${tenantId}::uuid
                AND status = 'OPEN'::"TicketStatus"
                AND assigned_agent_id IS NULL
                AND priority = ${preferredPriority}::"TicketPriority"
              ORDER BY created_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED;
            `
        : hasSkills
        ? await tx.$queryRaw<LockedTicketRow[]>`
            SELECT id, ticket_number, priority, status, assigned_agent_id
            FROM tickets
            WHERE tenant_id = ${tenantId}::uuid
              AND status = 'OPEN'::"TicketStatus"
              AND assigned_agent_id IS NULL
              AND (
                required_skills = '{}'
                OR cardinality(required_skills) = 0
                OR required_skills <@ ${requiredSkills}::text[]
              )
            ORDER BY
              CASE priority
                WHEN 'URGENT' THEN 1
                WHEN 'HIGH' THEN 2
                WHEN 'MEDIUM' THEN 3
                WHEN 'LOW' THEN 4
                ELSE 5
              END ASC,
              created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED;
          `
        : await tx.$queryRaw<LockedTicketRow[]>`
            SELECT id, ticket_number, priority, status, assigned_agent_id
            FROM tickets
            WHERE tenant_id = ${tenantId}::uuid
              AND status = 'OPEN'::"TicketStatus"
              AND assigned_agent_id IS NULL
            ORDER BY
              CASE priority
                WHEN 'URGENT' THEN 1
                WHEN 'HIGH' THEN 2
                WHEN 'MEDIUM' THEN 3
                WHEN 'LOW' THEN 4
                ELSE 5
              END ASC,
              created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED;
          `;

      if (rows.length === 0) {
        return {
          claimed: false,
          message: 'No available unassigned tickets matching criteria in current tenant.',
        };
      }

      const candidate = rows[0];

      // 2. Validate transition through State Machine (OPEN -> ASSIGNED)
      this.stateMachine.validateTransition(
        candidate.status,
        TicketStatus.ASSIGNED,
        candidate.id,
        'Claimed by agent via claim-next',
      );

      // 3. Update ticket assignment within the transaction
      const updatedTicket = await tx.ticket.update({
        where: { id: candidate.id },
        data: {
          status: TicketStatus.ASSIGNED,
          assignedAgentId: agentId,
        },
        include: {
          assignedAgent: {
            select: { id: true, name: true, email: true, role: true },
          },
          slaPolicy: true,
        },
      });

      // 4. Create immutable audit log in the exact same transaction
      await tx.ticketAuditLog.create({
        data: {
          tenantId,
          ticketId: candidate.id,
          actorId: agentId,
          action: 'TICKET_CLAIMED_NEXT',
          changes: {
            status: { from: candidate.status, to: TicketStatus.ASSIGNED },
            assignedAgentId: { from: null, to: agentId },
          },
          metadata: {
            claimMechanism: 'SELECT_FOR_UPDATE_SKIP_LOCKED',
            priority: candidate.priority,
            ticketNumber: candidate.ticket_number,
            claimedAt: new Date().toISOString(),
          },
        },
      });

      // 5. Create OutboxEvent in the EXACT SAME transaction
      await tx.outboxEvent.create({
        data: {
          tenantId,
          aggregateType: 'TICKET',
          aggregateId: candidate.id,
          eventType: 'ticket.claimed',
          payload: {
            tenantId,
            ticketId: candidate.id,
            agentId,
            priority: candidate.priority,
            status: TicketStatus.ASSIGNED,
            claimedAt: new Date().toISOString(),
          },
          status: OutboxStatus.PENDING,
        },
      });

      return {
        claimed: true,
        ticket: updatedTicket,
      };
    });
  }

  /**
   * Atomically claims a specific ticket by ID using PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`.
   * Throws ConflictException if locked or already claimed, NotFoundException if non-existent.
   */
  async claimSpecificTicket(ticketId: string, agentId: string): Promise<Ticket> {
    const tenantId = this.getTenantId();

    return this.prisma.$transaction(async (tx) => {
      // 1. Attempt non-blocking row acquisition
      const rows = await tx.$queryRaw<LockedTicketRow[]>`
        SELECT id, ticket_number, priority, status, assigned_agent_id
        FROM tickets
        WHERE id = ${ticketId}::uuid
          AND tenant_id = ${tenantId}::uuid
        LIMIT 1
        FOR UPDATE SKIP LOCKED;
      `;

      if (rows.length === 0) {
        // Distinguish between ticket not found vs. ticket locked by concurrent worker
        const exists = await tx.ticket.findFirst({
          where: { id: ticketId, tenantId },
          select: { id: true, status: true, assignedAgentId: true },
        });

        if (!exists) {
          throw new NotFoundException(`Ticket with ID '${ticketId}' not found in current tenant.`);
        }

        throw new ConflictException(
          `Ticket '${ticketId}' cannot be claimed: It is currently locked by another operation or already claimed.`,
        );
      }

      const ticket = rows[0];

      if (ticket.status !== TicketStatus.OPEN || ticket.assigned_agent_id !== null) {
        throw new ConflictException(
          `Ticket '${ticketId}' cannot be claimed: current status is '${ticket.status}' and assigned to '${ticket.assigned_agent_id ?? 'none'}'.`,
        );
      }

      // 2. Validate transition
      this.stateMachine.validateTransition(
        ticket.status,
        TicketStatus.ASSIGNED,
        ticketId,
        'Claimed specifically by agent',
      );

      // 3. Update ticket status and agent assignment
      const updated = await tx.ticket.update({
        where: { id: ticketId },
        data: {
          status: TicketStatus.ASSIGNED,
          assignedAgentId: agentId,
        },
        include: {
          assignedAgent: {
            select: { id: true, name: true, email: true, role: true },
          },
          slaPolicy: true,
        },
      });

      // 4. Create immutable audit log in transaction
      await tx.ticketAuditLog.create({
        data: {
          tenantId,
          ticketId,
          actorId: agentId,
          action: 'TICKET_CLAIMED_SPECIFIC',
          changes: {
            status: { from: ticket.status, to: TicketStatus.ASSIGNED },
            assignedAgentId: { from: null, to: agentId },
          },
          metadata: {
            claimMechanism: 'SELECT_FOR_UPDATE_SKIP_LOCKED',
            claimedAt: new Date().toISOString(),
          },
        },
      });

      // 5. Create OutboxEvent in the EXACT SAME transaction
      await tx.outboxEvent.create({
        data: {
          tenantId,
          aggregateType: 'TICKET',
          aggregateId: ticketId,
          eventType: 'ticket.claimed',
          payload: {
            tenantId,
            ticketId,
            agentId,
            status: TicketStatus.ASSIGNED,
            claimedAt: new Date().toISOString(),
          },
          status: OutboxStatus.PENDING,
        },
      });

      return updated;
    });
  }

  /**
   * Executes a strict lifecycle state transition enforcing valid transitions and transaction audit log.
   */
  async transitionTicketStatus(params: {
    ticketId: string;
    targetStatus: TicketStatus;
    actorId?: string;
    reason?: string;
    assignedAgentId?: string;
  }): Promise<Ticket> {
    const tenantId = this.getTenantId();
    const actorId = params.actorId || this.cls.get(CLS_USER_ID);

    return this.prisma.$transaction(async (tx) => {
      // 1. Lock row with standard FOR UPDATE to serialize sequential state transitions
      const rows = await tx.$queryRaw<LockedTicketRow[]>`
        SELECT id, ticket_number, priority, status, assigned_agent_id
        FROM tickets
        WHERE id = ${params.ticketId}::uuid
          AND tenant_id = ${tenantId}::uuid
        LIMIT 1
        FOR UPDATE;
      `;

      if (rows.length === 0) {
        throw new NotFoundException(`Ticket with ID '${params.ticketId}' not found in current tenant.`);
      }

      const current = rows[0];

      // 2. Enforce state machine rules
      this.stateMachine.validateTransition(
        current.status,
        params.targetStatus,
        params.ticketId,
        params.reason,
      );

      // 3. Construct update payload
      const updateData: Prisma.TicketUpdateInput = {
        status: params.targetStatus,
        ...(params.assignedAgentId !== undefined
          ? params.assignedAgentId
            ? { assignedAgent: { connect: { id: params.assignedAgentId } } }
            : { assignedAgent: { disconnect: true } }
          : {}),
        ...(params.targetStatus === TicketStatus.RESOLVED || params.targetStatus === TicketStatus.CLOSED
          ? { resolvedAt: new Date() }
          : {}),
      };

      const updated = await tx.ticket.update({
        where: { id: params.ticketId },
        data: updateData,
        include: {
          assignedAgent: {
            select: { id: true, name: true, email: true, role: true },
          },
          slaPolicy: true,
        },
      });

      // 4. Record audit log in transaction
      await tx.ticketAuditLog.create({
        data: {
          tenantId,
          ticketId: params.ticketId,
          actorId,
          action: 'STATUS_TRANSITION',
          changes: {
            status: { from: current.status, to: params.targetStatus },
            ...(params.assignedAgentId !== undefined
              ? { assignedAgentId: { from: current.assigned_agent_id, to: params.assignedAgentId } }
              : {}),
            reason: params.reason,
          },
          metadata: {
            transitionedAt: new Date().toISOString(),
          },
        },
      });

      // 5. Create OutboxEvent in the EXACT SAME transaction
      await tx.outboxEvent.create({
        data: {
          tenantId,
          aggregateType: 'TICKET',
          aggregateId: params.ticketId,
          eventType: 'ticket.status_changed',
          payload: {
            tenantId,
            ticketId: params.ticketId,
            previousStatus: current.status,
            newStatus: params.targetStatus,
            actorId,
            reason: params.reason,
            transitionedAt: new Date().toISOString(),
          },
          status: OutboxStatus.PENDING,
        },
      });

      return updated;
    });
  }

  /**
   * Atomically creates a Ticket, initial TicketAuditLog, and PENDING OutboxEvent
   * within a single PostgreSQL database transaction.
   */
  async createTicketWithOutbox(params: {
    data: Omit<Prisma.TicketUncheckedCreateInput, 'tenantId'>;
    actorId?: string | null;
  }): Promise<Ticket> {
    const tenantId = this.getTenantId();

    return this.prisma.$transaction(async (tx) => {
      // 1. Create Ticket
      const ticket = await tx.ticket.create({
        data: {
          ...params.data,
          tenantId,
        },
        include: {
          assignedAgent: {
            select: { id: true, name: true, email: true, role: true },
          },
          slaPolicy: true,
        },
      });

      // 2. Create Audit Log
      await tx.ticketAuditLog.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          actorId: params.actorId ?? ticket.assignedAgentId ?? null,
          action: 'TICKET_CREATED',
          changes: {
            status: ticket.status,
            priority: ticket.priority,
            ticketNumber: ticket.ticketNumber,
            assignedAgentId: ticket.assignedAgentId,
          },
        },
      });

      // 3. Create OutboxEvent in the EXACT SAME transaction
      await tx.outboxEvent.create({
        data: {
          tenantId,
          aggregateType: 'TICKET',
          aggregateId: ticket.id,
          eventType: 'ticket.created',
          payload: {
            tenantId,
            ticketId: ticket.id,
            ticketNumber: ticket.ticketNumber,
            priority: ticket.priority,
            status: ticket.status,
            slaPolicyId: ticket.slaPolicyId,
            createdAt: ticket.createdAt.toISOString(),
          },
          status: OutboxStatus.PENDING,
        },
      });

      return ticket;
    });
  }

  async findTickets(params: {
    status?: TicketStatus;
    priority?: TicketPriority;
    assignedAgentId?: string;
    skip?: number;
    take?: number;
  }): Promise<{ items: Ticket[]; total: number }> {
    const tenantId = this.getTenantId();

    const where: Prisma.TicketWhereInput = {
      tenantId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.priority ? { priority: params.priority } : {}),
      ...(params.assignedAgentId ? { assignedAgentId: params.assignedAgentId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        skip: params.skip,
        take: params.take ?? 50,
        orderBy: { createdAt: 'desc' },
        include: {
          assignedAgent: {
            select: { id: true, name: true, email: true, role: true },
          },
          slaPolicy: true,
        },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { items, total };
  }

  async findByTicketNumber(ticketNumber: string): Promise<Ticket | null> {
    const tenantId = this.getTenantId();
    return this.prisma.ticket.findFirst({
      where: {
        ticketNumber,
        tenantId,
      },
      include: {
        assignedAgent: true,
        slaPolicy: true,
        ticketAuditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });
  }

  async createAuditLog(params: {
    ticketId: string;
    action: string;
    changes?: Record<string, unknown>;
    actorId?: string;
  }): Promise<TicketAuditLog> {
    const tenantId = this.getTenantId();
    const actorId = params.actorId || this.cls.get(CLS_USER_ID);

    return this.prisma.ticketAuditLog.create({
      data: {
        tenantId,
        ticketId: params.ticketId,
        action: params.action,
        changes: (params.changes as Prisma.InputJsonValue) ?? {},
        actorId,
      },
    });
  }

  async getAuditLogs(ticketId: string): Promise<TicketAuditLog[]> {
    const tenantId = this.getTenantId();
    return this.prisma.ticketAuditLog.findMany({
      where: {
        ticketId,
        tenantId,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        actor: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });
  }
}
