import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { TicketPriority } from '@prisma/client';

export class ClaimNextTicketDto {
  @IsUUID('4')
  @IsOptional()
  agentId?: string;

  @IsEnum(TicketPriority)
  @IsOptional()
  preferredPriority?: TicketPriority;
}

export class ClaimSpecificTicketDto {
  @IsUUID('4')
  @IsOptional()
  agentId?: string;
}
