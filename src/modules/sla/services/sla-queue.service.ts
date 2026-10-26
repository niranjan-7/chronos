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
   * Enqueues deterministic BullMQ delayed jobs for SLA warning (80%) and breach (100%).
   */
  async scheduleSlaJobs(params: {
    tenantId: string;
    ticketId: string;
    policyVersion: number;
    targetDurationMs: number;
    remainingMs?: number;
    warningAlreadySent?: boolean;
  }): Promise<{ warningJobId: string; breachJobId: string }> {
    const {
      tenantId,
      ticketId,
      policyVersion,
      targetDurationMs,
      remainingMs,
      warningAlreadySent,
    } = params;

    const effectiveTotalMs = remainingMs ?? targetDurationMs;
    const deadline = new Date(Date.now() + effectiveTotalMs).toISOString();

    const warningJobId = getSlaWarningJobId(tenantId, ticketId);
    const breachJobId = getSlaBreachJobId(tenantId, ticketId);

    // Cancel any stale/previous instances before scheduling
    await this.cancelSlaJobs(tenantId, ticketId);

    // 1. Calculate Warning delay (80% of total target duration)
    const warningDelayMs = Math.round(effectiveTotalMs * 0.8);

    if (!warningAlreadySent && warningDelayMs > 0) {
      const warningPayload: SlaJobPayload = {
        tenantId,
        ticketId,
        policyVersion,
        targetDeadline: deadline,
        stage: 'WARNING',
      };

      await this.slaQueue.add(SLA_JOB_WARNING, warningPayload, {
        jobId: warningJobId,
        delay: warningDelayMs,
        removeOnComplete: true,
        removeOnFail: false,
      });

      this.logger.debug(
        `Scheduled SLA Warning job '${warningJobId}' in ${warningDelayMs}ms (80% mark)`,
      );
    }

    // 2. Schedule Breach delay (100% of target duration)
    const breachPayload: SlaJobPayload = {
      tenantId,
      ticketId,
      policyVersion,
      targetDeadline: deadline,
      stage: 'BREACH',
    };

    await this.slaQueue.add(SLA_JOB_BREACH, breachPayload, {
      jobId: breachJobId,
      delay: Math.round(effectiveTotalMs),
      removeOnComplete: true,
      removeOnFail: false,
    });

    this.logger.debug(
      `Scheduled SLA Breach job '${breachJobId}' in ${effectiveTotalMs}ms (100% mark)`,
    );

    return { warningJobId, breachJobId };
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

  /**
   * Inspects active delayed status in Redis for debugging/verification.
   */
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
