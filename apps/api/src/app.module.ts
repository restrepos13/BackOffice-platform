import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt.guard';
import { RolesGuard } from './auth/roles.guard';
import { UsersModule } from './modules/users.module';
import { PlansModule } from './modules/plans.module';
import { CompaniesModule } from './modules/companies.module';
import { BotsModule } from './modules/bots.module';
import { IntegrationsModule } from './modules/integrations.module';
import { ContactsModule } from './modules/contacts.module';
import { ConversationsModule } from './modules/conversations.module';
import { AutomationsModule } from './modules/automations.module';
import { MetricsModule } from './modules/metrics.module';
import { BillingModule } from './modules/billing.module';
import { AuditModule } from './modules/audit.module';
import { DevToolsModule } from './modules/devtools.module';
import { PersonasModule } from './modules/personas.module';
import { PaymentsModule } from './modules/payments.module';
import { EmailsModule } from './modules/emails.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    PlansModule,
    CompaniesModule,
    BotsModule,
    IntegrationsModule,
    ContactsModule,
    ConversationsModule,
    AutomationsModule,
    MetricsModule,
    BillingModule,
    AuditModule,
    DevToolsModule,
    PersonasModule,
    PaymentsModule,
    EmailsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
