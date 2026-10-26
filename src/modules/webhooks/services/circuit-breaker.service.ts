import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { CircuitState } from '@prisma/client';
import { REDIS_CLIENT } from '../../../common/database/redis.provider';
import { PrismaService } from '../../../common/database/prisma.service';
import {
  CIRCUIT_COOLDOWN_INITIAL_SECONDS,
  CIRCUIT_COOLDOWN_REOPEN_SECONDS,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_PROBE_LOCK_SECONDS,
  CIRCUIT_WINDOW_SECONDS,
  WEBHOOK_CIRCUIT_CLOSED_EVENT,
  WEBHOOK_CIRCUIT_TRIPPED_EVENT,
  WEBHOOK_SYSTEM_ALERT_EVENT,
  getCircuitCooldownKey,
  getCircuitFailuresKey,
  getCircuitOpenUntilKey,
  getCircuitProbeLockKey,
  getCircuitStateKey,
} from '../constants/webhook.constants';

export interface CircuitCheckResult {
  state: CircuitState;
  canExecute: boolean;
  isProbe: boolean;
  reason?: string;
  openUntil?: number;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Evaluates the Redis sliding-window circuit breaker state before executing an outbound call.
   */
  async checkCircuit(tenantId: string, endpointId: string): Promise<CircuitCheckResult> {
    const stateKey = getCircuitStateKey(tenantId, endpointId);
    const openUntilKey = getCircuitOpenUntilKey(tenantId, endpointId);
    const probeLockKey = getCircuitProbeLockKey(tenantId, endpointId);

    const [rawState, rawOpenUntil] = await this.redis.mget(stateKey, openUntilKey);
    const currentState: CircuitState = (rawState as CircuitState) || CircuitState.CLOSED;
    const openUntil = rawOpenUntil ? parseInt(rawOpenUntil, 10) : 0;
    const now = Date.now();

    // 1. CLOSED: Normal dispatch
    if (currentState === CircuitState.CLOSED) {
      return {
        state: CircuitState.CLOSED,
        canExecute: true,
        isProbe: false,
      };
    }

    // 2. OPEN: Check if cooldown has expired
    if (currentState === CircuitState.OPEN) {
      if (now < openUntil) {
        // Cooldown still active -> Fast-fail immediately
        return {
          state: CircuitState.OPEN,
          canExecute: false,
          isProbe: false,
          reason: `Circuit is OPEN until ${new Date(openUntil).toISOString()}. Fast-failing HTTP call.`,
          openUntil,
        };
      }

      // Cooldown expired -> Transition to HALF_OPEN and attempt probe lock
      return this.attemptProbeExecution(tenantId, endpointId, stateKey, probeLockKey);
    }

    // 3. HALF_OPEN: Cooldown already expired, allow exactly 1 probe request through
    return this.attemptProbeExecution(tenantId, endpointId, stateKey, probeLockKey);
  }

  /**
   * Enforces that exactly 1 probe request enters execution in HALF_OPEN state using Redis SET NX.
   */
  private async attemptProbeExecution(
    tenantId: string,
    endpointId: string,
    stateKey: string,
    probeLockKey: string,
  ): Promise<CircuitCheckResult> {
    const lockAcquired = await this.redis.set(
      probeLockKey,
      '1',
      'EX',
      CIRCUIT_PROBE_LOCK_SECONDS,
      'NX',
    );

    if (lockAcquired === 'OK') {
      // Set HALF_OPEN state in Redis and sync DB
      await this.redis.set(stateKey, CircuitState.HALF_OPEN);
      await this.prisma.webhookEndpoint.updateMany({
        where: { id: endpointId, tenantId },
        data: { circuitState: CircuitState.HALF_OPEN },
      });

      this.logger.log(
        `[CircuitBreaker] Endpoint ${endpointId} entered HALF_OPEN. Probe request acquired lock.`,
      );

      return {
        state: CircuitState.HALF_OPEN,
        canExecute: true,
        isProbe: true,
      };
    }

    // Another concurrent worker has the probe request in-flight
    return {
      state: CircuitState.HALF_OPEN,
      canExecute: false,
      isProbe: false,
      reason: 'Circuit is HALF_OPEN. Another probe request is currently in-flight.',
    };
  }

