import { IsArray, IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateWebhookSubscriptionDto {
  @IsUrl({ require_tld: false })
  @IsNotEmpty()
  url!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  secret!: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  events?: string[];
}
