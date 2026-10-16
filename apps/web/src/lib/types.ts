export type Role =
  | 'SUPER_ADMIN'
  | 'DEV'
  | 'COMPANY_ADMIN'
  | 'COMPANY_VIEWER'
  | 'COMPANY_AREA'
  | 'COMPANY_COURIER';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  companyId: string | null;
  company?: { id: string; name: string; slug: string; status: string } | null;
  jobTitle?: string | null;
  /** null/undefined = todavía no vio el tour de bienvenida */
  tourDoneAt?: string | null;
}

/* ─── Marketing ─────────────────────────────────────────────────────── */

export interface MarketingCampaign {
  id: string;
  companyId: string;
  name: string;
  objective?: string | null;
  status: 'BORRADOR' | 'ACTIVA' | 'PAUSADA' | 'CERRADA';
  channels: string[];
  startsAt?: string | null;
  endsAt?: string | null;
  budgetUsd?: number | null;
  notes?: string | null;
  pieceCount?: number;
  publishedCount?: number;
  createdAt: string;
}

export interface ContentPiece {
  id: string;
  companyId: string;
  campaignId?: string | null;
  type: 'REEL' | 'POST' | 'STORY' | 'AD';
  status: 'IDEA' | 'BORRADOR' | 'LISTO' | 'PROGRAMADO' | 'PUBLICADO';
  title: string;
  brief?: string | null;
  copy?: string | null;
  hashtags: string[];
  script?: string | null;
  channel?: string | null;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  videoJobId?: string | null;
  assetUrl?: string | null;
  createdAt: string;
}

export interface VideoJob {
  id: string;
  state: 'PENDIENTE' | 'PROCESANDO' | 'COMPLETO' | 'FALLIDO';
  progress: number;
  videoUrl?: string | null;
  error?: string | null;
}

export interface MarketingSummary {
  campañasActivas: number;
  piezas: Record<string, number>;
  totalPiezas: number;
  próximas: ContentPiece[];
  videoGeneratorReady: boolean;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  priceMonthly: number;
  maxBots: number;
  maxWorkspaces: number;
  maxUsers: number;
  features: string[];
  highlight: boolean;
  isCustom: boolean;
  active: boolean;
  /** IA de BackOffice: conversaciones incluidas al mes y precio del excedente (USD) */
  includedAiConversations?: number;
  extraAiConversationUsd?: number;
  /** Rubro: COMIDAS | WEBCAM | SERVICIOS | VENTAS; PRO = planes viejos en USD */
  line?: PlanLine;
  currency?: 'USD' | 'COP';
  maxLines?: number;
  maxCouriers?: number;
  minTermMonths?: number;
  setupFeeValue?: number;
  sortOrder?: number;
  _count?: { companies: number };
}

export type PlanLine = 'COMIDAS' | 'WEBCAM' | 'SERVICIOS' | 'VENTAS' | 'PRO';

export interface Company {
  id: string;
  name: string;
  slug: string;
  legalName?: string | null;
  industry?: string | null;
  country?: string | null;
  city?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  status: 'TRIAL' | 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  planId?: string | null;
  plan?: Plan | null;
  timezone: string;
  language: string;
  brandColor?: string | null;
  notes?: string | null;
  modules: string[];
  limits: Record<string, number>;
  /** Configuración del módulo de pedidos (agenda, reglas, plantillas, FAQs) */
  orderConfig?: Record<string, any>;
  waTemplates?: Array<{ key: string; contentSid: string; name?: string }>;
  currency?: string;
  /** BYOK DeepInfra: la llave nunca viaja completa */
  hasDeepinfraKey: boolean;
  deepinfraKeyMasked?: string | null;
  /** Quién paga la IA: llave propia (BYOK), la de BackOffice (PLATFORM) o las dos (HYBRID) */
  aiBillingMode?: AiMode;
  /** En HYBRID: cuál va primero (la otra queda de respaldo) */
  aiHybridPrimary?: 'BYOK' | 'PLATFORM';
  aiSpendCapUsd?: number | null;
  aiIncludedOverride?: number | null;
  logoUrl?: string | null;
  customPriceMonthly?: number | null;
  billingCycle?: 'MONTHLY' | 'ANNUAL';
  annualStartPeriod?: string | null;
  contractStartAt?: string | null;
  minTermMonths?: number | null;
  setupFeeValue?: number | null;
  googleReviewUrl?: string | null;
  paymentConfig?: PaymentConfig;
  einvoiceConfig?: EinvoiceConfig;
  /** Parámetros del Reporte a Gerencia */
  savingsSalaryUsd: number;
  agentCapacityPerMonth: number;
  trialEndsAt?: string | null;
  createdAt: string;
  users?: UserRow[];
  bots?: Bot[];
  integrations?: Integration[];
  _count?: Record<string, number>;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  companyId?: string | null;
  company?: { name: string; slug: string } | null;
  jobTitle?: string | null;
  phone?: string | null;
  active: boolean;
  lastLoginAt?: string | null;
  createdAt: string;
}

