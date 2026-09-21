export type Role = 'SUPER_ADMIN' | 'DEV' | 'COMPANY_ADMIN' | 'COMPANY_VIEWER';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  companyId: string | null;
  company?: { id: string; name: string; slug: string; status: string } | null;
  jobTitle?: string | null;
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
  _count?: { companies: number };
}

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
  status: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
  planId?: string | null;
  plan?: Plan | null;
  timezone: string;
  language: string;
  brandColor?: string | null;
  notes?: string | null;
  modules: string[];
  limits: Record<string, number>;
  /** BYOK DeepInfra: la llave nunca viaja completa */
  hasDeepinfraKey: boolean;
  deepinfraKeyMasked?: string | null;
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
  stage: 'CURIOSO' | 'POTENCIAL' | 'CALIENTE' | 'CLIENTE' | 'DESCARTADO';
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
  content: string;
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
  unreadCount: number;
  lastMessageAt: string;
  contact: Contact;
  bot?: { id: string; name: string; model?: string } | null;
  integration?: { id: string; name: string } | null;
  messages: Message[];
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
    ai: { costUsd: number; tokens: number };
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
  secret?: string;
}
