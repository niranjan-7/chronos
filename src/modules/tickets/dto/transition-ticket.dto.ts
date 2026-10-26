import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { TicketStatus } from '@prisma/client';

export class TransitionTicketDto {
  @IsEnum(TicketStatus)
  @IsNotEmpty()
  status!: TicketStatus;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;

  @IsUUID('4')
  @IsOptional()
  assignedAgentId?: string;
}
