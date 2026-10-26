import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SlaPolicy } from '@prisma/client';
import { SlaRepository } from './repositories/sla.repository';
import { CreateSlaPolicyDto } from './dto/create-sla-policy.dto';

@Injectable()
export class SlaService {
  constructor(private readonly slaRepository: SlaRepository) {}

  async createPolicy(dto: CreateSlaPolicyDto): Promise<SlaPolicy> {
    return this.slaRepository.create<Prisma.SlaPolicyUncheckedCreateInput>({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        priority: dto.priority,
        responseTimeMinutes: dto.responseTimeMinutes,
        resolutionTimeMinutes: dto.resolutionTimeMinutes,
        isActive: dto.isActive ?? true,
        conditions: (dto.conditions as Prisma.InputJsonValue) ?? {},
      },
    });
  }

  async listPolicies(): Promise<SlaPolicy[]> {
    return this.slaRepository.findMany();
  }

  async getPolicyById(id: string): Promise<SlaPolicy> {
    const policy = await this.slaRepository.findById(id);
    if (!policy) {
      throw new NotFoundException(`SLA Policy '${id}' not found for current tenant.`);
    }
    return policy;
  }

  async updatePolicy(id: string, data: Partial<CreateSlaPolicyDto>): Promise<SlaPolicy> {
    await this.getPolicyById(id);
    return this.slaRepository.updateById(id, data as Record<string, unknown>);
  }
}
