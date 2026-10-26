import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class UpdateWebhookEndpointDto {
  @IsUrl({ require_tld: false })
  @IsOptional()
  @MaxLength(1024)
  url?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  signingSecret?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  subscribedEvents?: string[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
