import { Injectable, Logger } from '@nestjs/common';
import { TicketPriority } from '@prisma/client';
import { PrismaService } from '../../../common/database/prisma.service';

export interface SlaPolicyDefinition {
  priority: TicketPriority;
  name: string;
  description: string;
  responseTimeMinutes: number;
  resolutionTimeMinutes: number;
}

export const DEFAULT_SLA_POLICY_TEMPLATES: readonly SlaPolicyDefinition[] = [
  {
    priority: TicketPriority.URGENT,
    name: 'P1 - Critical Outage & Severe Impact',
    description: '15-minute first response, 60-minute resolution SLA',
    responseTimeMinutes: 15,
    resolutionTimeMinutes: 60,
  },
  {
    priority: TicketPriority.HIGH,
    name: 'P2 - High Severity & Degradation',
    description: '30-minute first response, 4-hour (240 min) resolution SLA',
    responseTimeMinutes: 30,
    resolutionTimeMinutes: 240,
  },
  {
    priority: TicketPriority.MEDIUM,
    name: 'P3 - Normal Standard Request',
    description: '60-minute first response, 8-hour (480 min) resolution SLA',
    responseTimeMinutes: 60,
    resolutionTimeMinutes: 480,
  },
  {
    priority: TicketPriority.LOW,
    name: 'P4 - Minor Inquiry & Backlog',
    description: '120-minute first response, 24-hour (1440 min) resolution SLA',
    responseTimeMinutes: 120,
    resolutionTimeMinutes: 1440,
  },
];

@Injectable()
export class SlaPolicyService {
  private readonly logger = new Logger(SlaPolicyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Automatically initializes default SLA policies for a tenant if none exist.
   */
  async ensureDefaultTenantPolicies(tenantId: string): Promise<void> {
    const count = await this.prisma.slaPolicy.count({
      where: { tenantId },
    });

    if (count === 0) {
      this.logger.log(`Provisioning default P1-P4 SLA policies for tenant ${tenantId}`);
      await Promise.all(
        DEFAULT_SLA_POLICY_TEMPLATES.map((tmpl) =>
          this.prisma.slaPolicy.create({
            data: {
              tenantId,
              name: tmpl.name,
              description: tmpl.description,
              priority: tmpl.priority,
              responseTimeMinutes: tmpl.responseTimeMinutes,
              resolutionTimeMinutes: tmpl.resolutionTimeMinutes,
              isActive: true,
              version: 1,
            },
          }),
        ),
      );
    }
  }

  /**
   * Resolves the active SLA policy for a given tenant and priority.
   */
  async resolvePolicyForTicket(
    tenantId: string,
    priority: TicketPriority,
    specificPolicyId?: string,
  ) {
    if (specificPolicyId) {
      const specific = await this.prisma.slaPolicy.findFirst({
        where: { id: specificPolicyId, tenantId, isActive: true },
      });
      if (specific) return specific;
    }

    let policy = await this.prisma.slaPolicy.findFirst({
      where: {
        tenantId,
        priority,
        isActive: true,
      },
      orderBy: { version: 'desc' },
    });

    if (!policy) {
      await this.ensureDefaultTenantPolicies(tenantId);
      policy = await this.prisma.slaPolicy.findFirst({
        where: {
          tenantId,
          priority,
          isActive: true,
        },
      });
    }

    return policy;
  }
}