export interface Bot {
  id: string;
  companyId: string;
  company?: { name: string; slug: string };
  name: string;
  description?: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'DRAFT';
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  personality: Record<string, string>;
  memoryEnabled: boolean;
  welcomeMessage?: string | null;
  handoffKeywords?: string | null;
  replyDelayMinSec: number;
  replyDelayMaxSec: number;
  typingSimulation: boolean;
  /** Habilidades de venta: {goal, style, catalog, upsell, objections} */
  sales: Record<string, string>;
  /** ORDERS = pedidos estructurados (Nexus) · AGENT = agente con herramientas */
  engineMode?: 'ORDERS' | 'AGENT';
  /** Quién paga la IA de este asistente (INHERIT = lo de la empresa) */
  aiSource?: 'INHERIT' | AiMode;
  tools?: AgentToolGrant[];
  integrations?: Integration[];
  _count?: { conversations: number };
  createdAt: string;
}

export interface Integration {
  id: string;
  companyId: string;
  company?: { name: string; slug: string };
  botId?: string | null;
  bot?: { id: string; name: string; model?: string } | null;
  type: string;
  name: string;
  status: 'DISCONNECTED' | 'PENDING' | 'CONNECTED' | 'ERROR';
  config: Record<string, string>;
  connectUrl?: string | null;
  webhookUrl?: string | null;
  lastSyncAt?: string | null;
  errorMsg?: string | null;
  /** INHERIT = usa las instrucciones del bot · CUSTOM = instrucciones propias de la línea */
  promptMode: 'INHERIT' | 'CUSTOM';
  overridePrompt: string;
  overridePersonality: Record<string, string>;
  overrideWelcome?: string | null;
  overrideHandoff?: string | null;
  overrideModel?: string | null;
  overrideTemperature?: number | null;
  overrideReplyDelayMinSec?: number | null;
  overrideReplyDelayMaxSec?: number | null;
  overrideSales: Record<string, string>;
  _count?: { conversations: number };
}

export interface AiModel {
  id: string;
  provider: string;
  modelId: string;
  name: string;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  contextK: number;
  recommended: boolean;
  active: boolean;
  notes?: string | null;
}

export interface MediaAsset {
  id: string;
  companyId: string;
  integrationId?: string | null;
  integration?: { id: string; name: string } | null;
  name: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  priceUsd: number;
  tags: string[];
  active: boolean;
  timesSent: number;
  createdAt: string;
}

export interface PersonaTemplate {
  id: string;
  companyId?: string | null;
  company?: { name: string; slug: string } | null;
  name: string;
  category: string;
  description?: string | null;
  systemPrompt: string;
  personality: Record<string, string>;
  welcomeMessage?: string | null;
  handoffKeywords?: string | null;
}

export interface LineStat {
  id: string;
  name: string;
  status: string;
  promptMode: string;
  botName?: string | null;
  displayPhone: string;
  conversations: number;
  open: number;
  attention: number;
  messages30d: number;
}

export interface Contact {
  id: string;
  companyId: string;
  company?: { name: string; slug: string };
  name: string;
  phone?: string | null;
  email?: string | null;
  channel: string;
  /** Etapa del embudo (estándar o propio de la empresa) */
  stage: string;
  pipelineId?: string | null;
  optOut?: boolean;
  optOutAt?: string | null;
  externalId?: string | null;
  tags: string[];
  notes?: string | null;
  assignedTo?: { id: string; name: string } | null;
  lastActivityAt: string;
  createdAt: string;
  _count?: { conversations: number };
}

