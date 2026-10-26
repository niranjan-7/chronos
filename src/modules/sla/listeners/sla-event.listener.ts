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
import { SlaCalendarCalculatorService } from '../services/sla-calendar-calculator.service';
import { TenantCalendarService } from '../../tenants/services/tenant-calendar.service';

@Injectable()
export class SlaEventListener {
  private readonly logger = new Logger(SlaEventListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slaPolicyService: SlaPolicyService,
    private readonly slaQueueService: SlaQueueService,
    private readonly calendarCalculator: SlaCalendarCalculatorService,
    private readonly tenantCalendarService: TenantCalendarService,
  ) {}

  /**
   * Listens for ticket creation, resolves policy & tenant business calendar,
   * calculates timezone-aware business deadlines, and enqueues delayed jobs in BullMQ.
   */
  @OnEvent(TICKET_CREATED_EVENT)
  async handleTicketCreated(event: TicketCreatedEvent): Promise<void> {
    const { tenantId, ticketId, priority, slaPolicyId, createdAt } = event;

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

    // 2. Fetch tenant business calendar and holiday schedule
    const { calendar, holidays } = await this.tenantCalendarService.getTenantCalendarContext(tenantId);

    // 3. Compute business-hours-aware warning and breach deadlines
    const deadlines = this.calendarCalculator.calculateDeadlines(
      createdAt,
      durationMs,
      calendar,
      holidays,
    );

    // 4. Enqueue BullMQ delayed jobs with calculated wall-clock delays
    await this.slaQueueService.scheduleJobsWithDelays({
      tenantId,
      ticketId,
      policyVersion: policy.version,
      warningDelayMs: deadlines.warningDelayMs,
      breachDelayMs: deadlines.breachDelayMs,
      breachDateISO: deadlines.breachDate.toISOString(),
    });

    // 5. Persist SLA state and initial lastResumedAt to database
    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        slaPolicyId: policy.id,
        policyVersion: policy.version,
        resolutionDueAt: deadlines.breachDate,
        remainingSlaMs: BigInt(durationMs),
        lastResumedAt: createdAt,
        slaPausedAt: null,
      },
    });

    // 6. Record audit log with calendar context
    await this.prisma.ticketAuditLog.create({
      data: {
        tenantId,
        ticketId,
        action: 'SLA_SCHEDULED',
        changes: {
          policyName: policy.name,
          resolutionTimeMinutes: policy.resolutionTimeMinutes,
          timezone: calendar.timezone,
          warningDeadline: deadlines.warningDate.toISOString(),
          breachDeadline: deadlines.breachDate.toISOString(),
          warningDelayMs: deadlines.warningDelayMs,
          breachDelayMs: deadlines.breachDelayMs,
        },
      },
    });

    this.logger.log(
      `Scheduled timezone-aware SLA for ticket ${ticketId}: Breach at ${deadlines.breachDate.toISOString()} (${calendar.timezone})`,
    );
  }

  /**
   * Listens for status transitions and dynamically freezes/unfreezes SLA based on elapsed business hours.
   */
  @OnEvent(TICKET_TRANSITIONED_EVENT)
  async handleTicketTransitioned(event: TicketTransitionedEvent): Promise<void> {
    const { tenantId, ticketId, previousStatus, newStatus, actorId } = event;

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { slaPolicy: true },
    });

    if (!ticket) return;

    // 1. Freeze SLA when ticket moves to ON_HOLD
    if (newStatus === TicketStatus.ON_HOLD && previousStatus !== TicketStatus.ON_HOLD) {
      const now = new Date();
      const activeSince = ticket.lastResumedAt || ticket.createdAt || now;

      // Resolve calendar and calculate exact elapsed business ms
      const { calendar, holidays } = await this.tenantCalendarService.getTenantCalendarContext(tenantId);
      const elapsedBusinessMs = this.calendarCalculator.calculateElapsedBusinessMs(
        activeSince,
        now,
        calendar,
        holidays,
      );

      const currentRemaining = ticket.remainingSlaMs ? Number(ticket.remainingSlaMs) : 0;
      const newRemainingSlaMs = Math.max(0, currentRemaining - elapsedBusinessMs);

      // Cancel pending BullMQ delayed jobs from Redis
      await this.slaQueueService.cancelSlaJobs(tenantId, ticketId);

      // Persist exact remaining business milliseconds and pause timestamps
      await this.prisma.ticket.update({
        where: { id: ticketId },
        data: {
          slaPausedAt: now,
          pausedAt: now,
          remainingSlaMs: BigInt(newRemainingSlaMs),
        },
      });

      await this.prisma.ticketAuditLog.create({
        data: {
          tenantId,
          ticketId,
          actorId,
          action: 'SLA_PAUSED',
          changes: {
            elapsedBusinessMs,
            previousRemainingMs: currentRemaining,
            newRemainingSlaMs,
            slaPausedAt: now.toISOString(),
          },
        },
      });

      this.logger.log(
        `SLA Paused for ticket ${ticketId}: ${elapsedBusinessMs}ms business elapsed, ${newRemainingSlaMs}ms remaining`,
      );
      return;
    }

    // 2. Unfreeze SLA when transitioning from ON_HOLD back to IN_PROGRESS
    if (previousStatus === TicketStatus.ON_HOLD && newStatus === TicketStatus.IN_PROGRESS) {
      const now = new Date();
      const remainingMs = ticket.remainingSlaMs ? Number(ticket.remainingSlaMs) : 0;

      const { calendar, holidays } = await this.tenantCalendarService.getTenantCalendarContext(tenantId);

      // Compute fresh wall-clock deadlines counting only future business hours
      let newBreachDate = now;
      if (remainingMs > 0 && !ticket.isBreached) {
        const deadlines = this.calendarCalculator.calculateDeadlines(
          now,
          remainingMs,
          calendar,
          holidays,
        );

        newBreachDate = deadlines.breachDate;

        await this.slaQueueService.scheduleJobsWithDelays({
          tenantId,
          ticketId,
          policyVersion: ticket.policyVersion,
          warningDelayMs: deadlines.warningDelayMs,
          breachDelayMs: deadlines.breachDelayMs,
          breachDateISO: deadlines.breachDate.toISOString(),
          warningAlreadySent: ticket.isWarningSent,
        });
      }

      await this.prisma.ticket.update({
        where: { id: ticketId },
        data: {
          slaPausedAt: null,
          pausedAt: null,
          lastResumedAt: now,
          resolutionDueAt: newBreachDate,
        },
      });

      await this.prisma.ticketAuditLog.create({
        data: {
          tenantId,
          ticketId,
          actorId,
          action: 'SLA_RESUMED',
          changes: {
            resumedAt: now.toISOString(),
            remainingSlaMs: remainingMs,
            newResolutionDueAt: newBreachDate.toISOString(),
          },
        },
      });

      this.logger.log(
        `SLA Resumed for ticket ${ticketId}: ${remainingMs}ms remaining, New deadline ${newBreachDate.toISOString()}`,
      );
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
