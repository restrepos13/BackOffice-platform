import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { assertDatabaseAllowed } from '../common/runtime-env';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    // Antes de conectar: la base debe ser válida para este entorno (desarrollo nunca toca producción)
    const target = assertDatabaseAllowed();
    await this.$connect();
    // Y la base efectiva de la conexión debe ser la esperada
    const stats = (await this.$runCommandRaw({ dbStats: 1 })) as { db?: string };
    if (stats?.db && stats.db !== target.name) {
      throw new Error(`[entorno] la conexión quedó en «${stats.db}» y se esperaba «${target.name}»`);
    }
    new Logger('Database').log(`Base «${target.name}» en ${target.local ? 'servidor local' : target.host}`);
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
