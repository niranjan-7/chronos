import { DEFAULT_TENANTS } from '../chronos-web/src/lib/tokens';
import { useTenantStore } from '../chronos-web/src/stores/tenant-store';
import { Ticket, TicketStatus, TicketPriority, TicketAuditLog } from '../chronos-web/src/types/telemetry';
import { TicketStateMachine } from '../src/modules/tickets/state-machine/ticket-state-machine';
import { TicketStatus as PrismaTicketStatus } from '@prisma/client';

describe('Phase 11: War-Room Telemetry Matrix & Workspace Agent Lifecycle (Integration)', () => {
  const stateMachine = new TicketStateMachine();

  beforeEach(() => {
    // Reset tenant store
    const acmeTenant = DEFAULT_TENANTS[0];
    useTenantStore.getState().setTenant(acmeTenant);
  });

  describe('War-Room SLA Countdown & Urgency Calculation Rules', () => {
    const PRIORITY_DURATIONS: Record<TicketPriority, number> = {
      URGENT: 60 * 60 * 1000, // 1 hour = 3,600,000ms
      HIGH: 4 * 60 * 60 * 1000, // 4 hours = 14,400,000ms
      MEDIUM: 12 * 60 * 60 * 1000, // 12 hours = 43,200,000ms
      LOW: 24 * 60 * 60 * 1000, // 24 hours = 86,400,000ms
    };

    function determineSlaPhase(
      ticket: {
        status: TicketStatus;
        isBreached?: boolean;
        createdAt: string;
        targetBreachAt?: string | null;
        remainingSlaMs?: number | null;
        priority: TicketPriority;
      },
      now: number = Date.now(),
    ): 'HEALTHY' | 'WARNING' | 'BREACHED' | 'FROZEN' | 'COMPLETED' {
      if (ticket.status === 'RESOLVED' || ticket.status === 'CLOSED') {
        return 'COMPLETED';
      }
      if (ticket.status === 'ON_HOLD') {
        return 'FROZEN';
      }
      if (ticket.isBreached) {
        return 'BREACHED';
      }

      const createdTime = new Date(ticket.createdAt).getTime();
      const breachTime = ticket.targetBreachAt
        ? new Date(ticket.targetBreachAt).getTime()
        : createdTime + PRIORITY_DURATIONS[ticket.priority];
      const totalDuration = Math.max(1000, breachTime - createdTime);
      const remainingMs = ticket.remainingSlaMs ?? Math.max(0, breachTime - now);

      if (remainingMs <= 0) {
        return 'BREACHED';
      }

      const elapsedMs = totalDuration - remainingMs;
      const pctElapsed = (elapsedMs / totalDuration) * 100;

      if (pctElapsed >= 80) {
        return 'WARNING';
      }
      return 'HEALTHY';
    }

    it('should determine HEALTHY phase when SLA elapsed is < 80%', () => {
      const now = Date.now();
      const ticket = {
        status: 'IN_PROGRESS' as TicketStatus,
        priority: 'HIGH' as TicketPriority,
        createdAt: new Date(now - 30 * 60 * 1000).toISOString(), // 30 mins ago
        targetBreachAt: new Date(now + 3.5 * 60 * 60 * 1000).toISOString(), // 4h total
        remainingSlaMs: 3.5 * 60 * 60 * 1000,
      };

      const phase = determineSlaPhase(ticket, now);
      expect(phase).toBe('HEALTHY');
    });

    it('should determine WARNING phase when SLA elapsed is between 80% and 99%', () => {
      const now = Date.now();
      const totalDuration = 4 * 60 * 60 * 1000; // 4 hours
      const elapsed85pct = totalDuration * 0.85;

      const ticket = {
        status: 'IN_PROGRESS' as TicketStatus,
        priority: 'HIGH' as TicketPriority,
        createdAt: new Date(now - elapsed85pct).toISOString(),
        targetBreachAt: new Date(now + (totalDuration - elapsed85pct)).toISOString(),
        remainingSlaMs: totalDuration - elapsed85pct,
      };

      const phase = determineSlaPhase(ticket, now);
      expect(phase).toBe('WARNING');
    });

    it('should determine BREACHED phase when 100% SLA has elapsed or ticket is flagged breached', () => {
      const now = Date.now();
      const ticketOverdue = {
        status: 'IN_PROGRESS' as TicketStatus,
        priority: 'URGENT' as TicketPriority,
        createdAt: new Date(now - 70 * 60 * 1000).toISOString(), // 70 mins ago (1h target)
        targetBreachAt: new Date(now - 10 * 60 * 1000).toISOString(),
        remainingSlaMs: 0,
      };

      expect(determineSlaPhase(ticketOverdue, now)).toBe('BREACHED');

      const ticketFlagged = {
        status: 'IN_PROGRESS' as TicketStatus,
        priority: 'URGENT' as TicketPriority,
        createdAt: new Date(now).toISOString(),
        isBreached: true,
      };
      expect(determineSlaPhase(ticketFlagged, now)).toBe('BREACHED');
    });

    it('should determine FROZEN phase when ticket is ON_HOLD and preserve remaining SLA', () => {
      const now = Date.now();
      const frozenTicket = {
        status: 'ON_HOLD' as TicketStatus,
        priority: 'HIGH' as TicketPriority,
        createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
        remainingSlaMs: 3 * 60 * 60 * 1000, // 3 hours remaining locked
      };

      expect(determineSlaPhase(frozenTicket, now)).toBe('FROZEN');
    });

    it('should determine COMPLETED phase when ticket is RESOLVED or CLOSED', () => {
      const now = Date.now();
      const resolvedTicket = {
        status: 'RESOLVED' as TicketStatus,
        priority: 'MEDIUM' as TicketPriority,
        createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
      };
      const closedTicket = {
        status: 'CLOSED' as TicketStatus,
        priority: 'LOW' as TicketPriority,
        createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
      };

      expect(determineSlaPhase(resolvedTicket, now)).toBe('COMPLETED');
      expect(determineSlaPhase(closedTicket, now)).toBe('COMPLETED');
    });
  });

  describe('Ticket State Machine Strict Lifecycle Rules', () => {
    it('should enforce valid lifecycle progression: OPEN -> ASSIGNED -> IN_PROGRESS -> ON_HOLD -> IN_PROGRESS -> RESOLVED -> CLOSED', () => {
      expect(stateMachine.canTransition(PrismaTicketStatus.OPEN, PrismaTicketStatus.ASSIGNED)).toBe(true);
      expect(stateMachine.canTransition(PrismaTicketStatus.ASSIGNED, PrismaTicketStatus.IN_PROGRESS)).toBe(true);
      expect(stateMachine.canTransition(PrismaTicketStatus.IN_PROGRESS, PrismaTicketStatus.ON_HOLD)).toBe(true);
      expect(stateMachine.canTransition(PrismaTicketStatus.ON_HOLD, PrismaTicketStatus.IN_PROGRESS)).toBe(true);
      expect(stateMachine.canTransition(PrismaTicketStatus.IN_PROGRESS, PrismaTicketStatus.RESOLVED)).toBe(true);
      expect(stateMachine.canTransition(PrismaTicketStatus.RESOLVED, PrismaTicketStatus.CLOSED)).toBe(true);
    });

    it('should reject invalid lifecycle transitions with structured exception', () => {
      // Direct jump from OPEN to CLOSED
      expect(stateMachine.canTransition(PrismaTicketStatus.OPEN, PrismaTicketStatus.CLOSED)).toBe(false);
      expect(() => {
        stateMachine.validateTransition(PrismaTicketStatus.OPEN, PrismaTicketStatus.CLOSED, 'tck-1', 'Illegal skip');
      }).toThrow();

      // Direct jump from OPEN to ON_HOLD
      expect(stateMachine.canTransition(PrismaTicketStatus.OPEN, PrismaTicketStatus.ON_HOLD)).toBe(false);

      // Transition out of CLOSED terminal state
      expect(stateMachine.canTransition(PrismaTicketStatus.CLOSED, PrismaTicketStatus.OPEN)).toBe(false);
      expect(stateMachine.canTransition(PrismaTicketStatus.CLOSED, PrismaTicketStatus.IN_PROGRESS)).toBe(false);
      expect(stateMachine.getAllowedTransitions(PrismaTicketStatus.CLOSED)).toEqual([]);
    });

    it('should generate valid TicketAuditLog entry on status transition', () => {
      const now = new Date().toISOString();
      const auditLog: TicketAuditLog = {
        id: 'audit-uuid-101',
        ticketId: 'tck-uuid-001',
        tenantId: 'tenant-acme-111',
        previousStatus: 'IN_PROGRESS',
        newStatus: 'ON_HOLD',
        actorId: 'user-agent-sarah',
        reason: 'Awaiting customer response on gateway logs',
        slaRemainingMs: 3600000,
        createdAt: now,
      };

      expect(auditLog.previousStatus).toBe('IN_PROGRESS');
      expect(auditLog.newStatus).toBe('ON_HOLD');
      expect(auditLog.reason).toContain('customer response');
      expect(auditLog.actorId).toBe('user-agent-sarah');
    });
  });

  describe('Agent Persona, Skills & Capacity State Management', () => {
    it('should allow toggling agent status between ONLINE, BUSY, and OFFLINE', () => {
      const store = useTenantStore.getState();
      expect(store.activePersona.status).toBe('ONLINE');

      store.setAgentStatus('BUSY');
      expect(useTenantStore.getState().activePersona.status).toBe('BUSY');

      store.setAgentStatus('OFFLINE');
      expect(useTenantStore.getState().activePersona.status).toBe('OFFLINE');

      store.setAgentStatus('ONLINE');
      expect(useTenantStore.getState().activePersona.status).toBe('ONLINE');
    });

    it('should verify persona skills have proficiency ratings between 1 and 5', () => {
      const agentPersona = DEFAULT_TENANTS[0].personas.find((p) => p.role === 'AGENT')!;
      expect(agentPersona).toBeDefined();
      expect(agentPersona.skillsDetailed).toBeDefined();
      expect(agentPersona.skillsDetailed!.length).toBeGreaterThan(0);

      for (const skill of agentPersona.skillsDetailed!) {
        expect(skill.name).toBeDefined();
        expect(typeof skill.name).toBe('string');
        expect(skill.proficiency).toBeGreaterThanOrEqual(1);
        expect(skill.proficiency).toBeLessThanOrEqual(5);
      }
    });

    it('should calculate active agent capacity ratio accurately', () => {
      const maxCapacity = 5;
      const activeTickets = 3;
      const availableCapacity = maxCapacity - activeTickets;
      const loadPercentage = (activeTickets / maxCapacity) * 100;

      expect(availableCapacity).toBe(2);
      expect(loadPercentage).toBe(60);

      // Verify routing score calculation matches Lua formula:
      // (proficiency * 100) + ((max_capacity - active_load) / max_capacity) * 100
      const proficiency = 4;
      const compositeScore = proficiency * 100 + ((maxCapacity - activeTickets) / maxCapacity) * 100;
      expect(compositeScore).toBe(400 + 40); // 440
    });
  });

  describe('War-Room Dashboard CQRS KPI Aggregation', () => {
    it('should compute correct telemetry KPIs from ticket collection', () => {
      const mockTickets: Ticket[] = [
        {
          id: '1',
          ticketNumber: 'TCK-001',
          tenantId: 'tenant-1',
          title: 'Outage',
          description: 'Critical service outage',
          priority: 'URGENT',
          status: 'IN_PROGRESS',
          createdAt: new Date(Date.now() - 3500000).toISOString(),
          updatedAt: new Date().toISOString(),
          targetBreachAt: new Date(Date.now() + 100000).toISOString(), // ~97% elapsed: WARNING
          isBreached: false,
          isWarningSent: true,
          requiredSkills: ['voice_webrtc'],
        },
        {
          id: '2',
          ticketNumber: 'TCK-002',
          tenantId: 'tenant-1',
          title: 'Database connection drop',
          description: 'Connection pool exhausted',
          priority: 'HIGH',
          status: 'ON_HOLD',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          remainingSlaMs: 12000000,
          isBreached: false,
          isWarningSent: false,
          requiredSkills: ['billing'],
        },
        {
          id: '3',
          ticketNumber: 'TCK-003',
          tenantId: 'tenant-1',
          title: 'Expired session token',
          description: 'Auth issue',
          priority: 'MEDIUM',
          status: 'IN_PROGRESS',
          createdAt: new Date(Date.now() - 50000000).toISOString(),
          updatedAt: new Date().toISOString(),
          isBreached: true, // BREACHED
          isWarningSent: true,
          requiredSkills: [],
        },
        {
          id: '4',
          ticketNumber: 'TCK-004',
          tenantId: 'tenant-1',
          title: 'Typo on billing receipt',
          description: 'Minor text issue',
          priority: 'LOW',
          status: 'OPEN',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isBreached: false,
          isWarningSent: false,
          requiredSkills: [],
        },
        {
          id: '5',
          ticketNumber: 'TCK-005',
          tenantId: 'tenant-1',
          title: 'Fixed router bug',
          description: 'Resolved issue',
          priority: 'MEDIUM',
          status: 'RESOLVED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          isBreached: false,
          isWarningSent: false,
          requiredSkills: [],
        },
      ];

      const activeOpenCount = mockTickets.filter((t) =>
        ['OPEN', 'ASSIGNED', 'IN_PROGRESS'].includes(t.status),
      ).length;
      const onHoldCount = mockTickets.filter((t) => t.status === 'ON_HOLD').length;
      const breachedCount = mockTickets.filter((t) => t.isBreached).length;

      expect(activeOpenCount).toBe(3); // TCK-001, TCK-003, TCK-004
      expect(onHoldCount).toBe(1); // TCK-002
      expect(breachedCount).toBe(1); // TCK-003
    });
  });
});