export interface Message {
  id: string;
  direction: 'IN' | 'OUT';
  author: 'CONTACT' | 'BOT' | 'AGENT';
  authorName?: string | null;
  content: string;
  type?: 'TEXT' | 'AUDIO' | 'IMAGE' | 'DOCUMENT' | 'LOCATION';
  fileName?: string | null;
  /** Ubicación compartida por WhatsApp */
  latitude?: number | null;
  longitude?: number | null;
  /** Lo que leyó la IA de una imagen (comprobantes) */
  analysisJson?: string | null;
  transcription?: string | null;
  deliveryStatus?: 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | null;
  metaCategory?: string | null;
  mediaAssetId?: string | null;
  mediaAsset?: { id: string; name: string; priceUsd: number; mimeType: string } | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  companyId: string;
  company?: { name: string; slug: string };
  channel: string;
  status: 'OPEN' | 'PENDING' | 'HANDOFF' | 'RESOLVED';
  needsAttention: boolean;
  /** Modo humano: la IA no interviene mientras esté en pausa */
  botPaused: boolean;
  attendedByName?: string | null;
  unreadCount: number;
  lastMessageAt: string;
  contact: Contact & { customer?: { id: string; name: string } | null };
  bot?: { id: string; name: string; model?: string } | null;
  integration?: { id: string; name: string } | null;
  messages: Message[];
}

/* ─── Módulo de pedidos (catering y afines) ───────────────────────── */

export interface Product {
  id: string;
  companyId: string;
  name: string;
  description?: string | null;
  category?: string | null;
  unit: string;
  presentations: string[];
  /** Precio unitario (moneda de la empresa). Vacío = "a confirmar" */
  price?: number | null;
  soldOut?: boolean;
  soldOutUntil?: string | null;
  imageFile?: string | null;
  productionAreaId?: string | null;
  productionArea?: { id: string; name: string } | null;
  active: boolean;
}

export interface ProductionArea {
  id: string;
  companyId: string;
  name: string;
  description?: string | null;
  responsibles: Array<{ name: string; phone?: string; email?: string }>;
  notifyChannel: 'PANEL' | 'EMAIL' | 'WHATSAPP';
  notifyTarget?: string | null;
  reminderHoursBefore: number;
  active: boolean;
}

export interface Customer {
  id: string;
  companyId: string;
  name: string;
  taxId?: string | null;
  notes?: string | null;
  addresses: Array<{ label: string; address: string; city?: string; instructions?: string }>;
  contacts?: Array<{ id: string; name: string; phone: string }>;
  active: boolean;
  _count?: { orders: number };
}

export interface OrderItem {
  id: string;
  orderId: string;
  productId?: string | null;
  productName: string;
  quantity: number;
  unit: string;
  presentation?: string | null;
  specifications?: string | null;
  observations?: string | null;
  productionAreaId?: string | null;
  productionArea?: { id: string; name: string } | null;
  areaStatus: 'pendiente' | 'listo';
}

export interface OrderStatusHistoryRow {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  authorType: 'IA' | 'USUARIO' | 'SISTEMA';
  authorName?: string | null;
  reason?: string | null;
  createdAt: string;
}

export interface Reminder {
  id: string;
  kind: string;
  channel: 'PANEL' | 'EMAIL' | 'WHATSAPP';
  target?: string | null;
  scheduledAt: string;
  status: 'PENDIENTE' | 'PROCESANDO' | 'ENVIADO' | 'FALLIDO' | 'CANCELADO';
  payloadJson?: string;
  order?: { id: string; customer?: { name: string } } | null;
}

