import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Tenant } from '@prisma/client';
import { PrismaService } from '../../common/database/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async createTenant(dto: CreateTenantDto): Promise<Tenant> {
    const existing = await this.prisma.tenant.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new ConflictException(`Tenant with slug '${dto.slug}' already exists.`);
    }

    return this.prisma.tenant.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        config: (dto.config as Prisma.InputJsonValue) ?? {},
      },
    });
  }

  async getTenantById(id: string): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${id}' not found.`);
    }
    return tenant;
  }

  async getTenantBySlug(slug: string): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { slug },
    });
    if (!tenant) {
      throw new NotFoundException(`Tenant with slug '${slug}' not found.`);
    }
    return tenant;
  }

  async updateTenant(id: string, dto: UpdateTenantDto): Promise<Tenant> {
    await this.getTenantById(id);
    return this.prisma.tenant.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.config ? { config: dto.config as Prisma.InputJsonValue } : {}),
      },
    });
  }

  async listTenants(): Promise<Tenant[]> {
    return this.prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }
}
