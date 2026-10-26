import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client } from 'pg';
import { OutboxStatus, TicketStatus } from '@prisma/client';
import { PrismaService } from '../../../common/database/prisma.service';
import {
  CHRONOS_OUTBOX_CHANNEL,
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_RETRIES,
  OUTBOX_SWEEPER_INTERVAL_MS,
  OUTBOX_EVENT_TICKET_CREATED,
  OUTBOX_EVENT_TICKET_STATUS_CHANGED,
  OUTBOX_EVENT_TICKET_CLAIMED,
} from '../outbox.constants';
import {
  OutboxRow,
  TicketCreatedOutboxPayload,
  TicketStatusChangedOutboxPayload,
  TicketClaimedOutboxPayload,
} from '../outbox.types';
import {
  SLA_JOB_BREACH,
  SLA_JOB_WARNING,
  SLA_MONITOR_QUEUE,
  getSlaBreachJobId,
  getSlaWarningJobId,
} from '../../sla/constants/sla.constants';
import { SlaJobPayload } from '../../sla/interfaces/sla-job-payload.interface';
import { SlaPolicyService } from '../../sla/services/sla-policy.service';
import { SlaCalendarCalculatorService } from '../../sla/services/sla-calendar-calculator.service';
import { TenantCalendarService } from '../../tenants/services/tenant-calendar.service';
import {
  AGENT_CAPACITY_FREED_EVENT,
  TICKET_CREATED_EVENT,
  TICKET_TRANSITIONED_EVENT,
} from '../../../common/events/domain-event.constants';
import {
  AgentCapacityFreedEvent,
  TicketCreatedEvent,
  TicketTransitionedEvent,
} from '../../../common/events/ticket.events';

