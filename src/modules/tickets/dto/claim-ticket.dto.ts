import { IsArray, IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { TicketPriority } from '@prisma/client';

export class ClaimNextTicketDto {
  @IsUUID('all')
  @IsOptional()
  agentId?: string;

  @IsEnum(TicketPriority)
  @IsOptional()
  preferredPriority?: TicketPriority;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  requiredSkills?: string[];
}

export class ClaimSpecificTicketDto {
  @IsUUID('all')
  @IsOptional()
  agentId?: string;
}
