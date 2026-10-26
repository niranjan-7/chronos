import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { REDIS_CLIENT, RedisClientProvider } from './redis.provider';

@Global()
@Module({
  providers: [PrismaService, RedisClientProvider],
  exports: [PrismaService, REDIS_CLIENT, RedisClientProvider],
})
export class DatabaseModule {}
