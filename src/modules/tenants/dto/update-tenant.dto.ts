import { IsEnum, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { TenantStatus } from '@prisma/client';

export class UpdateTenantDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @IsEnum(TenantStatus)
  @IsOptional()
  status?: TenantStatus;

  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;
}
