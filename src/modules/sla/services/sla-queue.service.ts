import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  SLA_JOB_BREACH,
  SLA_JOB_WARNING,
  SLA_MONITOR_QUEUE,
  getSlaBreachJobId,
  getSlaWarningJobId,
} from '../constants/sla.constants';
import { SlaJobPayload } from '../interfaces/sla-job-payload.interface';

@Injectable()
export class SlaQueueService {
  private readonly logger = new Logger(SlaQueueService.name);

  constructor(
    @InjectQueue(SLA_MONITOR_QUEUE)
    private readonly slaQueue: Queue<SlaJobPayload>,
  ) {}

  /**
   * Enqueues deterministic BullMQ delayed jobs with exact wall-clock delays
   * computed by SlaCalendarCalculatorService.
   */
  async scheduleJobsWithDelays(params: {
    tenantId: string;
    ticketId: string;
    policyVersion: number;
    warningDelayMs: number;
    breachDelayMs: number;
    breachDateISO: string;
    warningAlreadySent?: boolean;
  }): Promise<{ warningJobId: string; breachJobId: string }> {
    const {
      tenantId,
      ticketId,
      policyVersion,
      warningDelayMs,
      breachDelayMs,
      breachDateISO,
      warningAlreadySent,
    } = params;

    const warningJobId = getSlaWarningJobId(tenantId, ticketId);
    const breachJobId = getSlaBreachJobId(tenantId, ticketId);

    // Cancel existing jobs to prevent stale instances
    await this.cancelSlaJobs(tenantId, ticketId);

    // 1. Warning Job (80% mark in business time)
    if (!warningAlreadySent && warningDelayMs > 0) {
      const warningPayload: SlaJobPayload = {
        tenantId,
        ticketId,
        policyVersion,
        targetDeadline: breachDateISO,
        stage: 'WARNING',
      };

      await this.slaQueue.add(SLA_JOB_WARNING, warningPayload, {
        jobId: warningJobId,
        delay: warningDelayMs,
        removeOnComplete: true,
        removeOnFail: false,
      });

      this.logger.debug(
        `Scheduled Business-Time Warning job '${warningJobId}' in ${warningDelayMs}ms (delay)`,
      );
    }

    // 2. Breach Job (100% mark in business time)
    const breachPayload: SlaJobPayload = {
      tenantId,
      ticketId,
      policyVersion,
      targetDeadline: breachDateISO,
      stage: 'BREACH',
    };

    await this.slaQueue.add(SLA_JOB_BREACH, breachPayload, {
      jobId: breachJobId,
      delay: Math.max(0, breachDelayMs),
      removeOnComplete: true,
      removeOnFail: false,
    });

    this.logger.debug(
      `Scheduled Business-Time Breach job '${breachJobId}' in ${breachDelayMs}ms (delay)`,
    );

    return { warningJobId, breachJobId };
  }

  /**
   * Legacy / Wall-Clock scheduling fallback.
   */
  async scheduleSlaJobs(params: {
    tenantId: string;
    ticketId: string;
    policyVersion: number;
    targetDurationMs: number;
    remainingMs?: number;
    warningAlreadySent?: boolean;
  }): Promise<{ warningJobId: string; breachJobId: string }> {
    const effectiveTotalMs = params.remainingMs ?? params.targetDurationMs;
    const warningDelayMs = Math.round(effectiveTotalMs * 0.8);
    const breachDateISO = new Date(Date.now() + effectiveTotalMs).toISOString();

    return this.scheduleJobsWithDelays({
      tenantId: params.tenantId,
      ticketId: params.ticketId,
      policyVersion: params.policyVersion,
      warningDelayMs,
      breachDelayMs: effectiveTotalMs,
      breachDateISO,
      warningAlreadySent: params.warningAlreadySent,
    });
  }

  /**
   * O(1) removal of pending SLA warning and breach jobs from Redis via deterministic IDs.
   */
  async cancelSlaJobs(tenantId: string, ticketId: string): Promise<void> {
    const warningJobId = getSlaWarningJobId(tenantId, ticketId);
    const breachJobId = getSlaBreachJobId(tenantId, ticketId);

    const [warningJob, breachJob] = await Promise.all([
      this.slaQueue.getJob(warningJobId),
      this.slaQueue.getJob(breachJobId),
    ]);

    const removals: Promise<unknown>[] = [];

    if (warningJob) {
      removals.push(
        warningJob.remove().catch((err) =>
          this.logger.warn(`Failed to remove warning job ${warningJobId}: ${err.message}`),
        ),
      );
    }

    if (breachJob) {
      removals.push(
        breachJob.remove().catch((err) =>
          this.logger.warn(`Failed to remove breach job ${breachJobId}: ${err.message}`),
        ),
      );
    }

    await Promise.all(removals);
    this.logger.debug(`Cancelled pending SLA jobs for ticket ${ticketId}`);
  }

  async getJobStatus(tenantId: string, ticketId: string) {
    const warningJobId = getSlaWarningJobId(tenantId, ticketId);
    const breachJobId = getSlaBreachJobId(tenantId, ticketId);

    const [warn, breach] = await Promise.all([
      this.slaQueue.getJob(warningJobId),
      this.slaQueue.getJob(breachJobId),
    ]);

    return {
      warningJob: warn ? { id: warn.id, delay: warn.opts.delay } : null,
      breachJob: breach ? { id: breach.id, delay: breach.opts.delay } : null,
    };
  }
}