export interface Order {
  id: string;
  companyId: string;
  customerId: string;
  customer: Customer | { id: string; name: string };
  contact?: { id: string; name: string; phone: string } | null;
  conversationId?: string | null;
  conversation?: { id: string; channel: string } | null;
  status: string;
  deliveryAt: string;
  deliveryAddressJson?: string;
  observations?: string | null;
  takenByType: 'IA' | 'HUMANO';
  takenByName?: string | null;
  aiConfidence?: number | null;
  correctedAfterAi: boolean;
  items: OrderItem[];
  statusHistory?: OrderStatusHistoryRow[];
  reminders?: Reminder[];
  feedback?: { rating: number; comment?: string | null } | null;
  /** Domicilios */
  code?: string;
  trackingUrl?: string | null;
  courierId?: string | null;
  courier?: {
    id: string; name: string; phone?: string | null; onShift: boolean;
    lastLat?: number | null; lastLng?: number | null; lastLocAt?: string | null;
  } | null;
  subtotal?: number | null;
  deliveryFee?: number | null;
  total?: number | null;
  distanceKm?: number | null;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  etaAt?: string | null;
  hasDeliveryProof?: boolean;
  source?: string;
  externalId?: string | null;
  discount?: number | null;
  couponCode?: string | null;
  paymentStatus?: 'NONE' | 'PENDING' | 'REPORTED' | 'PAID' | 'FAILED';
  paymentMethod?: string | null;
  paymentLinkUrl?: string | null;
  paidAt?: string | null;
  receiptMessageId?: string | null;
  receiptJson?: string | null;
  einvoiceStatus?: string | null;
  einvoiceNumber?: string | null;
  einvoiceError?: string | null;
  createdAt: string;
}

export interface OrdersCalendar {
  maxPerSlot: number | null;
  slots: Array<{ key: string; label: string; from: string; to: string }>;
  days: Array<{ date: string; total: number; orders: Order[] }>;
}

export interface AreaViewData {
  area: { id: string; name: string };
  items: Array<{
    id: string;
    orderId: string;
    orderStatus: string;
    deliveryAt: string;
    customer: string;
    productName: string;
    quantity: number;
    unit: string;
    presentation?: string | null;
    specifications?: string | null;
    observations?: string | null;
    areaStatus: 'pendiente' | 'listo';
    deliveryAddress?: { label?: string; address?: string; city?: string; instructions?: string };
  }>;
}

export interface ConsumptionBlock {
  meta: {
    byCategory: Array<{ category: string; count: number; costUsd: number; costCop?: number }>;
    totalMessages: number;
    costUsd: number;
    costCop?: number;
  };
  ai: {
    events: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    costCop?: number;
  };
  totalUsd: number;
  totalCop?: number;
}

/* ─── Reportes del módulo de pedidos (Fase 6) ───────────────────────── */

export interface DailyReportData {
  date: string;
  generatedAt: string;
  pedidos: {
    recibidos: number; confirmados: number; programados: number;
    despachados: number; entregados: number; cancelados: number;
  };
  conversaciones: {
    atendidas: number; escaladas: number;
    conIntervencionHumana: number; resueltasPorIA: number;
  };
  dudas: {
    pedidosBajaConfianza: Array<{ id: string; customer: string; status: string; aiConfidence: number; deliveryAt: string }>;
    escalamientos: Array<{ orderId: string; customer: string; reason?: string | null; authorType: string }>;
  };
  alertas: {
    pedidosSinConfirmar: Array<{ id: string; customer: string; createdAt: string; deliveryAt: string }>;
    entregasProximasSinArea: Array<{ id: string; customer: string; deliveryAt: string; itemsSinArea: string[] }>;
    recordatoriosFallidos: Array<{ id: string; kind: string; lastError?: string | null; orderId?: string | null }>;
    conversacionesSinRespuesta: number;
  };
  precisionIA: {
    dia: { total: number; corregidos: number; precisionPct: number | null };
    mes: { total: number; corregidos: number; precisionPct: number | null };
  };
  feedback: {
    respuestas: number;
    promedio: number | null;
    negativos: Array<{ customer: string; rating: number | null; comment?: string | null }>;
  };
}

export interface CompareBucket {
  label: string;
  from: string;
  pedidos: number;
  entregados: number;
  cancelados: number;
  cumplimientoPct: number | null;
  tomadosIA: number;
  precisionIAPct: number | null;
}

export interface AskResult {
  question: string;
  tool: string | null;
  params?: Record<string, any>;
  data: any;
  answer: string;
}

export interface FeedbackSummary {
  solicitados: number;
  respondidos: number;
  tasaRespuestaPct: number | null;
  promedio: number | null;
  distribution: Array<{ star: number; count: number }>;
  negativos: number;
  testimonios: Array<{ customer: string; rating: number | null; comment: string; orderId: string; respondedAt: string }>;
  recientes: Array<{ customer: string; rating: number | null; sentiment: string | null; comment?: string | null; orderId: string; respondedAt: string; alerted: boolean }>;
}