  /**
   * Records a successful HTTP delivery (HTTP 2xx).
   * If this was a probe request, resets the circuit to CLOSED.
   */
  async recordSuccess(tenantId: string, endpointId: string, isProbe: boolean): Promise<void> {
    const stateKey = getCircuitStateKey(tenantId, endpointId);
    const failuresKey = getCircuitFailuresKey(tenantId, endpointId);
    const openUntilKey = getCircuitOpenUntilKey(tenantId, endpointId);
    const cooldownKey = getCircuitCooldownKey(tenantId, endpointId);
    const probeLockKey = getCircuitProbeLockKey(tenantId, endpointId);

    if (isProbe) {
      // Probe succeeded: Reset circuit back to CLOSED
      const pipeline = this.redis.pipeline();
      pipeline.set(stateKey, CircuitState.CLOSED);
      pipeline.del(failuresKey);
      pipeline.del(openUntilKey);
      pipeline.del(probeLockKey);
      pipeline.set(cooldownKey, CIRCUIT_COOLDOWN_INITIAL_SECONDS.toString());
      await pipeline.exec();

      await this.prisma.webhookEndpoint.updateMany({
        where: { id: endpointId, tenantId },
        data: { circuitState: CircuitState.CLOSED },
      });

      this.logger.log(
        `[CircuitBreaker] Probe request succeeded for endpoint ${endpointId}. Circuit reset to CLOSED.`,
      );

      this.eventEmitter.emit(WEBHOOK_CIRCUIT_CLOSED_EVENT, {
        tenantId,
        endpointId,
        resetAt: new Date().toISOString(),
      });
    } else {
      // Normal CLOSED success: clear consecutive failures counter
      await this.redis.del(failuresKey);
    }
  }

  /**
   * Records an HTTP failure (5xx or timeout or connection error).
   * Trips the circuit if failure criteria are met.
   */
  async recordFailure(
    tenantId: string,
    endpointId: string,
    isProbe: boolean,
    errorDetails: {
      statusCode?: number;
      isTimeout?: boolean;
      errorMessage?: string;
    },
  ): Promise<void> {
    const isServerErrorOrTimeout =
      errorDetails.isTimeout ||
      (errorDetails.statusCode !== undefined && errorDetails.statusCode >= 500) ||
      errorDetails.errorMessage?.includes('timeout') ||
      errorDetails.errorMessage?.includes('ECONNREFUSED');

    // 4xx errors (client errors) do not indicate server outage and do not trip the circuit
    if (!isServerErrorOrTimeout) {
      return;
    }

    if (isProbe) {
      // Probe failed in HALF_OPEN: Re-open circuit for 120s cooldown
      await this.tripCircuit(
        tenantId,
        endpointId,
        CIRCUIT_COOLDOWN_REOPEN_SECONDS,
        `Probe request failed (${errorDetails.errorMessage || 'HTTP ' + errorDetails.statusCode}). Re-opening circuit for 120s.`,
      );
      return;
    }

    // Normal CLOSED failure: Increment rolling consecutive failures counter
    const failuresKey = getCircuitFailuresKey(tenantId, endpointId);
    const currentFailures = await this.redis.incr(failuresKey);
    await this.redis.expire(failuresKey, CIRCUIT_WINDOW_SECONDS);

    this.logger.warn(
      `[CircuitBreaker] Consecutive failures for endpoint ${endpointId}: ${currentFailures}/${CIRCUIT_FAILURE_THRESHOLD}`,
    );

    if (currentFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      // 10 consecutive failures in 5 min: Trip circuit to OPEN for 60s
      await this.tripCircuit(
        tenantId,
        endpointId,
        CIRCUIT_COOLDOWN_INITIAL_SECONDS,
        `Reached ${currentFailures} consecutive 5xx/timeout errors in 5-minute rolling window.`,
      );
    }
  }

