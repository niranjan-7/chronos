import { IsEnum, IsNotEmpty } from 'class-validator';
import { AgentStatus } from '@prisma/client';

export class UpdateAgentStatusDto {
  @IsEnum(AgentStatus)
  @IsNotEmpty()
  status!: AgentStatus;
}
