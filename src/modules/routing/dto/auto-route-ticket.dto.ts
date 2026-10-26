import { IsArray, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class AutoRouteTicketDto {
  @IsUUID('4')
  @IsNotEmpty()
  ticketId!: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  requiredSkills?: string[];
}