export interface MonthlyConsumption {
  month: string;
  currency: string;
  usdCopRate: number;
  current: ConsumptionBlock;
  previous: ConsumptionBlock;
  deltaPct: number | null;
  generatedAt: string;
}

export interface Automation {
  id: string;
  companyId: string;
  company?: { name: string; slug: string };
  name: string;
  description?: string | null;
  type: 'FLOW' | 'CONTENT' | 'REPORT' | 'INTERNAL';
  trigger?: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'DRAFT';
  lastRunAt?: string | null;
  runsCount: number;
  successRate: number;
  runs?: { id: string; status: string; startedAt: string }[];
}

export interface PlatformMetrics {
  kpis: {
    companies: number;
    activeCompanies: number;
    trialCompanies: number;
    suspendedCompanies: number;
    mrr: number;
    users: number;
    bots: number;
    messages30d: number;
    consumption30d: number;
    attention: number;
    openConversations: number;
  };
  series: { date: string; messages: number; aiCostUsd: number; waCostUsd: number }[];
  topCompanies: { companyId: string; name: string; messages: number; costUsd: number }[];
  plansDistribution: { plan: string; companies: number }[];
}

export interface CompanyMetrics {
  kpis: {
    conversationsToday: number;
    conversations7d: number;
    openConversations: number;
    attention: number;
    contacts: number;
    newContacts7d: number;
    hotLeads: number;
    clients: number;
    activeBots: number;
    activeAutomations: number;
    messages30d: number;
    consumption30d: number;
  };
  series: {
    date: string;
    messagesIn: number;
    messagesOut: number;
    aiCostUsd: number;
    waCostUsd: number;
    aiTokens: number;
  }[];
  channelBreakdown: { channel: string; count: number }[];
  lines: LineStat[];
  funnel: { stage: string; count: number }[];
  bots: { id: string; name: string; status: string }[];
}

export interface BillingSummary {
  period: string;
  company: { id: string; name: string; status: string };
  plan: { name: string; code: string; priceMonthly: number } | null;
  consumption: {
    ai: {
      costUsd: number; tokens: number;
      directBilled?: boolean; mode?: AiMode;
      conversations?: number; included?: number; extra?: number;
      extraPriceUsd?: number; extraChargeUsd?: number;
    };
    whatsapp: { costUsd: number; conversations: number };
    storage: { costUsd: number; mb: number };
    totalUsd: number;
  };
  totalUsd: number;
}

export interface Invoice {
  id: string;
  companyId: string;
  company?: { name: string; slug: string };
  period: string;
  planAmount: number;
  consumptionAmount: number;
  totalAmount: number;
  status: 'PAID' | 'PENDING' | 'OVERDUE';
  issuedAt: string;
  paidAt?: string | null;
}

export interface Payment {
  id: string;
  companyId: string;
  company?: { name: string; slug: string };
  invoiceId?: string | null;
  invoice?: { period: string } | null;
  provider: string;
  reference: string;
  amountUsd: number;
  amountInCents: number;
  currency: string;
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR';
  checkoutUrl?: string | null;
  providerTxId?: string | null;
  paymentMethod?: string | null;
  events: { at: string; status: string; verified: boolean }[];
  createdAt: string;
  configured?: boolean;
}

export interface EmailMessage {
  id: string;
  companyId?: string | null;
  company?: { name: string; slug: string } | null;
  toEmail: string;
  subject: string;
  body: string;
  status: 'QUEUED' | 'SENT' | 'FAILED';
  error?: string | null;
  actorName: string;
  sentAt?: string | null;
  createdAt: string;
}

export interface Appointment {
  id: string;
  companyId: string;
  contactId: string;
  contact: { id: string; name: string; phone?: string | null; stage: string };
  title: string;
  notes?: string | null;
  location?: string | null;
  startsAt: string;
  durationMin: number;
  status: 'SCHEDULED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  source: string;
  createdBy?: string | null;
}

export interface FollowUp {
  id: string;
  companyId: string;
  contactId: string;
  contact: { id: string; name: string; phone?: string | null; stage: string };
  note: string;
  dueAt: string;
  status: 'PENDING' | 'DONE' | 'CANCELLED';
  createdBy?: string | null;
  doneAt?: string | null;
}

