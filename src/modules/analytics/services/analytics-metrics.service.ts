import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../common/database/redis.provider';
import { PrismaService } from '../../../common/database/prisma.service';
import { TicketPriority, TicketStatus } from '@prisma/client';

export interface LiveMetricsDto {
  tenantId: string;
  source: 'REDIS_PRE_AGGREGATED' | 'CACHE_REBUILD_FALLBACK';
  cachedAt: string;
  summary: {
    totalTickets: number;
    openCount: number;
    assignedCount: number;
    inProgressCount: number;
    onHoldCount: number;
    resolvedCount: number;
    closedCount: number;
    breachedCount: number;
    atRiskCount: number;
  };
  priorities: {
    urgent: number;
    high: number;
    medium: number;
    low: number;
  };
}

@Injectable()
export class AnalyticsMetricsService {
  private readonly logger = new Logger(AnalyticsMetricsService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  public getRedisKey(tenantId: string): string {
    return `tenant:${tenantId}:metrics:live`;
  }

  /**
   * Atomically increments or decrements a single metric field in the tenant's Redis Hash.
   */
  async increment(tenantId: string, field: string, amount = 1): Promise<number> {
    const key = this.getRedisKey(tenantId);
    const result = await this.redis.hincrby(key, field, amount);
    this.eventEmitter?.emit('metrics.mutated', { tenantId, increments: { [field]: amount } });
    return result;
  }

  /**
   * Pipelined atomic HINCRBY operations for multi-counter mutations in a single roundtrip.
   */
  async incrementMultiple(tenantId: string, increments: Record<string, number>): Promise<void> {
    const key = this.getRedisKey(tenantId);
    const pipeline = this.redis.pipeline();

    for (const [field, delta] of Object.entries(increments)) {
      if (delta !== 0) {
        pipeline.hincrby(key, field, delta);
      }
    }

    await pipeline.exec();
    this.eventEmitter?.emit('metrics.mutated', { tenantId, increments });
  }

  /**
   * Reads pre-aggregated live metrics directly from Redis Hash in sub-5ms latency.
   * Returns null if key does not exist (cache miss).
   */
  async getLiveMetrics(tenantId: string): Promise<LiveMetricsDto | null> {
    const key = this.getRedisKey(tenantId);
    const raw = await this.redis.hgetall(key);

    if (!raw || Object.keys(raw).length === 0) {
      return null;
    }

    const parse = (field: string): number => Math.max(0, parseInt(raw[field] || '0', 10));

    return {
      tenantId,
      source: 'REDIS_PRE_AGGREGATED',
      cachedAt: new Date().toISOString(),
      summary: {
        totalTickets: parse('total_tickets'),
        openCount: parse('open_count'),
        assignedCount: parse('assigned_count'),
        inProgressCount: parse('in_progress_count'),
        onHoldCount: parse('on_hold_count'),
        resolvedCount: parse('resolved_count'),
        closedCount: parse('closed_count'),
        breachedCount: parse('breached_count'),
        atRiskCount: parse('at_risk_count'),
      },
      priorities: {
        urgent: parse('priority_urgent_count'),
        high: parse('priority_high_count'),
        medium: parse('priority_medium_count'),
        low: parse('priority_low_count'),
      },
    };
  }

  /**
   * Cache-rebuild fallback service when Redis key misses.
   * Scans PostgreSQL within tenant boundary, populates Redis Hash, and returns fresh metrics.
   */
  async rebuildLiveMetrics(tenantId: string): Promise<LiveMetricsDto> {
    this.logger.log(`Rebuilding live pre-aggregated Redis metrics for tenant ${tenantId}`);

    const [
      totalTickets,
      openCount,
      assignedCount,
      inProgressCount,
      onHoldCount,
      resolvedCount,
      closedCount,
      breachedCount,
      atRiskCount,
      urgentCount,
      highCount,
      mediumCount,
      lowCount,
    ] = await Promise.all([
      this.prisma.ticket.count({ where: { tenantId } }),
      this.prisma.ticket.count({ where: { tenantId, status: TicketStatus.OPEN } }),
      this.prisma.ticket.count({ where: { tenantId, status: TicketStatus.ASSIGNED } }),
      this.prisma.ticket.count({ where: { tenantId, status: TicketStatus.IN_PROGRESS } }),
      this.prisma.ticket.count({ where: { tenantId, status: TicketStatus.ON_HOLD } }),
      this.prisma.ticket.count({ where: { tenantId, status: TicketStatus.RESOLVED } }),
      this.prisma.ticket.count({ where: { tenantId, status: TicketStatus.CLOSED } }),
      this.prisma.ticket.count({ where: { tenantId, isBreached: true } }),
      this.prisma.ticket.count({
        where: {
          tenantId,
          isWarningSent: true,
          status: { notIn: [TicketStatus.RESOLVED, TicketStatus.CLOSED] },
        },
      }),
      this.prisma.ticket.count({ where: { tenantId, priority: TicketPriority.URGENT } }),
      this.prisma.ticket.count({ where: { tenantId, priority: TicketPriority.HIGH } }),
      this.prisma.ticket.count({ where: { tenantId, priority: TicketPriority.MEDIUM } }),
      this.prisma.ticket.count({ where: { tenantId, priority: TicketPriority.LOW } }),
    ]);

    const hashPayload: Record<string, string> = {
      total_tickets: totalTickets.toString(),
      open_count: openCount.toString(),
      assigned_count: assignedCount.toString(),
      in_progress_count: inProgressCount.toString(),
      on_hold_count: onHoldCount.toString(),
      resolved_count: resolvedCount.toString(),
      closed_count: closedCount.toString(),
      breached_count: breachedCount.toString(),
      at_risk_count: atRiskCount.toString(),
      priority_urgent_count: urgentCount.toString(),
      priority_high_count: highCount.toString(),
      priority_medium_count: mediumCount.toString(),
      priority_low_count: lowCount.toString(),
      last_rebuilt_at: new Date().toISOString(),
    };

    const key = this.getRedisKey(tenantId);
    await this.redis.hset(key, hashPayload);
    // Set 7-day TTL on hash to prevent stale orphan accumulation
    await this.redis.expire(key, 7 * 24 * 3600);

    return {
      tenantId,
      source: 'CACHE_REBUILD_FALLBACK',
      cachedAt: new Date().toISOString(),
      summary: {
        totalTickets,
        openCount,
        assignedCount,
        inProgressCount,
        onHoldCount,
        resolvedCount,
        closedCount,
        breachedCount,
        atRiskCount,
      },
      priorities: {
        urgent: urgentCount,
        high: highCount,
        medium: mediumCount,
        low: lowCount,
      },
    };
  }
}
