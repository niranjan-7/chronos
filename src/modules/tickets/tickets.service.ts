import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, Ticket, TicketPriority, TicketStatus } from '@prisma/client';
import { ClaimResult, TicketsRepository } from './repositories/tickets.repository';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { ClaimNextTicketDto, ClaimSpecificTicketDto } from './dto/claim-ticket.dto';
import { TransitionTicketDto } from './dto/transition-ticket.dto';
import { PrismaService } from '../../common/database/prisma.service';
import {
  TICKET_CREATED_EVENT,
  TICKET_TRANSITIONED_EVENT,
} from '../../common/events/domain-event.constants';
import {
  TicketCreatedEvent,
  TicketTransitionedEvent,
} from '../../common/events/ticket.events';

@Injectable()
export class TicketsService {
  constructor(
    private readonly ticketsRepository: TicketsRepository,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createTicket(dto: CreateTicketDto): Promise<Ticket> {
    const tenantId = this.ticketsRepository.getTenantId();

    // 1. Resolve SLA due dates if SLA policy is provided
    let firstResponseDueAt: Date | null = null;
    let resolutionDueAt: Date | null = null;

    if (dto.slaPolicyId) {
      const slaPolicy = await this.prisma.slaPolicy.findFirst({
        where: { id: dto.slaPolicyId, tenantId, isActive: true },
      });
      if (!slaPolicy) {
        throw new BadRequestException(`SLA policy '${dto.slaPolicyId}' not found for tenant.`);
      }
      const now = new Date();
      firstResponseDueAt = new Date(now.getTime() + slaPolicy.responseTimeMinutes * 60 * 1000);
      resolutionDueAt = new Date(now.getTime() + slaPolicy.resolutionTimeMinutes * 60 * 1000);
    }

    // 2. Generate unique ticket number
    const count = await this.ticketsRepository.count();
    const ticketNumber = `TCK-${(count + 1).toString().padStart(6, '0')}`;

    // 3. Create ticket via tenant-aware repository
    const initialStatus = dto.status ?? (dto.assignedAgentId ? TicketStatus.ASSIGNED : TicketStatus.OPEN);

    const ticket = await this.ticketsRepository.create<Prisma.TicketUncheckedCreateInput>({
      data: {
        ticketNumber,
        title: dto.title,
        description: dto.description,
        status: initialStatus,
        priority: dto.priority ?? TicketPriority.MEDIUM,
        assignedAgentId: dto.assignedAgentId ?? null,
        slaPolicyId: dto.slaPolicyId ?? null,
        metadata: (dto.metadata as Prisma.InputJsonValue) ?? {},
        firstResponseDueAt,
        resolutionDueAt,
        lastResumedAt: new Date(),
      },
    });

    // 4. Record audit log
    await this.ticketsRepository.createAuditLog({
      ticketId: ticket.id,
      action: 'TICKET_CREATED',
      changes: {
        status: ticket.status,
        priority: ticket.priority,
        ticketNumber: ticket.ticketNumber,
        assignedAgentId: ticket.assignedAgentId,
      },
    });

    // 5. Emit domain event for event-driven SLA scheduling
    this.eventEmitter.emit(
      TICKET_CREATED_EVENT,
      new TicketCreatedEvent(
        ticket.tenantId,
        ticket.id,
        ticket.ticketNumber,
        ticket.priority,
        ticket.slaPolicyId,
        ticket.createdAt,
      ),
    );

    return ticket;
  }

  /**
   * Atomic, non-blocking claim of the next available OPEN ticket using SELECT ... FOR UPDATE SKIP LOCKED.
   */
  async claimNextTicket(
    dto: ClaimNextTicketDto,
    authenticatedUserId?: string,
  ): Promise<ClaimResult> {
    const agentId = dto.agentId || authenticatedUserId;
    if (!agentId) {
      throw new BadRequestException(
        'An agentId must be provided in the request body or via authenticated user context.',
      );
    }

    const result = await this.ticketsRepository.claimNextTicket(agentId, dto.preferredPriority);

    if (result.claimed && result.ticket) {
      this.eventEmitter.emit(
        TICKET_TRANSITIONED_EVENT,
        new TicketTransitionedEvent(
          result.ticket.tenantId,
          result.ticket.id,
          TicketStatus.OPEN,
          TicketStatus.ASSIGNED,
          agentId,
          'Claimed next available ticket',
        ),
      );
    }

    return result;
  }

  /**
   * Atomic, non-blocking claim of a specific ticket using SELECT ... FOR UPDATE SKIP LOCKED.
   */
  async claimSpecificTicket(
    ticketId: string,
    dto: ClaimSpecificTicketDto,
    authenticatedUserId?: string,
  ): Promise<Ticket> {
    const agentId = dto.agentId || authenticatedUserId;
    if (!agentId) {
      throw new BadRequestException(
        'An agentId must be provided in the request body or via authenticated user context.',
      );
    }

    const ticket = await this.ticketsRepository.claimSpecificTicket(ticketId, agentId);

    this.eventEmitter.emit(
      TICKET_TRANSITIONED_EVENT,
      new TicketTransitionedEvent(
        ticket.tenantId,
        ticket.id,
        TicketStatus.OPEN,
        TicketStatus.ASSIGNED,
        agentId,
        'Claimed specific ticket',
      ),
    );

    return ticket;
  }

  /**
   * Transitions ticket status enforcing valid state machine DAG, transactional audit log,
   * and emitting domain events for SLA Pause/Resume/Completion.
   */
  async transitionTicket(
    ticketId: string,
    dto: TransitionTicketDto,
    authenticatedUserId?: string,
  ): Promise<Ticket> {
    const existing = await this.getTicketById(ticketId);
    const previousStatus = existing.status;

    const updated = await this.ticketsRepository.transitionTicketStatus({
      ticketId,
      targetStatus: dto.status,
      actorId: authenticatedUserId,
      reason: dto.reason,
      assignedAgentId: dto.assignedAgentId,
    });

    this.eventEmitter.emit(
      TICKET_TRANSITIONED_EVENT,
      new TicketTransitionedEvent(
        updated.tenantId,
        updated.id,
        previousStatus,
        dto.status,
        authenticatedUserId,
        dto.reason,
      ),
    );

    return updated;
  }

  async getTickets(params: {
    status?: TicketStatus;
    priority?: TicketPriority;
    assignedAgentId?: string;
    skip?: number;
    take?: number;
  }) {
    return this.ticketsRepository.findTickets(params);
  }

  async getTicketById(id: string): Promise<Ticket> {
    const ticket = await this.ticketsRepository.findById(id, {
      assignedAgent: true,
      slaPolicy: true,
      ticketAuditLogs: {
        orderBy: { createdAt: 'desc' },
      },
    });
    if (!ticket) {
      throw new NotFoundException(`Ticket with ID '${id}' not found in current tenant.`);
    }
    return ticket;
  }

  async updateTicket(id: string, dto: UpdateTicketDto): Promise<Ticket> {
    const existing = await this.getTicketById(id);

    if (dto.status !== undefined && dto.status !== existing.status) {
      return this.transitionTicket(id, {
        status: dto.status,
        reason: 'Updated via general update endpoint',
      });
    }

    const updateData: Record<string, unknown> = {};
    const changes: Record<string, unknown> = {};

    if (dto.title !== undefined) {
      updateData.title = dto.title;
      changes.title = { from: existing.title, to: dto.title };
    }
    if (dto.description !== undefined) {
      updateData.description = dto.description;
    }
    if (dto.priority !== undefined && dto.priority !== existing.priority) {
      updateData.priority = dto.priority;
      changes.priority = { from: existing.priority, to: dto.priority };
    }
    if (dto.assignedAgentId !== undefined && dto.assignedAgentId !== existing.assignedAgentId) {
      updateData.assignedAgentId = dto.assignedAgentId;
      changes.assignedAgentId = { from: existing.assignedAgentId, to: dto.assignedAgentId };
    }
    if (dto.metadata !== undefined) {
      updateData.metadata = dto.metadata as Prisma.InputJsonValue;
    }

    const updated = await this.ticketsRepository.updateById(id, updateData);

    if (Object.keys(changes).length > 0) {
      await this.ticketsRepository.createAuditLog({
        ticketId: id,
        action: 'TICKET_UPDATED',
        changes,
      });
    }

    return updated;
  }

  async getAuditLogs(ticketId: string) {
    await this.getTicketById(ticketId);
    return this.ticketsRepository.getAuditLogs(ticketId);
  }
}
