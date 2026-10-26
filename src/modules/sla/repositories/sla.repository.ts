import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma, SlaPolicy } from '@prisma/client';
import { PrismaService } from '../../../common/database/prisma.service';
import { TenantAwareRepository } from '../../../common/database/tenant-aware.repository';
import { AppClsStore } from '../../../common/context/app-cls.store';

@Injectable()
export class SlaRepository extends TenantAwareRepository<
  SlaPolicy,
  Prisma.SlaPolicyFindManyArgs,
  Prisma.SlaPolicyFindFirstArgs,
  Prisma.SlaPolicyCreateArgs,
  Prisma.SlaPolicyUpdateArgs,
  Prisma.SlaPolicyDeleteArgs
> {
  constructor(
    private readonly prisma: PrismaService,
    cls: ClsService<AppClsStore>,
  ) {
    super(prisma.slaPolicy, cls, 'SlaPolicy');
  }

  async getActivePolicies(): Promise<SlaPolicy[]> {
    const tenantId = this.getTenantId();
    return this.prisma.slaPolicy.findMany({
      where: {
        tenantId,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
