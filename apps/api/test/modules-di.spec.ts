/**
 * Arma el contenedor de dependencias REAL de los módulos de Creative y Ads
 * (con una base simulada): detecta importaciones circulares o servicios sin
 * proveer que las pruebas unitarias no ven porque construyen las clases a mano.
 */
import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/prisma/prisma.service';
import { CreativeModule } from '../src/modules/creative.module';
import { CreativeCreateService } from '../src/modules/creative-create';
import { AdsModule } from '../src/modules/ads.module';
import { AdsCreateService } from '../src/modules/ads-create';
import { createMockPrisma } from './helpers/mock-prisma';

@Global()
@Module({ providers: [{ provide: PrismaService, useValue: createMockPrisma().prisma }], exports: [PrismaService] })
class FakePrismaModule {}

@Module({ imports: [FakePrismaModule, CreativeModule, AdsModule] })
class AppUnderTest {}

describe('inyección de dependencias', () => {
  it('Creative (con «Crear») y Ads (con «Crear anuncio») arrancan con todas sus dependencias', async () => {
    const app = await NestFactory.createApplicationContext(AppUnderTest, { logger: false, abortOnError: false });
    try {
      const create = app.get(CreativeCreateService);
      expect((create as any).creative).toBeDefined();
      expect((create as any).library).toBeDefined();
      expect((create as any).ai).toBeDefined();
      expect((app.get(AdsCreateService) as any).ai).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