export interface ExecutiveReport {
  generatedAt: string;
  company: { name: string };
  week: {
    conversations: number; conversationsPrev: number;
    messages: number; messagesPrev: number;
    newContacts: number; newContactsPrev: number;
    appointments: number; appointmentsPrev: number;
  };
  savings: {
    aiRepliesMonth: number;
    agentCapacityPerMonth: number;
    salaryUsd: number;
    salariesEquivalent: number;
    savedUsd: number;
    aiCostMonth: number;
  };
  areas: { area: string; ok: boolean; detail: string }[];
  attendanceRate: number | null;
  pending: {
    attention: number;
    overdueFollowUps: { id: string; note: string; dueAt: string; contact: string }[];
    upcomingAppointments: { id: string; title: string; startsAt: string; status: string; contact: string }[];
    staleHotLeads: { id: string; name: string; lastActivityAt: string }[];
  };
}

export interface AiUsageKpis {
  costRange: number;
  tokensIn?: number;
  tokensOut?: number;
  events: number;
  avgCostPerEvent?: number;
  avgDaily?: number;
  costMonth: number;
  projectedMonth: number;
  tokensMonth: number;
  eventsMonth: number;
  dayOfMonth: number;
  daysInMonth: number;
  companiesWithKey?: number;
  companies?: number;
}

export interface CompanyAiUsage {
  kpis: AiUsageKpis;
  hasDeepinfraKey: boolean;
  aiBillingMode?: AiMode;
  aiHybridPrimary?: 'BYOK' | 'PLATFORM';
  quota?: AiQuota | null;
  credits?: AiCredits | null;
  /** Lo que pagó la empresa con su llave vs. lo que puso BackOffice */
  byBilling?: Record<'BYOK' | 'PLATFORM', { costUsd: number; events: number }>;
  series: { date: string; costUsd: number; inputTokens: number; outputTokens: number; events: number }[];
  byModel: { model: string; costUsd: number; tokens: number; events: number }[];
  byLine: { integrationId: string | null; name: string; costUsd: number; tokens: number; events: number }[];
  lines: { id: string; name: string }[];
  lastEventAt?: string | null;
  generatedAt: string;
}

export interface PlatformAiUsage {
  kpis: AiUsageKpis;
  series: { date: string; costUsd: number; events: number }[];
  byCompany: {
    companyId: string; name: string; status: string; hasKey: boolean;
    costUsd: number; tokens: number; events: number;
    costMonth: number; projectedMonth: number;
  }[];
  generatedAt: string;
}

export interface AuditEntry {
  id: string;
  actorName: string;
  companyId?: string | null;
  company?: { name: string; slug: string } | null;
  action: string;
  entity: string;
  entityId?: string | null;
  detail?: string | null;
  createdAt: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  company?: { name: string; slug: string } | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  scopes?: string[];
  secret?: string;
}

/* ─── Agente con herramientas ─────────────────────────────────────── */

export type ToolAccess = 'read' | 'write';

export interface AgentToolGrant {
  tool: string;
  access: ToolAccess;
}

export interface AgentCatalog {
  tools: Array<{ name: string; access: ToolAccess; description: string }>;
  presets: Array<{ key: string; label: string; description: string; tools: AgentToolGrant[] }>;
}

/* ─── Domicilios ───────────────────────────────────────────────────── */

export interface DeliveryDestination {
  label: string | null;
  address: string | null;
  instructions: string | null;
  lat: number | null;
  lng: number | null;
}

export interface DeliveryBoard {
  origin: { lat: number; lng: number; address?: string } | null;
  deliveryEnabled: boolean;
  autoAssign?: boolean;
  branches?: Branch[];
  couriers: Array<{
    id: string; name: string; phone?: string | null; onShift: boolean;
    lastLat: number | null; lastLng: number | null; lastLocAt: string | null;
    activeOrders: number;
  }>;
  orders: Array<{
    id: string; code: string; status: string; deliveryAt: string; etaAt: string | null;
    dispatchedAt: string | null; deliveredAt: string | null; courierId: string | null;
    customer: string; phone: string | null; total: number | null; distanceKm: number | null;
    items: number; destination: DeliveryDestination;
    branchId?: string | null; delayed?: boolean; paymentStatus?: string | null;
  }>;
}

