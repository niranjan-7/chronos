import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { TicketPriority } from '@prisma/client';

export class ClaimNextTicketDto {
  @IsUUID('all')
  @IsOptional()
  agentId?: string;

  @IsEnum(TicketPriority)
  @IsOptional()
  preferredPriority?: TicketPriority;
}

export class ClaimSpecificTicketDto {
  @IsUUID('all')
  @IsOptional()
  agentId?: string;
}
