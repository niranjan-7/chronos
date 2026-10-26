import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class AgentSkillItemDto {
  @IsString()
  @IsNotEmpty()
  skill!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  proficiency!: number;
}

export class RegisterAgentSkillsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgentSkillItemDto)
  skills!: AgentSkillItemDto[];

  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  maxCapacity?: number;
}