export interface CourierRoute {
  company: { name: string; brandColor?: string | null; logoUrl?: string | null; currency?: string };
  courier: { name: string; onShift: boolean; lastLocAt: string | null };
  origin: { lat: number; lng: number; address?: string } | null;
  routeUrl?: string | null;
  stops: Array<{
    id: string; code: string; status: string; deliveryAt: string; etaAt: string | null;
    customer: string; phone: string | null; total: number | null; observations?: string | null;
    sequence?: number | null; paymentStatus?: string | null; paymentMethod?: string | null;
    items: Array<{ productName: string; quantity: number; presentation?: string | null }>;
    destination: DeliveryDestination;
  }>;
}

export interface PublicTracking {
  company: { name: string; logoUrl?: string | null; brandColor?: string | null; whatsapp?: string | null; currency?: string };
  order: {
    code: string; status: string; statusLabel: string; cancelled: boolean; needsReview: boolean;
    deliveryAt: string; etaAt: string | null; deliveredAt: string | null;
    items: Array<{ productName: string; quantity: number; presentation?: string | null }>;
    subtotal: number | null; deliveryFee: number | null; total: number | null;
    address: string | null;
    timeline: Array<{ key: string; label: string; done: boolean; at: string | null }>;
    rated: boolean;
  };
  map: {
    destination: { lat: number; lng: number } | null;
    origin: { lat: number; lng: number } | null;
    courier: { lat: number; lng: number; updatedAt: string } | null;
  } | null;
  courier: { name: string } | null;
  expired: boolean;
}

export type AiMode = 'BYOK' | 'PLATFORM' | 'HYBRID';

export interface AiQuota {
  mode: AiMode;
  period: string;
  conversations: number;
  included: number;
  extra: number;
  extraPriceUsd: number;
  extraChargeUsd: number;
  spendUsd: number;
  capUsd: number | null;
  capPct: number | null;
  capReached: boolean;
}

/* ─── Cobro personalizable ─────────────────────────────────────────── */

export interface InvoiceLine {
  kind: 'PLAN' | 'CHARGE' | 'DISCOUNT' | 'WHATSAPP' | 'STORAGE' | 'SETUP';
  concept: string;
  amount: number;
}

export interface BillingAdjustment {
  id: string;
  companyId: string;
  kind: 'CHARGE' | 'DISCOUNT' | 'PRICE' | 'SETUP';
  concept: string;
  amount: number;
  percent: number | null;
  startPeriod: string;
  endPeriod: string | null;
  recurring: boolean;
  active: boolean;
  createdBy?: string | null;
  createdAt: string;
}

export interface ContractInfo {
  contractStartAt: string | null;
  minTermMonths: number;
  setupFeeValue: number;
  endsAt: string | null;
  inForce: boolean;
  earlyExit: { remainingMonths: number; amount: number };
}

export interface AiCredits {
  mode: AiMode;
  period: string;
  includedMonthly: number;
  includedUsed: number;
  includedLeft: number;
  balance: number;
  available: number;
  usedThisMonth: number;
  nextExpiry: string | null;
  lowBalance: boolean;
  spendUsd: number;
  capUsd: number | null;
  capPct: number | null;
  capReached: boolean;
}

export interface BillingSummaryV2 {
  period: string;
  currency: string;
  company: { id: string; name: string; status: string };
  plan: { name: string; code: string; line: string; priceMonthly: number; currency: string } | null;
  customPriceMonthly: number | null;
  billingCycle: 'MONTHLY' | 'ANNUAL';
  annualStartPeriod: string | null;
  nextAnnualCharge: string | null;
  lines: InvoiceLine[];
  planAmount: number;
  consumptionAmount: number;
  total: number;
  /** IVA incluido en el total (COP) */
  iva: number;
  consumption: {
    aiCostUsd: number; aiTokens: number; whatsappCostUsd: number; whatsappConversations: number;
    storageCostUsd: number; storageMb: number;
  };
  ai: AiCredits;
  contract: ContractInfo;
}

export interface InvoiceRow {
  id: string;
  companyId: string;
  company?: { name: string; slug: string };
  period: string;
  planAmount: number;
  consumptionAmount: number;
  totalAmount: number;
  currency: string;
  status: string;
  issuedAt: string;
  paidAt?: string | null;
  notes?: string | null;
  lines: InvoiceLine[];
  iva?: number;
}

