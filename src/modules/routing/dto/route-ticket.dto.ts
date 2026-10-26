import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class RouteTicketDto {
  @IsUUID('4')
  @IsNotEmpty()
  ticketId!: string;

  @IsString({ each: true })
  @IsOptional()
  requiredSkills?: string[];
}
