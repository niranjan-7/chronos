import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { TicketPriority, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../../common/database/prisma.service';
import { AppClsStore } from '../../../common/context/app-cls.store';
import {
  SLA_JOB_BREACH,
  SLA_JOB_WARNING,
  SLA_MONITOR_QUEUE,
} from '../constants/sla.constants';
import { SlaJobPayload } from '../interfaces/sla-job-payload.interface';
import {
  SLA_BREACHED_EVENT,
  SLA_WARNING_EVENT,
} from '../../../common/events/domain-event.constants';
import {
  SlaBreachedEvent,
  SlaWarningEvent,
} from '../../../common/events/ticket.events';

@Processor(SLA_MONITOR_QUEUE)
export class SlaProcessor extends WorkerHost {
  private readonly logger = new Logger(SlaProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<AppClsStore>,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  /**
   * Processes delayed SLA jobs by re-hydrating the CLS tenantId context
   * before performing any database updates or escalation logic.
   */
  async process(job: Job<SlaJobPayload>): Promise<Record<string, unknown>> {
    const { tenantId, ticketId, stage } = job.data;

    this.logger.debug(
      `Worker received job '${job.id}' [${job.name}] for ticket ${ticketId} in tenant ${tenantId}`,
    );

    // Re-hydrate CLS context so all downstream operations run within the tenant boundary
    return this.cls.runWith(
      {
        tenantId,
        isSystemOperation: true,
        requestId: `bullmq-sla-${job.id}`,
      },
      async () => {
        if (job.name === SLA_JOB_WARNING || stage === 'WARNING') {
          return this.handleSlaWarning(job.data);
        }
        if (job.name === SLA_JOB_BREACH || stage === 'BREACH') {
          return this.handleSlaBreach(job.data);
        }
        return { unhandled: true };
      },
    );
  }

  private async handleSlaWarning(payload: SlaJobPayload) {
    const { tenantId, ticketId } = payload;

    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, tenantId },
    });

    if (!ticket) {
      this.logger.warn(`Ticket ${ticketId} not found in tenant ${tenantId}`);
      return { skipped: true, reason: 'TICKET_NOT_FOUND' };
    }

    // Ignore if ticket is resolved, closed, or paused
    if (
      ticket.status === TicketStatus.RESOLVED ||
      ticket.status === TicketStatus.CLOSED ||
      ticket.status === TicketStatus.ON_HOLD
    ) {
      this.logger.debug(`Skipping SLA Warning: Ticket ${ticketId} is in status ${ticket.status}`);
      return { skipped: true, reason: `STATUS_${ticket.status}` };
    }

    if (ticket.isWarningSent) {
      return { skipped: true, reason: 'ALREADY_WARNED' };
    }

    // Mark warning sent in database
    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { isWarningSent: true },
    });

    // Record audit log
    await this.prisma.ticketAuditLog.create({
      data: {
        tenantId,
        ticketId,
        action: 'SLA_WARNING_TRIGGERED',
        changes: {
          isWarningSent: true,
          resolutionDueAt: ticket.resolutionDueAt?.toISOString(),
        },
        metadata: {
          triggeredAt: new Date().toISOString(),
          threshold: '80%',
        },
      },
    });

    this.logger.warn(
      `[SLA WARNING] Ticket ${ticket.ticketNumber} (${ticketId}) has reached 80% of SLA resolution limit!`,
    );

    this.eventEmitter.emit(
      SLA_WARNING_EVENT,
      new SlaWarningEvent(
        tenantId,
        ticketId,
        ticket.ticketNumber,
        payload.targetDeadline,
      ),
    );

    return { processed: true, stage: 'WARNING', ticketId };
  }

  private async handleSlaBreach(payload: SlaJobPayload) {
    const { tenantId, ticketId } = payload;

    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, tenantId },
    });

    if (!ticket) {
      return { skipped: true, reason: 'TICKET_NOT_FOUND' };
    }

    // Ignore if ticket was already resolved, closed, or placed on hold
    if (
      ticket.status === TicketStatus.RESOLVED ||
      ticket.status === TicketStatus.CLOSED ||
      ticket.status === TicketStatus.ON_HOLD
    ) {
      return { skipped: true, reason: `STATUS_${ticket.status}` };
    }

    if (ticket.isBreached) {
      return { skipped: true, reason: 'ALREADY_BREACHED' };
    }

    // Automatic Escalation: Priority bump on breach
    const nextPriority = this.calculateEscalatedPriority(ticket.priority);

    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        isBreached: true,
        priority: nextPriority,
      },
    });

    // Write audit log
    await this.prisma.ticketAuditLog.create({
      data: {
        tenantId,
        ticketId,
        action: 'SLA_BREACH_TRIGGERED',
        changes: {
          isBreached: true,
          priority: { from: ticket.priority, to: nextPriority },
        },
        metadata: {
          breachedAt: new Date().toISOString(),
          threshold: '100%',
        },
      },
    });

    this.logger.error(
      `[SLA BREACH ESCALATION] Ticket ${ticket.ticketNumber} breached SLA! Priority escalated: ${ticket.priority} -> ${nextPriority}`,
    );

    this.eventEmitter.emit(
      SLA_BREACHED_EVENT,
      new SlaBreachedEvent(
        tenantId,
        ticketId,
        ticket.ticketNumber,
        ticket.priority,
        nextPriority,
      ),
    );

    return {
      processed: true,
      stage: 'BREACH',
      ticketId,
      escalatedPriority: nextPriority,
    };
  }

  private calculateEscalatedPriority(current: TicketPriority): TicketPriority {
    switch (current) {
      case TicketPriority.LOW:
        return TicketPriority.MEDIUM;
      case TicketPriority.MEDIUM:
        return TicketPriority.HIGH;
      case TicketPriority.HIGH:
        return TicketPriority.URGENT;
      case TicketPriority.URGENT:
        return TicketPriority.URGENT;
    }
  }
}
