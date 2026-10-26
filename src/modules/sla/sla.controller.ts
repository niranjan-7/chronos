import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { SlaService } from './sla.service';
import { CreateSlaPolicyDto } from './dto/create-sla-policy.dto';

@Controller('sla/policies')
export class SlaController {
  constructor(private readonly slaService: SlaService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createPolicy(@Body() dto: CreateSlaPolicyDto) {
    return this.slaService.createPolicy(dto);
  }

  @Get()
  async listPolicies() {
    return this.slaService.listPolicies();
  }

  @Get(':id')
  async getPolicyById(@Param('id') id: string) {
    return this.slaService.getPolicyById(id);
  }

  @Patch(':id')
  async updatePolicy(
    @Param('id') id: string,
    @Body() dto: Partial<CreateSlaPolicyDto>,
  ) {
    return this.slaService.updatePolicy(id, dto);
  }
}
