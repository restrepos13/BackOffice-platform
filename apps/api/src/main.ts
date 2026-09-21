import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  const port = Number(process.env.PORT ?? 4001);
  await app.listen(port);
  console.log(`[BackOffice API] escuchando en http://localhost:${port}/api`);
}
bootstrap();
