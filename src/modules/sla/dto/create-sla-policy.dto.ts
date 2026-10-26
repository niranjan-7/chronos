import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { TicketPriority } from '@prisma/client';

export class CreateSlaPolicyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsEnum(TicketPriority)
  priority!: TicketPriority;

  @IsInt()
  @Min(1)
  responseTimeMinutes!: number;

  @IsInt()
  @Min(1)
  resolutionTimeMinutes!: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsObject()
  @IsOptional()
  conditions?: Record<string, unknown>;
}