export interface AiCreditPackage {
  id: string;
  name: string;
  conversations: number;
  price: number;
  currency: string;
  validityMonths: number;
  active: boolean;
  sortOrder: number;
}

export interface AiCreditLot {
  id: string;
  source: 'PURCHASE' | 'GRANT';
  total: number;
  remaining: number;
  expiresAt: string;
  note?: string | null;
  createdBy?: string | null;
  createdAt: string;
  expired: boolean;
}

export interface AiCreditsStatus {
  credits: AiCredits;
  lots: AiCreditLot[];
  recentUses: Array<{ id: string; conversationId: string | null; purpose: string; fromIncluded: boolean; createdAt: string }>;
  packages: AiCreditPackage[];
}

/* ─── Campañas ─────────────────────────────────────────────────────── */

export interface CampaignSegment {
  stages?: string[];
  tags?: string[];
  inactiveDays?: number;
  activeWithinDays?: number;
  productIds?: string[];
  customersOnly?: boolean;
  fromBroadcastId?: string;
  fromBroadcastFilter?: 'all' | 'no_reply';
}

export interface Broadcast {
  id: string;
  companyId: string;
  name: string;
  integrationId: string;
  segment: CampaignSegment;
  message: string;
  templateKey: string | null;
  status: 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELLED';
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  recipientsCount: number;
  estimatedCostUsd: number;
  createdBy: string | null;
  createdAt: string;
  stats?: {
    recipients: number; queued: number; skipped: number; sent: number; delivered: number;
    read: number; failed: number; replied: number; orders: number; revenue: number;
  };
  skipReasons?: string[];
}

export interface CampaignPreview {
  count: number;
  inWindow: number;
  outWindow: number;
  willSkip: number;
  estimatedCostUsd: number;
  sample: string[];
  templates: Array<{ key: string; name: string }>;
}

/* ─── Promociones, respuestas rápidas, embudos, conocimiento ──────── */

export interface Promotion {
  id: string;
  companyId: string;
  code: string | null;
  name: string;
  description: string | null;
  kind: 'PERCENT' | 'FIXED' | 'FREE_DELIVERY';
  value: number;
  minSubtotal: number | null;
  productIds: string[];
  startsAt: string | null;
  endsAt: string | null;
  maxUses: number | null;
  usedCount: number;
  public: boolean;
  active: boolean;
}

export interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  body: string;
}

export interface PipelineStage {
  key: string;
  label: string;
  kind: 'OPEN' | 'WON' | 'LOST';
}

export interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
  isDefault: boolean;
  builtIn?: boolean;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  source: 'TEXT' | 'URL' | 'PDF';
  url: string | null;
  status: string;
  chars: number;
  chunks: number;
  createdAt: string;
}

export interface Branch {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  phone: string | null;
  active: boolean;
}

export interface PaymentConfig {
  provider: string | null;
  env: 'test' | 'prod';
  publicKey: string | null;
  hasIntegritySecret: boolean;
  hasEventsSecret: boolean;
  onlineReady: boolean;
  manualInstructions: string | null;
  acceptCash: boolean;
  webhookUrl?: string;
}

export interface EinvoiceConfig {
  provider: 'ALEGRA' | 'SIMULADO' | null;
  email: string | null;
  hasToken: boolean;
  taxRate: number;
  alegraTaxId: number | null;
  alegraItemId: number | null;
  ready: boolean;
}

export interface PublicMenu {
  company: { name: string; slug: string; brandColor: string | null; logoUrl: string | null; city: string | null; currency: string };
  title: string | null;
  note: string | null;
  whatsapp: string | null;
  categories: Array<{
    name: string;
    items: Array<{ id: string; name: string; description: string | null; price: number | null; unit: string; presentations: string[]; soldOut: boolean; hasImage: boolean }>;
  }>;
  promotions: Array<{ name: string; description: string | null; code: string | null; kind: string; value: number }>;
}

export interface SetupProposal {
  products: Array<{ name: string; category: string | null; price: number | null; description: string | null; presentations: string[] }>;
  schedule: { days: number[]; open: string; close: string } | null;
  delivery: { enabled: boolean; baseFee: number | null; perKm: number | null; maxKm: number | null; prepMinutes: number | null } | null;
  faqs: Array<{ question: string; answer: string }>;
  assistant: { name: string; tone: string; style: string; welcome: string; instructions: string } | null;
}
