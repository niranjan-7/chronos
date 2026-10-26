import { Controller, Get } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './common/database/prisma.service';

@Controller('health')
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  async health() {
    const isDbHealthy = await this.prisma.isHealthy();
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
      services: {
        database: isDbHealthy ? 'HEALTHY' : 'DOWN',
        engine: 'HEALTHY',
      },
    };
  }
}
