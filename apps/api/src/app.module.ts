import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
import { AiModelsModule } from './modules/aimodels.module';
import { AiUsageModule } from './modules/aiusage.module';
import { MediaModule } from './modules/media.module';
import { OpsModule } from './modules/ops.module';
import { JobsModule } from './modules/jobs.module';
import { WebhooksModule } from './modules/webhooks.module';
import { EngineModule } from './modules/engine.module';
import { QueueModule } from './queue/queue.module';
import { TwilioModule } from './modules/twilio.module';
import { OrdersModule } from './modules/orders.module';
import { CatalogModule } from './modules/catalog.module';
import { EventsModule } from './modules/events.module';
import { ReportsModule } from './modules/reports.module';
import { DeliveryModule } from './modules/delivery.module';
import { AiCreditsModule } from './modules/ai-credits.module';
import { CampaignsModule } from './modules/campaigns.module';
import { PromotionsModule } from './modules/promotions.module';
import { KnowledgeModule } from './modules/knowledge.module';
import { PipelinesModule } from './modules/pipelines.module';
import { MenuModule } from './modules/menu.module';
import { SharePreviewModule } from './modules/share-preview.module';
import { AiCostModule } from './modules/ai-cost.module';
import { TermsModule } from './modules/terms.module';
import { CheckoutModule } from './modules/checkout.module';
import { MetaAdsModule } from './modules/meta-ads.module';
import { IncidentsModule } from './modules/incidents.module';
import { CommerceModule } from './modules/commerce.module';
import { AddonEnginesModule } from './modules/addons/addon-engines.module';
import { AgentCallsModule } from './modules/agent-calls.module';
import { DataExportModule } from './modules/data-export.module';
import { PlatformHealthModule } from './modules/platform-health.module';
import { AdsModule } from './modules/ads.module';
import { OpportunitiesModule } from './modules/opportunities.module';
import { CreativeModule } from './modules/creative.module';
import { InboundOrdersModule } from './modules/inbound-orders.module';
import { AiSetupModule } from './modules/ai-setup.module';
import { SignupModule } from './modules/signup.module';
import { SocialModule } from './modules/social.module';
import { MarketingModule } from './modules/marketing.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting global: 200 peticiones/min por IP (el login tiene su propio límite)
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),
    ScheduleModule.forRoot(),
    QueueModule,
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
    AiModelsModule,
    AiUsageModule,
    MediaModule,
    OpsModule,
    JobsModule,
    WebhooksModule,
    EngineModule,
    TwilioModule,
    OrdersModule,
    CatalogModule,
    EventsModule,
    ReportsModule,
    DeliveryModule,
    AiCreditsModule,
    CampaignsModule,
    PromotionsModule,
    KnowledgeModule,
    PipelinesModule,
    MenuModule,
    SharePreviewModule,
    AiCostModule,
    TermsModule,
    CheckoutModule,
    MetaAdsModule,
    IncidentsModule,
    CommerceModule,
    AddonEnginesModule,
    AgentCallsModule,
    DataExportModule,
    PlatformHealthModule,
    CreativeModule,
    AdsModule,
    OpportunitiesModule,
    InboundOrdersModule,
    AiSetupModule,
    SignupModule,
    SocialModule,
    MarketingModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
