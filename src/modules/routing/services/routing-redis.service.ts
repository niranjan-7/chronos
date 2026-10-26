import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { AgentStatus } from '@prisma/client';
import { REDIS_CLIENT } from '../../../common/database/redis.provider';
import {
  CLAIM_BEST_AGENT_LUA,
  FREE_AGENT_CAPACITY_LUA,
  getAgentInfoKey,
  getAgentLoadKey,
  getSkillZsetKey,
} from '../routing.constants';

export interface AgentSkillProfile {
  status: AgentStatus;
  maxCapacity: number;
  skills: { skill: string; proficiency: number }[];
}

@Injectable()
export class RoutingRedisService {
  private readonly logger = new Logger(RoutingRedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Syncs an agent's status, capacity, and skills into tenant-scoped Redis structures:
   * 1. HSET tenant:{tenantId}:agent:{agentId}:info
   * 2. Recalculates and populates ZSET tenant:{tenantId}:skill:{skill}:agents
   */
  async syncAgentProfile(
    tenantId: string,
    agentId: string,
    profile: AgentSkillProfile,
  ): Promise<void> {
    const infoKey = getAgentInfoKey(tenantId, agentId);
    const loadKey = getAgentLoadKey(tenantId, agentId);

    // 1. Get current active load (default to 0 if not present)
    const currentLoadStr = await this.redis.get(loadKey);
    const activeLoad = currentLoadStr ? parseInt(currentLoadStr, 10) : 0;

    // 2. Prepare info hash payload
    const allSkillsStr = profile.skills.map((s) => s.skill).join(',');
    const hashData: Record<string, string | number> = {
      status: profile.status,
      max_capacity: profile.maxCapacity,
      all_skills: allSkillsStr,
    };

    for (const s of profile.skills) {
      hashData[`prof:${s.skill}`] = s.proficiency;
    }

    await this.redis.hset(infoKey, hashData);

    // 3. Update skill ZSETs based on agent status and available capacity
    const isAvailable = profile.status === AgentStatus.ONLINE && activeLoad < profile.maxCapacity;

    for (const s of profile.skills) {
      const zsetKey = getSkillZsetKey(tenantId, s.skill);
      if (isAvailable) {
        const availableRatio = (profile.maxCapacity - activeLoad) / profile.maxCapacity;
        const score = s.proficiency * 100 + availableRatio * 50;
        await this.redis.zadd(zsetKey, score, agentId);
      } else {
        await this.redis.zrem(zsetKey, agentId);
      }
    }

    this.logger.debug(
      `[RoutingRedis] Synced agent ${agentId} profile (status=${profile.status}, load=${activeLoad}/${profile.maxCapacity}, skills=${profile.skills.length})`,
    );
  }

  /**
   * Executes atomic Redis Lua script (claim_best_agent.lua) to inspect candidates,
   * verify capacity, increment load, and update all skill ZSET scores in a single round-trip.
   */
  async claimBestAgent(tenantId: string, skillTag: string): Promise<string | null> {
    const zsetKey = getSkillZsetKey(tenantId, skillTag);

    try {
      const winner = await this.redis.eval(
        CLAIM_BEST_AGENT_LUA,
        1,
        zsetKey,
        tenantId,
        skillTag,
      );

      return (winner as string) || null;
    } catch (err: any) {
      this.logger.error(`claimBestAgent Lua execution failed: ${err.message}`, err.stack);
      throw err;
    }
  }

  /**
   * Executes atomic Redis Lua script (free_agent_capacity.lua) to decrement active load
   * and restore/recalculate composite scores across all agent skill ZSETs.
   */
  async freeAgentCapacity(tenantId: string, agentId: string): Promise<number> {
    const loadKey = getAgentLoadKey(tenantId, agentId);
    const infoKey = getAgentInfoKey(tenantId, agentId);

    try {
      const newLoad = await this.redis.eval(
        FREE_AGENT_CAPACITY_LUA,
        2,
        loadKey,
        infoKey,
        tenantId,
        agentId,
      );

      return typeof newLoad === 'number' ? newLoad : parseInt(String(newLoad), 10) || 0;
    } catch (err: any) {
      this.logger.error(`freeAgentCapacity Lua execution failed: ${err.message}`, err.stack);
      throw err;
    }
  }

  /**
   * Increments an agent's active load and updates their skill ZSETs.
   */
  async incrementAgentLoad(tenantId: string, agentId: string): Promise<number> {
    const loadKey = getAgentLoadKey(tenantId, agentId);
    const infoKey = getAgentInfoKey(tenantId, agentId);

    const newLoad = await this.redis.incr(loadKey);

    const info = await this.redis.hgetall(infoKey);
    const maxCapacity = parseInt(info.max_capacity || '5', 10);
    const allSkillsStr = info.all_skills || '';

    if (allSkillsStr) {
      const skills = allSkillsStr.split(',');
      for (const s of skills) {
        const zsetKey = getSkillZsetKey(tenantId, s);
        if (newLoad >= maxCapacity) {
          await this.redis.zrem(zsetKey, agentId);
        } else {
          const prof = parseInt(info[`prof:${s}`] || '1', 10);
          const ratio = (maxCapacity - newLoad) / maxCapacity;
          const score = prof * 100 + ratio * 50;
          await this.redis.zadd(zsetKey, score, agentId);
        }
      }
    }

    return newLoad;
  }

  /**
   * Retrieves an agent's current active load from Redis.
   */
  async getAgentActiveLoad(tenantId: string, agentId: string): Promise<number> {
    const loadKey = getAgentLoadKey(tenantId, agentId);
    const raw = await this.redis.get(loadKey);
    return raw ? parseInt(raw, 10) : 0;
  }

  /**
   * Retrieves an agent's score in a given skill ZSET.
   */
  async getAgentSkillScore(
    tenantId: string,
    skillTag: string,
    agentId: string,
  ): Promise<number | null> {
    const zsetKey = getSkillZsetKey(tenantId, skillTag);
    const scoreStr = await this.redis.zscore(zsetKey, agentId);
    return scoreStr ? parseFloat(scoreStr) : null;
  }
}
