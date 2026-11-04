import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { BufferedLogger } from './common/log-buffer';
import { perfMiddleware } from './common/perf-monitor';
import { SharePreviewService } from './modules/share-preview.module';

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
  // Medidor interno de velocidad y errores (Plataforma → Salud)
  app.use(perfMiddleware);

  // IP real del visitante detrás de proxies (límites por IP): Render = 1 salto,
  // Vercel → Render = 2. Sin la variable no se confía en X-Forwarded-For.
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (hops > 0) app.set('trust proxy', hops);
  else if (process.env.RENDER === 'true') {
    // Sin esto, todos los visitantes comparten la IP del proxy: los límites "por IP"
    // (login, registro) se vuelven un solo cupo global y la fuerza bruta no se frena bien
    console.warn('[seguridad] TRUST_PROXY_HOPS no está configurado en producción: los límites por IP no distinguen visitantes');
  }

  // Límite de payload (los uploads de galería van por multer con su propio límite)
  // El cuerpo crudo se guarda para verificar firmas de webhooks (Meta)
  app.use(json({ limit: '1mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.enableCors({
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  // Producción (Render): el mismo servicio sirve la web compilada; todo lo que no
  // es /api cae en index.html (rutas del panel, /t/…, /m/…, /registro), con la
  // vista previa para WhatsApp/redes ya escrita en el <head> según la ruta.
  const webDist = resolve(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(join(webDist, 'index.html'))) {
    // app.html = la app vacía; index.html y <ruta>.html = páginas públicas
    // prerenderizadas al compilar (apps/web/scripts/prerender.mjs)
    const shellFile = existsSync(join(webDist, 'app.html')) ? 'app.html' : 'index.html';
    const indexHtml = readFileSync(join(webDist, shellFile), 'utf8');
    const prerendered = new Map<string, string>();
    const prerenderedFor = (path: string): string | null => {
      if (shellFile !== 'app.html') return null;
      const clean = path.replace(/\/+$/, '') || '/';
      if (clean === '/app' || (clean !== '/' && !/^\/[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(clean))) return null;
      const cached = prerendered.get(clean);
      if (cached) return cached;
      // Solo se guardan las que existen: rutas inventadas no llenan la memoria
      const file = join(webDist, clean === '/' ? 'index.html' : `${clean.slice(1)}.html`);
      if (!existsSync(file)) return null;
      const html = readFileSync(file, 'utf8');
      prerendered.set(clean, html);
      return html;
    };
    const previews = app.get(SharePreviewService);
    app.useStaticAssets(webDist, { index: false, maxAge: '1h' });
    app.use(async (req: any, res: any, next: any) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      const page = prerenderedFor(req.path);
      if (page) {
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
        return res.type('html').send(page);
      }
      let html = indexHtml;
      try {
        html = await previews.render(indexHtml, req.path);
      } catch {
        /* sin vista previa: igual se sirve la página */
      }
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
      res.type('html').send(html);
    });
  }
  const port = Number(process.env.PORT ?? 4001);
  await app.listen(port);
  console.log(`[BackOffice API] escuchando en http://localhost:${port}/api`);
}
bootstrap();
