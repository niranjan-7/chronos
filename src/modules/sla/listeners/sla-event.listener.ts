import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TicketStatus } from '@prisma/client';
import {
  TICKET_CREATED_EVENT,
  TICKET_TRANSITIONED_EVENT,
} from '../../../common/events/domain-event.constants';
import {
  TicketCreatedEvent,
  TicketTransitionedEvent,
} from '../../../common/events/ticket.events';
import { PrismaService } from '../../../common/database/prisma.service';
import { SlaPolicyService } from '../services/sla-policy.service';
import { SlaQueueService } from '../services/sla-queue.service';

@Injectable()
export class SlaEventListener {
  private readonly logger = new Logger(SlaEventListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slaPolicyService: SlaPolicyService,
    private readonly slaQueueService: SlaQueueService,
  ) {}

  /**
   * Listens for ticket creation, resolves policy, and enqueues delayed SLA jobs in BullMQ.
   */
  @OnEvent(TICKET_CREATED_EVENT)
  async handleTicketCreated(event: TicketCreatedEvent): Promise<void> {
    const { tenantId, ticketId, priority, slaPolicyId } = event;

    // 1. Resolve matching SLA policy
    const policy = await this.slaPolicyService.resolvePolicyForTicket(
      tenantId,
      priority,
      slaPolicyId ?? undefined,
    );

    if (!policy) {
      this.logger.warn(`No active SLA policy found for ticket ${ticketId} [${priority}]`);
      return;
    }

    const durationMs = policy.resolutionTimeMinutes * 60 * 1000;
    const now = Date.now();
    const resolutionDueAt = new Date(now + durationMs);

    // 2. Schedule BullMQ delayed warning (80%) and breach (100%) jobs
    await this.slaQueueService.scheduleSlaJobs({
      tenantId,
      ticketId,
      policyVersion: policy.version,
      targetDurationMs: durationMs,
    });

    // 3. Persist deadline & remaining SLA state to database
    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        slaPolicyId: policy.id,
        policyVersion: policy.version,
        resolutionDueAt,
        remainingSlaMs: BigInt(durationMs),
      },
    });

    // 4. Record audit log
    await this.prisma.ticketAuditLog.create({
      data: {
        tenantId,
        ticketId,
        action: 'SLA_SCHEDULED',
        changes: {
          policyName: policy.name,
          resolutionTimeMinutes: policy.resolutionTimeMinutes,
          resolutionDueAt: resolutionDueAt.toISOString(),
          warningThresholdMs: Math.round(durationMs * 0.8),
        },
      },
    });

    this.logger.log(`Initialized SLA monitoring for ticket ${ticketId}: ${policy.name}`);
  }

  /**
   * Listens for status transitions and handles Pause (ON_HOLD), Resume (IN_PROGRESS), and Resolution.
   */
  @OnEvent(TICKET_TRANSITIONED_EVENT)
  async handleTicketTransitioned(event: TicketTransitionedEvent): Promise<void> {
    const { tenantId, ticketId, previousStatus, newStatus, actorId } = event;

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { slaPolicy: true },
    });

    if (!ticket) return;

    // 1. Pause SLA when ticket goes ON_HOLD
    if (newStatus === TicketStatus.ON_HOLD && previousStatus !== TicketStatus.ON_HOLD) {
      const now = Date.now();
      const dueTime = ticket.resolutionDueAt?.getTime() ?? now;
      const remainingSlaMs = Math.max(0, dueTime - now);

      // Cancel delayed jobs in Redis
      await this.slaQueueService.cancelSlaJobs(tenantId, ticketId);

      // Persist pausedAt and remaining duration
      await this.prisma.ticket.update({
        where: { id: ticketId },
        data: {
          pausedAt: new Date(now),
          remainingSlaMs: BigInt(remainingSlaMs),
        },
      });

      await this.prisma.ticketAuditLog.create({
        data: {
          tenantId,
          ticketId,
          actorId,
          action: 'SLA_PAUSED',
          changes: {
            remainingSlaMs,
            pausedAt: new Date(now).toISOString(),
          },
        },
      });

      this.logger.log(`SLA Paused for ticket ${ticketId}: ${remainingSlaMs}ms remaining`);
      return;
    }

    // 2. Resume SLA when transitioning back to IN_PROGRESS
    if (previousStatus === TicketStatus.ON_HOLD && newStatus === TicketStatus.IN_PROGRESS) {
      const remainingMs = ticket.remainingSlaMs ? Number(ticket.remainingSlaMs) : 0;
      const now = Date.now();
      const newResolutionDueAt = new Date(now + remainingMs);

      // Re-enqueue BullMQ delayed jobs with exact remaining duration
      if (remainingMs > 0 && !ticket.isBreached) {
        await this.slaQueueService.scheduleSlaJobs({
          tenantId,
          ticketId,
          policyVersion: ticket.policyVersion,
          targetDurationMs: ticket.slaPolicy?.resolutionTimeMinutes ? ticket.slaPolicy.resolutionTimeMinutes * 60 * 1000 : remainingMs,
          remainingMs,
          warningAlreadySent: ticket.isWarningSent,
        });
      }

      await this.prisma.ticket.update({
        where: { id: ticketId },
        data: {
          pausedAt: null,
          resolutionDueAt: newResolutionDueAt,
        },
      });

      await this.prisma.ticketAuditLog.create({
        data: {
          tenantId,
          ticketId,
          actorId,
          action: 'SLA_RESUMED',
          changes: {
            resumedAt: new Date(now).toISOString(),
            newResolutionDueAt: newResolutionDueAt.toISOString(),
            remainingSlaMs: remainingMs,
          },
        },
      });

      this.logger.log(`SLA Resumed for ticket ${ticketId}: New deadline ${newResolutionDueAt.toISOString()}`);
      return;
    }

    // 3. Clean up pending SLA jobs on Resolution or Closure
    if (newStatus === TicketStatus.RESOLVED || newStatus === TicketStatus.CLOSED) {
      await this.slaQueueService.cancelSlaJobs(tenantId, ticketId);

      await this.prisma.ticketAuditLog.create({
        data: {
          tenantId,
          ticketId,
          actorId,
          action: 'SLA_RESOLVED_CLEANUP',
          changes: {
            status: newStatus,
            resolvedAt: new Date().toISOString(),
          },
        },
      });

      this.logger.log(`SLA Cleared for completed ticket ${ticketId}`);
    }
  }
}