@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private pgClient: Client | null = null;
  private isProcessing = false;
  private isDestroyed = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private sweeperInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue(SLA_MONITOR_QUEUE)
    private readonly slaQueue: Queue<SlaJobPayload>,
    private readonly slaPolicyService: SlaPolicyService,
    private readonly calendarCalculator: SlaCalendarCalculatorService,
    private readonly tenantCalendarService: TenantCalendarService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // 1. Ensure database index and notification trigger exist
      await this.initDatabaseTrigger();

      // 2. Start persistent pg client listener
      await this.initPgListener();

      // 3. Start fallback polling sweeper (every 2000ms)
      this.sweeperInterval = setInterval(() => {
        this.processPendingEvents().catch((err) => {
          this.logger.error(`Outbox sweeper error: ${err.message}`, err.stack);
        });
      }, OUTBOX_SWEEPER_INTERVAL_MS);

      // 4. Initial immediate sweep on startup
      this.scheduleProcessing();

      this.logger.log('OutboxRelayService initialized (Push/Poll hybrid relay active)');
    } catch (err: any) {
      this.logger.warn(`OutboxRelayService startup warning: ${err.message}. Sweeper will continue.`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.isDestroyed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.sweeperInterval) {
      clearInterval(this.sweeperInterval);
      this.sweeperInterval = null;
    }
    if (this.pgClient) {
      try {
        await this.pgClient.end();
      } catch (err: any) {
        this.logger.debug(`Error closing PG outbox listener: ${err.message}`);
      }
      this.pgClient = null;
    }
  }

  /**
   * Creates the partial index and PostgreSQL AFTER INSERT notification trigger.
   */
  async initDatabaseTrigger(): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_outbox_pending_partial
        ON outbox_events (status, next_attempt_at)
        WHERE status = 'PENDING';
      `);

      await this.prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION notify_outbox_event()
        RETURNS TRIGGER AS $$
        BEGIN
          PERFORM pg_notify('${CHRONOS_OUTBOX_CHANNEL}', NEW.id::text);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await this.prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS trg_outbox_events_notify ON outbox_events;
      `);

      await this.prisma.$executeRawUnsafe(`
        CREATE TRIGGER trg_outbox_events_notify
        AFTER INSERT ON outbox_events
        FOR EACH ROW
        EXECUTE FUNCTION notify_outbox_event();
      `);

      this.logger.debug('PostgreSQL Outbox notification trigger & partial index verified');
    } catch (err: any) {
      if (!err.message?.includes('already exists') && err.code !== '23505') {
        this.logger.warn(`Could not verify PostgreSQL trigger: ${err.message}`);
      }
    }
  }

  /**
   * Connects the dedicated persistent PG client and starts listening to the channel.
   */
  async initPgListener(): Promise<void> {
    const connectionString =
      this.configService.get<string>('DATABASE_URL') ||
      process.env.DATABASE_URL ||
      'postgresql://postgres@localhost:5432/chronos_db?schema=public';

    try {
      this.pgClient = new Client({ connectionString });
      await this.pgClient.connect();

      await this.pgClient.query(`LISTEN ${CHRONOS_OUTBOX_CHANNEL}`);

      this.pgClient.on('notification', (msg) => {
        if (msg.channel === CHRONOS_OUTBOX_CHANNEL) {
          this.logger.debug(`Received pg_notify on ${CHRONOS_OUTBOX_CHANNEL}: ${msg.payload}`);
          this.scheduleProcessing();
        }
      });

      this.pgClient.on('error', (err) => {
        this.logger.error(`PG outbox notification client error: ${err.message}`);
        this.reconnectPgClient();
      });

      this.logger.debug(`Listening to PostgreSQL channel '${CHRONOS_OUTBOX_CHANNEL}' for zero-latency outbox dispatch`);
    } catch (err: any) {
      this.logger.warn(`Failed to connect persistent PG listener: ${err.message}. Falling back to interval polling.`);
    }
  }

  private reconnectPgClient(): void {
    if (this.isDestroyed) return;
    if (this.pgClient) {
      try {
        this.pgClient.end().catch(() => {});
      } catch {}
      this.pgClient = null;
    }

    setTimeout(() => {
      if (!this.isDestroyed) {
        this.initPgListener().catch((err) => {
          this.logger.error(`Reconnection attempt failed: ${err.message}`);
        });
      }
    }, 5000);
  }

  /**
   * Coalesces rapid notifications to debounce and batch database fetch.
   */
  scheduleProcessing(): void {
    if (this.isDestroyed || this.debounceTimer) return;

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.processPendingEvents().catch((err) => {
        this.logger.error(`Error in outbox processing: ${err.message}`, err.stack);
      });
    }, 10);
  }

  /**
   * Core Transactional Outbox Batch Processing:
   * 1. Fetches up to 50 PENDING events using SELECT ... FOR UPDATE SKIP LOCKED
   * 2. Prepares BullMQ jobs with deterministic IDs
   * 3. Dispatches via queue.addBulk() in parallel
   * 4. Updates PostgreSQL outbox rows to PUBLISHED
   */
  async processPendingEvents(): Promise<number> {
    if (this.isProcessing || this.isDestroyed) {
      return 0;
    }

    this.isProcessing = true;
    let processedCount = 0;

    try {
      // 1. Atomically fetch and lock up to 50 PENDING rows with SKIP LOCKED
      const events = await this.prisma.$queryRaw<OutboxRow[]>`
        SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, payload, retry_count
        FROM outbox_events
        WHERE status = 'PENDING'::"OutboxStatus"
          AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT ${OUTBOX_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED;
      `;

      if (!events || events.length === 0) {
        return 0;
      }

      processedCount = events.length;
      const eventIds = events.map((e) => e.id);

      // 2. Mark batch as PROCESSING
      await this.prisma.$executeRaw`
        UPDATE outbox_events
        SET status = 'PROCESSING'::"OutboxStatus"
        WHERE id = ANY(${eventIds}::uuid[]);
      `;

      const bulkJobsToEnqueue: {
        name: string;
        data: SlaJobPayload;
        opts: {
          jobId: string;
          delay: number;
          removeOnComplete: boolean;
          removeOnFail: boolean;
        };
      }[] = [];

      const successfullyProcessedIds: string[] = [];
      const failedEvents: { event: OutboxRow; error: string }[] = [];

      // 3. Process each event
      for (const event of events) {
        try {
          await this.processSingleEvent(event, bulkJobsToEnqueue);
          successfullyProcessedIds.push(event.id);
        } catch (err: any) {
          this.logger.error(
            `Failed processing outbox event ${event.id} [${event.event_type}]: ${err.message}`,
            err.stack,
          );
          failedEvents.push({ event, error: err.message });
        }
      }

      // 4. Dispatch BullMQ jobs via addBulk (atomic multi-job Redis submission)
      if (bulkJobsToEnqueue.length > 0) {
        try {
          await this.slaQueue.addBulk(bulkJobsToEnqueue);
          this.logger.debug(
            `[OutboxRelay] Dispatched ${bulkJobsToEnqueue.length} BullMQ SLA jobs in parallel via queue.addBulk()`,
          );
        } catch (queueErr: any) {
          this.logger.error(`BullMQ addBulk failed: ${queueErr.message}`, queueErr.stack);
          // If Redis failed, all events that scheduled jobs must be marked for retry
          for (const event of events) {
            if (!failedEvents.some((f) => f.event.id === event.id)) {
              failedEvents.push({ event, error: queueErr.message });
            }
          }
          // Clear successfully processed IDs for those that depended on Redis
          successfullyProcessedIds.length = 0;
        }
      }

      // 5. Mark successfully processed events as PUBLISHED
      if (successfullyProcessedIds.length > 0) {
        await this.prisma.$executeRaw`
          UPDATE outbox_events
          SET status = 'PUBLISHED'::"OutboxStatus",
              processed_at = NOW(),
              error = NULL
          WHERE id = ANY(${successfullyProcessedIds}::uuid[]);
        `;
      }

      // 6. Handle failures with exponential backoff & Dead-Letter Queue
      for (const { event, error } of failedEvents) {
        const nextRetryCount = event.retry_count + 1;
        if (nextRetryCount >= OUTBOX_MAX_RETRIES) {
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: OutboxStatus.DEAD_LETTER,
              retryCount: nextRetryCount,
              error,
            },
          });
          this.logger.error(
            `[OutboxRelay DEAD_LETTER] Outbox event ${event.id} moved to DEAD_LETTER after ${nextRetryCount} failed attempts.`,
          );
        } else {
          // Exponential backoff: 2s, 4s, 8s, 16s...
          const backoffMs = Math.pow(2, nextRetryCount) * 1000;
          const nextAttemptAt = new Date(Date.now() + backoffMs);

          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: OutboxStatus.PENDING,
              retryCount: nextRetryCount,
              nextAttemptAt,
              error,
            },
          });
          this.logger.warn(
            `[OutboxRelay RETRY] Outbox event ${event.id} rescheduled for attempt ${nextRetryCount} in ${backoffMs}ms.`,
          );
        }
      }

      // 7. If batch was full, immediately schedule next iteration to drain backlog
      if (events.length === OUTBOX_BATCH_SIZE) {
        this.scheduleProcessing();
      }
    } catch (batchErr: any) {
      this.logger.error(`Error executing outbox batch: ${batchErr.message}`, batchErr.stack);
    } finally {
      this.isProcessing = false;
    }

    return processedCount;
  }

  /**
   * Dispatches business logic for a single outbox event and collects any BullMQ jobs.
   */
  private async processSingleEvent(
    event: OutboxRow,
    bulkJobsToEnqueue: {
      name: string;
      data: SlaJobPayload;
      opts: {
        jobId: string;
        delay: number;
        removeOnComplete: boolean;
        removeOnFail: boolean;
      };
    }[],
  ): Promise<void> {
    const payload = event.payload;

    switch (event.event_type) {
      case OUTBOX_EVENT_TICKET_CREATED: {
        await this.handleTicketCreatedEvent(payload as TicketCreatedOutboxPayload, bulkJobsToEnqueue);
        break;
      }
      case OUTBOX_EVENT_TICKET_STATUS_CHANGED: {
        await this.handleTicketStatusChangedEvent(payload as TicketStatusChangedOutboxPayload, bulkJobsToEnqueue);
        break;
      }
      case OUTBOX_EVENT_TICKET_CLAIMED: {
        await this.handleTicketClaimedEvent(payload as TicketClaimedOutboxPayload);
        break;
      }
      default: {
        this.logger.warn(`Unknown outbox event type: ${event.event_type}`);
      }
    }
  }

  /**
   * Handles ticket.created outbox event:
   * Resolves SLA policy, calculates timezone-aware business deadlines,
   * stages BullMQ warning & breach jobs, and updates ticket resolution deadlines.
   */
  private async handleTicketCreatedEvent(
    payload: TicketCreatedOutboxPayload,
    bulkJobsToEnqueue: {
      name: string;
      data: SlaJobPayload;
      opts: {
        jobId: string;
        delay: number;
        removeOnComplete: boolean;
        removeOnFail: boolean;
      };
    }[],
  ): Promise<void> {
    const { tenantId, ticketId, priority, slaPolicyId, createdAt } = payload;

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { slaPolicy: true },
    });
    if (!ticket) return;

    // 1. Resolve matching policy
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

    // 2. Fetch tenant business calendar & holidays
    const { calendar, holidays } = await this.tenantCalendarService.getTenantCalendarContext(tenantId);

    // 3. Compute business deadlines
    const createdDate = new Date(createdAt);
    const deadlines = this.calendarCalculator.calculateDeadlines(
      createdDate,
      durationMs,
      calendar,
      holidays,
    );

    // 4. Prepare deterministic BullMQ warning job (80% SLA mark)
    if (deadlines.warningDelayMs > 0) {
      const warnJobId = getSlaWarningJobId(tenantId, ticketId);
      bulkJobsToEnqueue.push({
        name: SLA_JOB_WARNING,
        data: {
          tenantId,
          ticketId,
          policyVersion: policy.version,
          targetDeadline: deadlines.breachDate.toISOString(),
          stage: 'WARNING',
        },
        opts: {
          jobId: warnJobId,
          delay: deadlines.warningDelayMs,
          removeOnComplete: true,
          removeOnFail: false,
        },
      });
    }

    // 5. Prepare deterministic BullMQ breach job (100% SLA mark)
    const breachJobId = getSlaBreachJobId(tenantId, ticketId);
    bulkJobsToEnqueue.push({
      name: SLA_JOB_BREACH,
      data: {
        tenantId,
        ticketId,
        policyVersion: policy.version,
        targetDeadline: deadlines.breachDate.toISOString(),
        stage: 'BREACH',
      },
      opts: {
        jobId: breachJobId,
        delay: Math.max(0, deadlines.breachDelayMs),
        removeOnComplete: true,
        removeOnFail: false,
      },
    });

    // 6. Persist calculated deadline on Ticket
    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        resolutionDueAt: deadlines.breachDate,
        remainingSlaMs: BigInt(deadlines.businessDurationMs),
        policyVersion: policy.version,
        slaPolicyId: policy.id,
      },
    });

    // 7. Emit domain event so CQRS Redis cache and WebSockets update
    this.eventEmitter.emit(
      TICKET_CREATED_EVENT,
      new TicketCreatedEvent(
        tenantId,
        ticketId,
        ticket.ticketNumber,
        ticket.priority,
        policy.id,
        createdDate,
      ),
    );
  }

  /**
   * Handles ticket.status_changed outbox event:
   * Handles SLA freeze on ON_HOLD, resume on IN_PROGRESS, and cleanup on RESOLVED/CLOSED.
   */
  private async handleTicketStatusChangedEvent(
    payload: TicketStatusChangedOutboxPayload,
    bulkJobsToEnqueue: {
      name: string;
      data: SlaJobPayload;
      opts: {
        jobId: string;
        delay: number;
        removeOnComplete: boolean;
        removeOnFail: boolean;
      };
    }[],
  ): Promise<void> {
    const { tenantId, ticketId, previousStatus, newStatus, actorId, reason, transitionedAt } = payload;

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { slaPolicy: true },
    });
    if (!ticket) return;

    const now = new Date(transitionedAt || Date.now());

    // Case 1: Freeze SLA on transition to ON_HOLD
    if (newStatus === TicketStatus.ON_HOLD && previousStatus !== TicketStatus.ON_HOLD) {
      const activeSince = ticket.lastResumedAt || ticket.createdAt || now;
      const { calendar, holidays } = await this.tenantCalendarService.getTenantCalendarContext(tenantId);
      const elapsedBusinessMs = this.calendarCalculator.calculateElapsedBusinessMs(
        activeSince,
        now,
        calendar,
        holidays,
      );

      const currentRemaining = ticket.remainingSlaMs ? Number(ticket.remainingSlaMs) : 0;
      const newRemainingSlaMs = Math.max(0, currentRemaining - elapsedBusinessMs);

      // Cancel BullMQ jobs
      await this.cancelSlaJobs(tenantId, ticketId);

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
          actorId: actorId ?? null,
          action: 'SLA_PAUSED',
          changes: {
            elapsedBusinessMs,
            previousRemainingMs: currentRemaining,
            newRemainingSlaMs,
            slaPausedAt: now.toISOString(),
          },
        },
      });

      this.logger.log(`[OutboxRelay] SLA Paused for ticket ${ticketId}: ${elapsedBusinessMs}ms elapsed`);

      if (ticket.assignedAgentId) {
        this.eventEmitter.emit(
          AGENT_CAPACITY_FREED_EVENT,
          new AgentCapacityFreedEvent(tenantId, ticket.assignedAgentId),
        );
      }
    }

    // Case 2: Resume SLA on transition from ON_HOLD to IN_PROGRESS
    if (previousStatus === TicketStatus.ON_HOLD && newStatus === TicketStatus.IN_PROGRESS) {
      const remainingMs = ticket.remainingSlaMs ? Number(ticket.remainingSlaMs) : 0;
      const { calendar, holidays } = await this.tenantCalendarService.getTenantCalendarContext(tenantId);

      let newBreachDate = now;
      if (remainingMs > 0 && !ticket.isBreached) {
        const deadlines = this.calendarCalculator.calculateDeadlines(
          now,
          remainingMs,
          calendar,
          holidays,
        );

        newBreachDate = deadlines.breachDate;

        if (!ticket.isWarningSent && deadlines.warningDelayMs > 0) {
          const warnJobId = getSlaWarningJobId(tenantId, ticketId);
          bulkJobsToEnqueue.push({
            name: SLA_JOB_WARNING,
            data: {
              tenantId,
              ticketId,
              policyVersion: ticket.policyVersion,
              targetDeadline: deadlines.breachDate.toISOString(),
              stage: 'WARNING',
            },
            opts: {
              jobId: warnJobId,
              delay: deadlines.warningDelayMs,
              removeOnComplete: true,
              removeOnFail: false,
            },
          });
        }

        const breachJobId = getSlaBreachJobId(tenantId, ticketId);
        bulkJobsToEnqueue.push({
          name: SLA_JOB_BREACH,
          data: {
            tenantId,
            ticketId,
            policyVersion: ticket.policyVersion,
            targetDeadline: deadlines.breachDate.toISOString(),
            stage: 'BREACH',
          },
          opts: {
            jobId: breachJobId,
            delay: Math.max(0, deadlines.breachDelayMs),
            removeOnComplete: true,
            removeOnFail: false,
          },
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
          actorId: actorId ?? null,
          action: 'SLA_RESUMED',
          changes: {
            remainingSlaMs: remainingMs,
            newResolutionDueAt: newBreachDate.toISOString(),
            lastResumedAt: now.toISOString(),
          },
        },
      });

      this.logger.log(`[OutboxRelay] SLA Resumed for ticket ${ticketId}: remaining ${remainingMs}ms`);
    }

    // Case 3: Complete / Cancel SLA on RESOLVED or CLOSED
    if (newStatus === TicketStatus.RESOLVED || newStatus === TicketStatus.CLOSED) {
      await this.cancelSlaJobs(tenantId, ticketId);
      this.logger.log(`[OutboxRelay] SLA Cleared for resolved ticket ${ticketId}`);

      if (ticket.assignedAgentId) {
        this.eventEmitter.emit(
          AGENT_CAPACITY_FREED_EVENT,
          new AgentCapacityFreedEvent(tenantId, ticket.assignedAgentId),
        );
      }
    }

    // Emit domain event for CQRS analytics, WebSockets, and Webhooks
    this.eventEmitter.emit(
      TICKET_TRANSITIONED_EVENT,
      new TicketTransitionedEvent(
        tenantId,
        ticketId,
        previousStatus,
        newStatus,
        actorId ?? undefined,
        reason,
      ),
    );
  }

  /**
   * Handles ticket.claimed outbox event.
   */
  private async handleTicketClaimedEvent(payload: TicketClaimedOutboxPayload): Promise<void> {
    const { tenantId, ticketId, agentId, status } = payload;

    this.eventEmitter.emit(
      TICKET_TRANSITIONED_EVENT,
      new TicketTransitionedEvent(
        tenantId,
        ticketId,
        TicketStatus.OPEN,
        status || TicketStatus.ASSIGNED,
        agentId,
        'Claimed by agent',
      ),
    );
  }

  /**
   * Deterministically removes BullMQ delayed jobs for a ticket.
   */
  async cancelSlaJobs(tenantId: string, ticketId: string): Promise<void> {
    const warnJobId = getSlaWarningJobId(tenantId, ticketId);
    const breachJobId = getSlaBreachJobId(tenantId, ticketId);

    try {
      const warnJob = await this.slaQueue.getJob(warnJobId);
      if (warnJob) {
        await warnJob.remove();
      }
      const breachJob = await this.slaQueue.getJob(breachJobId);
      if (breachJob) {
        await breachJob.remove();
      }
    } catch (err: any) {
      this.logger.debug(`Could not remove SLA jobs (${ticketId}): ${err.message}`);
    }
  }
}
