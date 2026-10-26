import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(appOrHttpServer: INestApplicationContext | any) {
    super(appOrHttpServer);
  }

  /**
   * Initializes Redis Pub/Sub clients using ioredis and connects them to the
   * Socket.IO distributed Redis adapter.
   */
  async connectToRedis(configService: ConfigService): Promise<void> {
    try {
      const host = configService.get<string>('REDIS_HOST', 'localhost');
      const port = configService.get<number>('REDIS_PORT', 6379);
      const password = configService.get<string>('REDIS_PASSWORD', 'redis_secret');

      this.pubClient = new Redis({
        host,
        port,
        password,
        lazyConnect: false,
        maxRetriesPerRequest: null,
      });

      this.subClient = this.pubClient.duplicate();

      this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
      this.logger.log(`[RedisIoAdapter] Connected to Redis Pub/Sub at ${host}:${port}`);
    } catch (err: any) {
      this.logger.error(
        `[RedisIoAdapter] Failed to connect Redis Pub/Sub: ${err.message}. Falling back to default adapter.`,
      );
    }
  }

  override createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  /**
   * Gracefully closes Redis pub/sub connections on shutdown.
   */
  async close(): Promise<void> {
    if (this.pubClient) {
      await this.pubClient.quit().catch(() => {});
    }
    if (this.subClient) {
      await this.subClient.quit().catch(() => {});
    }
  }
}
