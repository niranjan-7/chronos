import { IsArray, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { RoutingMode, TicketPriority, TicketStatus } from '@prisma/client';

export class CreateTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsEnum(TicketPriority)
  @IsOptional()
  priority?: TicketPriority;

  @IsEnum(TicketStatus)
  @IsOptional()
  status?: TicketStatus;

  @IsEnum(RoutingMode)
  @IsOptional()
  routingMode?: RoutingMode;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  requiredSkills?: string[];

  @IsUUID('4')
  @IsOptional()
  assignedAgentId?: string;

  @IsUUID('4')
  @IsOptional()
  slaPolicyId?: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