  /**
   * Trips the circuit breaker to OPEN for a specified cooldown duration.
   */
  async tripCircuit(
    tenantId: string,
    endpointId: string,
    cooldownSeconds: number,
    reason: string,
  ): Promise<void> {
    const stateKey = getCircuitStateKey(tenantId, endpointId);
    const openUntilKey = getCircuitOpenUntilKey(tenantId, endpointId);
    const cooldownKey = getCircuitCooldownKey(tenantId, endpointId);
    const probeLockKey = getCircuitProbeLockKey(tenantId, endpointId);

    const now = Date.now();
    const openUntil = now + cooldownSeconds * 1000;

    const pipeline = this.redis.pipeline();
    pipeline.set(stateKey, CircuitState.OPEN);
    pipeline.set(openUntilKey, openUntil.toString());
    pipeline.set(cooldownKey, cooldownSeconds.toString());
    pipeline.del(probeLockKey);
    await pipeline.exec();

    await this.prisma.webhookEndpoint.updateMany({
      where: { id: endpointId, tenantId },
      data: { circuitState: CircuitState.OPEN },
    });

    this.logger.error(
      `[CircuitBreaker TRIPPED] Endpoint ${endpointId} tripped to OPEN for ${cooldownSeconds}s. Reason: ${reason}`,
    );

    // Emit circuit tripped event and tenant system alert
    this.eventEmitter.emit(WEBHOOK_CIRCUIT_TRIPPED_EVENT, {
      tenantId,
      endpointId,
      cooldownSeconds,
      openUntil: new Date(openUntil).toISOString(),
      reason,
    });

    this.eventEmitter.emit(WEBHOOK_SYSTEM_ALERT_EVENT, {
      tenantId,
      endpointId,
      type: 'CIRCUIT_BREAKER_TRIPPED',
      message: `Outbound webhook endpoint ${endpointId} has been disabled for ${cooldownSeconds}s due to repeated delivery failures: ${reason}`,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Manually resets circuit state to CLOSED (Admin Override).
   */
  async resetCircuit(tenantId: string, endpointId: string): Promise<void> {
    const stateKey = getCircuitStateKey(tenantId, endpointId);
    const failuresKey = getCircuitFailuresKey(tenantId, endpointId);
    const openUntilKey = getCircuitOpenUntilKey(tenantId, endpointId);
    const cooldownKey = getCircuitCooldownKey(tenantId, endpointId);
    const probeLockKey = getCircuitProbeLockKey(tenantId, endpointId);

    const pipeline = this.redis.pipeline();
    pipeline.set(stateKey, CircuitState.CLOSED);
    pipeline.del(failuresKey);
    pipeline.del(openUntilKey);
    pipeline.del(probeLockKey);
    pipeline.set(cooldownKey, CIRCUIT_COOLDOWN_INITIAL_SECONDS.toString());
    await pipeline.exec();

    await this.prisma.webhookEndpoint.updateMany({
      where: { id: endpointId, tenantId },
      data: { circuitState: CircuitState.CLOSED },
    });

    this.logger.log(`[CircuitBreaker] Circuit manually reset to CLOSED for endpoint ${endpointId}`);
  }

  /**
   * Retrieves current circuit status from Redis.
   */
  async getCircuitStatus(tenantId: string, endpointId: string) {
    const stateKey = getCircuitStateKey(tenantId, endpointId);
    const failuresKey = getCircuitFailuresKey(tenantId, endpointId);
    const openUntilKey = getCircuitOpenUntilKey(tenantId, endpointId);
    const cooldownKey = getCircuitCooldownKey(tenantId, endpointId);

    const [state, failures, openUntil, cooldown] = await this.redis.mget(
      stateKey,
      failuresKey,
      openUntilKey,
      cooldownKey,
    );

    return {
      state: (state as CircuitState) || CircuitState.CLOSED,
      consecutiveFailures: failures ? parseInt(failures, 10) : 0,
      openUntil: openUntil ? parseInt(openUntil, 10) : null,
      cooldownSeconds: cooldown ? parseInt(cooldown, 10) : CIRCUIT_COOLDOWN_INITIAL_SECONDS,
    };
  }
}
