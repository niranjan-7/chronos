import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

// Polyfill BigInt serialization for Prisma BigInt fields
(BigInt.prototype as any).toJSON = function () {
  const intVal = Number(this);
  return Number.isSafeInteger(intVal) ? intVal : this.toString();
};

async function bootstrap() {
  const logger = new Logger('ChronosBootstrap');
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  // Global validation pipe with strict payload sanitization
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Enable CORS with tenant header exposure
  app.enableCors({
    origin: '*',
    exposedHeaders: ['x-tenant-id', 'x-request-id'],
  });

  // Enable graceful shutdown hooks for SIGINT/SIGTERM
  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`Chronos Core Orchestration Engine initialized and listening on port ${port}`);
}

void bootstrap();
