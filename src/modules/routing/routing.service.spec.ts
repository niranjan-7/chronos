import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AgentStatus, RoutingMode, TicketPriority, TicketStatus, UserRole } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { RoutingService } from './routing.service';
import { PrismaService } from '../../common/database/prisma.service';
import { TicketsRepository } from '../tickets/repositories/tickets.repository';
import { RoutingRedisService } from './services/routing-redis.service';
import { CLS_TENANT_ID } from '../../common/constants/context.constants';

describe('RoutingService (Unit)', () => {
  let service: RoutingService;
  let mockPrisma: any;
  let mockTicketsRepo: any;
  let mockCls: any;
  let mockRoutingRedis: any;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const agentId = '11111111-1111-1111-1111-111111111111';
  const ticketId = '22222222-2222-2222-2222-222222222222';

  beforeEach(async () => {
    mockPrisma = {
      user: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      ticket: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      agentSkill: {
        upsert: jest.fn(),
        findMany: jest.fn(),
      },
      $queryRaw: jest.fn(),
    };

    mockTicketsRepo = {
      findById: jest.fn(),
      transitionTicketStatus: jest.fn(),
      getTenantId: jest.fn().mockReturnValue(tenantId),
    };

    mockCls = {
      get: jest.fn((key: string) => {
        if (key === CLS_TENANT_ID) return tenantId;
        return undefined;
      }),
      runWith: jest.fn((_ctx: any, fn: () => any) => fn()),
    };

    mockRoutingRedis = {
      syncAgentProfile: jest.fn().mockResolvedValue(undefined),
      claimBestAgent: jest.fn(),
      freeAgentCapacity: jest.fn(),
      incrementAgentLoad: jest.fn().mockResolvedValue(1),
      getAgentActiveLoad: jest.fn().mockResolvedValue(0),
      getAgentSkillScore: jest.fn().mockResolvedValue(550),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoutingService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TicketsRepository, useValue: mockTicketsRepo },
        { provide: ClsService, useValue: mockCls },
        { provide: RoutingRedisService, useValue: mockRoutingRedis },
      ],
    }).compile();

    service = module.get<RoutingService>(RoutingService);
  });

  describe('registerAgentSkills', () => {
    it('should throw NotFoundException if agent not found in tenant', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.registerAgentSkills(tenantId, agentId, [{ skill: 'billing', proficiency: 4 }]),
      ).rejects.toThrow(NotFoundException);
    });

    it('should upsert skills, update capacity, and sync profile to Redis', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({
        id: agentId,
        tenantId,
        status: AgentStatus.ONLINE,
        maxConcurrentTickets: 5,
      });
      mockPrisma.user.update.mockResolvedValue({});
      mockPrisma.agentSkill.upsert.mockResolvedValue({});
      mockPrisma.agentSkill.findMany.mockResolvedValue([
        { skill: 'billing', proficiency: 5 },
        { skill: 'rest_api', proficiency: 4 },
      ]);

      await service.registerAgentSkills(
        tenantId,
        agentId,
        [
          { skill: 'billing', proficiency: 5 },
          { skill: 'rest_api', proficiency: 4 },
        ],
        8,
      );

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { maxConcurrentTickets: 8 },
      });
      expect(mockPrisma.agentSkill.upsert).toHaveBeenCalledTimes(2);
      expect(mockRoutingRedis.syncAgentProfile).toHaveBeenCalledWith(
        tenantId,
        agentId,
        expect.objectContaining({
          status: AgentStatus.ONLINE,
          maxCapacity: 8,
          skills: expect.arrayContaining([
            { skill: 'billing', proficiency: 5 },
            { skill: 'rest_api', proficiency: 4 },
          ]),
        }),
      );
    });
  });

  describe('updateAgentStatus', () => {
    it('should throw NotFoundException if agent does not exist', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);

      await expect(
        service.updateAgentStatus(tenantId, agentId, AgentStatus.ONLINE),
      ).rejects.toThrow(NotFoundException);
    });

    it('should update status in DB, sync Redis profile, and trigger capacity check if ONLINE', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({
        id: agentId,
        tenantId,
        status: AgentStatus.OFFLINE,
        maxConcurrentTickets: 5,
        agentSkills: [{ skill: 'voice_webrtc', proficiency: 3 }],
      });
      mockPrisma.user.update.mockResolvedValue({});
      mockRoutingRedis.freeAgentCapacity.mockResolvedValue(0);
      mockPrisma.agentSkill.findMany.mockResolvedValue([{ skill: 'voice_webrtc', proficiency: 3 }]);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await service.updateAgentStatus(tenantId, agentId, AgentStatus.ONLINE);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: agentId },
        data: { status: AgentStatus.ONLINE },
      });
      expect(mockRoutingRedis.syncAgentProfile).toHaveBeenCalledWith(
        tenantId,
        agentId,
        expect.objectContaining({
          status: AgentStatus.ONLINE,
          maxCapacity: 5,
        }),
      );
      // Online triggers handleCapacityFreed
      expect(mockRoutingRedis.freeAgentCapacity).toHaveBeenCalledWith(tenantId, agentId);
    });
  });

  describe('autoRouteTicket', () => {
    it('should throw NotFoundException if ticket does not exist', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue(null);

      await expect(
        service.autoRouteTicket(tenantId, ticketId, ['billing']),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return routed: false if ticket status is not OPEN', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        status: TicketStatus.IN_PROGRESS,
        requiredSkills: ['billing'],
      });

      const result = await service.autoRouteTicket(tenantId, ticketId);
      expect(result.routed).toBe(false);
      expect(result.reason).toContain('IN_PROGRESS');
    });

    it('should claim winning agent via Redis Lua script and assign ticket in DB', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        ticketNumber: 'TCK-001',
        status: TicketStatus.OPEN,
        requiredSkills: ['billing'],
      });
      mockRoutingRedis.claimBestAgent.mockResolvedValue(agentId);
      mockTicketsRepo.transitionTicketStatus.mockResolvedValue({});

      const result = await service.autoRouteTicket(tenantId, ticketId, ['billing']);

      expect(mockRoutingRedis.claimBestAgent).toHaveBeenCalledWith(tenantId, 'billing');
      expect(mockTicketsRepo.transitionTicketStatus).toHaveBeenCalledWith({
        ticketId,
        targetStatus: TicketStatus.ASSIGNED,
        assignedAgentId: agentId,
        reason: expect.stringContaining('Auto-routed via skill ZSET'),
      });
      expect(result).toEqual({
        routed: true,
        agentId,
        ticketId,
      });
    });

    it('should fall back to overflow queue if all agents are at max capacity (nil from Lua)', async () => {
      mockPrisma.ticket.findFirst.mockResolvedValue({
        id: ticketId,
        ticketNumber: 'TCK-001',
        status: TicketStatus.OPEN,
        requiredSkills: ['billing'],
      });
      mockRoutingRedis.claimBestAgent.mockResolvedValue(null);
      mockPrisma.ticket.update.mockResolvedValue({});

      const result = await service.autoRouteTicket(tenantId, ticketId, ['billing']);

      expect(mockPrisma.ticket.update).toHaveBeenCalledWith({
        where: { id: ticketId },
        data: { routingMode: RoutingMode.AUTO_PUSH },
      });
      expect(result).toEqual({
        routed: false,
        reason: 'CAPACITY_EXCEEDED_OVERFLOW',
        ticketId,
      });
    });
  });

  describe('handleCapacityFreed', () => {
    it('should free capacity in Redis and return NO_WAITING_OVERFLOW_TICKETS if queue is empty', async () => {
      mockRoutingRedis.freeAgentCapacity.mockResolvedValue(1);
      mockPrisma.agentSkill.findMany.mockResolvedValue([{ skill: 'billing', proficiency: 5 }]);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.handleCapacityFreed(tenantId, agentId);

      expect(mockRoutingRedis.freeAgentCapacity).toHaveBeenCalledWith(tenantId, agentId);
      expect(result).toEqual({
        assigned: false,
        reason: 'NO_WAITING_OVERFLOW_TICKETS',
      });
    });

    it('should lock waiting ticket with SKIP LOCKED, assign it, and re-increment agent load', async () => {
      mockRoutingRedis.freeAgentCapacity.mockResolvedValue(0);
      mockPrisma.agentSkill.findMany.mockResolvedValue([{ skill: 'billing', proficiency: 5 }]);
      const waitingTicket = {
        id: ticketId,
        ticket_number: 'TCK-OVERFLOW-1',
        priority: TicketPriority.URGENT,
        required_skills: ['billing'],
      };
      mockPrisma.$queryRaw.mockResolvedValue([waitingTicket]);
      mockTicketsRepo.transitionTicketStatus.mockResolvedValue({});

      const result = await service.handleCapacityFreed(tenantId, agentId);

      expect(mockTicketsRepo.transitionTicketStatus).toHaveBeenCalledWith({
        ticketId,
        targetStatus: TicketStatus.ASSIGNED,
        assignedAgentId: agentId,
        reason: expect.stringContaining('Auto-assigned from overflow pool'),
      });
      expect(mockRoutingRedis.incrementAgentLoad).toHaveBeenCalledWith(tenantId, agentId);
      expect(result).toEqual({
        assigned: true,
        ticketId,
      });
    });
  });

  describe('matchAndRouteTicket (backwards-compatibility)', () => {
    it('should route to least loaded online agent', async () => {
      mockTicketsRepo.findById.mockResolvedValue({
        id: ticketId,
        ticketNumber: 'TCK-001',
        status: TicketStatus.OPEN,
      });
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: agentId,
          name: 'Agent Smith',
          email: 'agent@chronos.io',
          _count: { assignedTickets: 2 },
        },
      ]);
      mockTicketsRepo.transitionTicketStatus.mockResolvedValue({ id: ticketId });

      const result = await service.matchAndRouteTicket({ ticketId });

      expect(result.routed).toBe(true);
      expect(result.assignedAgent).toEqual({
        id: agentId,
        name: 'Agent Smith',
        email: 'agent@chronos.io',
        workload: 3,
      });
    });
  });
});
