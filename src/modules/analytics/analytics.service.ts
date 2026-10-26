import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../common/database/prisma.service';
import { AppClsStore } from '../../common/context/app-cls.store';
import { CLS_TENANT_ID } from '../../common/constants/context.constants';
import { TicketStatus } from '@prisma/client';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<AppClsStore>,
  ) {}

  async getTenantOverview() {
    const tenantId = this.cls.get(CLS_TENANT_ID);
    if (!tenantId) {
      throw new Error('Tenant context required for analytics.');
    }

    const now = new Date();

    const [
      totalTickets,
      openTickets,
      inProgressTickets,
      resolvedTickets,
      slaBreachedTickets,
      agentCount,
    ] = await Promise.all([
      this.prisma.ticket.count({ where: { tenantId } }),
      this.prisma.ticket.count({ where: { tenantId, status: TicketStatus.OPEN } }),
      this.prisma.ticket.count({ where: { tenantId, status: TicketStatus.IN_PROGRESS } }),
      this.prisma.ticket.count({ where: { tenantId, status: TicketStatus.RESOLVED } }),
      this.prisma.ticket.count({
        where: {
          tenantId,
          status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] },
          resolutionDueAt: { lt: now },
        },
      }),
      this.prisma.user.count({ where: { tenantId } }),
    ]);

    return {
      tenantId,
      timestamp: now.toISOString(),
      summary: {
        totalTickets,
        openTickets,
        inProgressTickets,
        resolvedTickets,
        slaBreachedTickets,
        totalAgents: agentCount,
      },
    };
  }
}
