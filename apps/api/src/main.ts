import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { BufferedLogger } from './common/log-buffer';

async function bootstrap() {
  // Nunca arrancar con un secreto JWT vacío: si falta, se genera uno efímero
  // (las sesiones mueren al reiniciar, pero jamás se firma con secreto conocido).
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    console.warn(
      '[seguridad] JWT_SECRET ausente o muy corto: se generó uno efímero. Define uno fuerte en .env',
    );
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new BufferedLogger(), // ring buffer consultable en Dev Tools
  });

  // Cabeceras de seguridad (API pura: sin CSP de documentos)
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // imágenes de galería servidas al front
    }),
  );
  app.disable('x-powered-by');

  // Límite de payload (los uploads de galería van por multer con su propio límite)
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

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
