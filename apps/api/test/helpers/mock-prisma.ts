/**
 * Prisma en memoria para las pruebas del motor: colecciones simples con los
 * filtros exactos que usa el EngineService. No pretende ser un Prisma general.
 */

type Doc = Record<string, any>;

let seq = 0;
const id = () => `test_${++seq}`;

/** Prisma IGNORA los campos undefined en create/update: el mock igual. */
function definedOnly(data: Doc): Doc {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
}

/** Igualdad como en Mongo: las fechas se comparan por valor. */
function sameValue(a: unknown, b: unknown): boolean {
  return a instanceof Date || b instanceof Date ? new Date(a as any).getTime() === new Date(b as any).getTime() : a === b;
}

function matches(doc: Doc, where: Doc | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Doc[]).some((w) => matches(doc, w))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Doc[]).every((w) => matches(doc, w))) return false;
      continue;
    }
    if (key === 'NOT') {
      const list = Array.isArray(cond) ? (cond as Doc[]) : [cond as Doc];
      if (list.some((w) => matches(doc, w))) return false;
      continue;
    }
    const value = doc[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
    } else if (typeof cond === 'object' && cond !== null && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('in' in cond && !cond.in.includes(value)) return false;
      if ('notIn' in cond && cond.notIn.includes(value)) return false;
      if ('gt' in cond && !(value > cond.gt)) return false;
      if ('contains' in cond && !(typeof value === 'string' && (cond.mode === 'insensitive' ? value.toLowerCase().includes(String(cond.contains).toLowerCase()) : value.includes(cond.contains)))) return false;
      if ('startsWith' in cond && !(typeof value === 'string' && value.startsWith(cond.startsWith))) return false;
      if ('gte' in cond && !(value >= cond.gte)) return false;
      if ('lte' in cond && !(value <= cond.lte)) return false;
      if ('lt' in cond && !(value < cond.lt)) return false;
      if ('not' in cond) {
        if (cond.not === null ? value === null || value === undefined : value === cond.not) return false;
      }
      if ('isSet' in cond) {
        const has = value !== undefined;
        if (cond.isSet !== has) return false;
      }
    } else if (cond instanceof Date) {
      if (new Date(value).getTime() !== cond.getTime()) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

function sort(docs: Doc[], orderBy?: Doc | Doc[]): Doc[] {
  if (!orderBy) return docs;
  // Varios criterios (orderBy: [{a: 'desc'}, {b: 'desc'}]) se aplican en orden
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o)) as [string, 'asc' | 'desc'][];
  return [...docs].sort((a, b) => {
    for (const [field, dir] of keys) {
      const va = a[field] instanceof Date ? a[field].getTime() : a[field];
      const vb = b[field] instanceof Date ? b[field].getTime() : b[field];
      const c = (va < vb ? -1 : va > vb ? 1 : 0) * (dir === 'desc' ? -1 : 1);
      if (c) return c;
    }
    return 0;
  });
}

/**
 * opts.atlasWithoutIndexes: simula la base compartida tal como está hoy (sin
 * los índices únicos declarados en Prisma). Solo `_id` es único, como en Mongo.
 */
export function createMockPrisma(opts: { atlasWithoutIndexes?: boolean } = {}) {
  const db = {
    company: [] as Doc[],
    bot: [] as Doc[],
    integration: [] as Doc[],
    contact: [] as Doc[],
    customer: [] as Doc[],
    conversation: [] as Doc[],
    message: [] as Doc[],
    order: [] as Doc[],
    orderItem: [] as Doc[],
    orderStatusHistory: [] as Doc[],
    product: [] as Doc[],
    aiModel: [] as Doc[],
    aiUsageEvent: [] as Doc[],
    productionArea: [] as Doc[],
    reminder: [] as Doc[],
    feedback: [] as Doc[],
    dailyReport: [] as Doc[],
    auditLog: [] as Doc[],
    user: [] as Doc[],
    marketingCampaign: [] as Doc[],
    contentPiece: [] as Doc[],
    videoJob: [] as Doc[],
    platformSetting: [] as Doc[],
    personaTemplate: [] as Doc[],
    plan: [] as Doc[],
    appointment: [] as Doc[],
    followUp: [] as Doc[],
    courierPing: [] as Doc[],
    aiCreditLot: [] as Doc[],
    aiCreditUse: [] as Doc[],
    aiCreditPackage: [] as Doc[],
    billingAdjustment: [] as Doc[],
    broadcast: [] as Doc[],
    broadcastRecipient: [] as Doc[],
    promotion: [] as Doc[],
    quickReply: [] as Doc[],
    branch: [] as Doc[],
    knowledgeDoc: [] as Doc[],
    knowledgeChunk: [] as Doc[],
    pipeline: [] as Doc[],
    payment: [] as Doc[],
    apiKey: [] as Doc[],
    inboundOrderKey: [] as Doc[],
    aiKeyUsage: [] as Doc[],
    signupSession: [] as Doc[],
    planOrder: [] as Doc[],
    incident: [] as Doc[],
    addonTouch: [] as Doc[],
    receivable: [] as Doc[],
    salesAudit: [] as Doc[],
    agentCall: [] as Doc[],
    healthSample: [] as Doc[],
    creativeWallet: [] as Doc[],
    creativeCreditMove: [] as Doc[],
    creativeDesignVersion: [] as Doc[],
    creativeDesign: [] as Doc[],
    brandAsset: [] as Doc[],
    adAssetLink: [] as Doc[],
    bookingLock: [] as Doc[],
    bookingNotice: [] as Doc[],
    calendarConnection: [] as Doc[],
    calendarEventLink: [] as Doc[],
    productionSettings: [] as Doc[],
    productionCounter: [] as Doc[],
    production: [] as Doc[],
    productionSourceKey: [] as Doc[],
    productionEvent: [] as Doc[],
    productionTask: [] as Doc[],
    productionResource: [] as Doc[],
    productionRate: [] as Doc[],
    productionAssignment: [] as Doc[],
    productionSlotLock: [] as Doc[],
    productionQuote: [] as Doc[],
    productionIssue: [] as Doc[],
    workflowRun: [] as Doc[],
    automation: [] as Doc[],
    automationVersion: [] as Doc[],
    authToken: [] as Doc[],
    emailMessage: [] as Doc[],
    brandProfile: [] as Doc[],
    socialUsage: [] as Doc[],
    invoice: [] as Doc[],
    usageRecord: [] as Doc[],
    adAccount: [] as Doc[],
    adEntity: [] as Doc[],
    adInsightDaily: [] as Doc[],
    adSyncRun: [] as Doc[],
    opportunity: [] as Doc[],
    creativeEvent: [] as Doc[],
    companyContext: [] as Doc[],
    adSettings: [] as Doc[],
    adRule: [] as Doc[],
    adActionLog: [] as Doc[],
    adBrief: [] as Doc[],
    adLead: [] as Doc[],
    conversationNote: [] as Doc[],
    inboundReceipt: [] as Doc[],
    subscriptionEvent: [] as Doc[],
    aiIncludedCounter: [] as Doc[],
  };

  // Filtros por relación (where: { conversation: {...} }) — resueltos por FK
  const RELATION_FILTERS: Partial<Record<keyof typeof db, Array<{ key: string; fk: string; collection: keyof typeof db }>>> = {
    message: [{ key: 'conversation', fk: 'conversationId', collection: 'conversation' }],
    conversation: [{ key: 'contact', fk: 'contactId', collection: 'contact' }],
    orderItem: [{ key: 'order', fk: 'orderId', collection: 'order' }],
    feedback: [{ key: 'order', fk: 'orderId', collection: 'order' }],
  };

  const name_isOrder = (doc: Doc) => db.order.includes(doc);
  const name_isConversation = (doc: Doc) => db.conversation.includes(doc);
  const attach = (doc: Doc, include?: Doc): Doc => {
    if (!include) return { ...doc }; // snapshot, como Prisma real
    const out = { ...doc };
    if (include.contact && doc.contactId) {
      const contact = db.contact.find((c) => c.id === doc.contactId) ?? null;
      out.contact = contact
        ? include.contact.include?.customer
          ? { ...contact, customer: db.customer.find((x) => x.id === contact.customerId) ?? null }
          : { ...contact }
        : null;
    }
    if (include.integration && doc.integrationId) {
      out.integration = db.integration.find((i) => i.id === doc.integrationId) ?? null;
    }
    if (include.plan && doc.planId) {
      out.plan = db.plan.find((p) => p.id === doc.planId) ?? null;
    }
    if (include.company) {
      out.company = db.company.find((c) => c.id === doc.companyId) ?? null;
    }
    if (include.items) {
      out.items = db.orderItem.filter((i) => i.orderId === doc.id);
    }
    if (include.statusHistory) {
      out.statusHistory = sort(
        db.orderStatusHistory.filter((h) => h.orderId === doc.id),
        { createdAt: 'asc' },
      );
    }
    if (include.feedback && name_isOrder(doc)) {
      out.feedback = db.feedback.find((f) => f.orderId === doc.id) ?? null;
    }
    if (include.customer && doc.customerId) {
      out.customer = db.customer.find((c) => c.id === doc.customerId) ?? null;
    }
    if (include.order && doc.orderId) {
      const order = db.order.find((o) => o.id === doc.orderId) ?? null;
      out.order = order
        ? (include.order.include || include.order.select
            ? attach(order, include.order.include)
            : { ...order })
        : null;
    }
    if (include.messages && name_isConversation(doc)) {
      const m = include.messages;
      let list = sort(db.message.filter((x) => x.conversationId === doc.id), m.orderBy);
      if (m.take) list = list.slice(0, m.take);
      out.messages = list.map((x) => ({ ...x }));
    }
    if (include.conversation && doc.conversationId) {
      const conversation = db.conversation.find((c) => c.id === doc.conversationId) ?? null;
      out.conversation = conversation
        ? attach(conversation, include.conversation.include)
        : null;
    }
    return out;
  };

  const UNIQUE: Record<string, string[]> = {
    creativeCreditMove: ['idempotencyKey'],
    brandProfile: ['companyId'],
    creativeWallet: ['companyId'],
    socialUsage: ['companyId+period'],
    opportunity: ['dedupeKey'],
    companyContext: ['companyId'],
    adActionLog: ['idempotencyKey'],
    adSettings: ['companyId'],
    adAccount: ['companyId+provider+externalId'],
    adAssetLink: ['assetId+adEntityId'],
    bookingLock: ['companyId+resourceId+slotStart'],
    bookingNotice: ['appointmentId+kind+scheduledAt'],
    calendarConnection: ['companyId'],
    productionSettings: ['companyId'],
    productionCounter: ['companyId'],
    production: ['companyId+code'],
    productionSourceKey: ['companyId+key'],
    productionTask: ['companyId+idempotencyKey'],
    productionSlotLock: ['companyId+resourceId+slotStart'],
    productionQuote: ['companyId+productionId+version'],
    workflowRun: ['companyId+idempotencyKey'],
    authToken: ['tokenHash'],
  };
  const model = (name: keyof typeof db, defaults: Doc = {}) => {
    // matches + filtros por relación y claves compuestas (companyId_date)
    const match = (doc: Doc, where: Doc | undefined): boolean => {
      if (!where) return true;
      const rels = RELATION_FILTERS[name] ?? [];
      const plain: Doc = {};
      for (const [key, cond] of Object.entries(where)) {
        // AND / OR / NOT pueden traer filtros por relación adentro
        if (key === 'AND') {
          if (!(cond as Doc[]).every((w) => match(doc, w))) return false;
          continue;
        }
        if (key === 'OR') {
          if (!(cond as Doc[]).some((w) => match(doc, w))) return false;
          continue;
        }
        // Conversación con algún mensaje que cumpla (messages: { some: … })
        if (name === 'conversation' && key === 'messages' && cond && typeof cond === 'object' && 'some' in (cond as Doc)) {
          if (!db.message.some((m) => m.conversationId === doc.id && matches(m, (cond as Doc).some))) return false;
          continue;
        }
        const rel = rels.find((r) => r.key === key);
        if (rel && cond && typeof cond === 'object') {
          const related = db[rel.collection].find((d) => d.id === doc[rel.fk]);
          if (!related || !matches(related, cond as Doc)) return false;
          continue;
        }
        // compuesta estilo {companyId_date: {companyId, date}}
        if (key.includes('_') && cond && typeof cond === 'object' && !('in' in cond) && !('gte' in cond)) {
          const parts = key.split('_');
          if (parts.every((p) => p in (cond as Doc))) {
            Object.assign(plain, cond);
            continue;
          }
        }
        plain[key] = cond;
      }
      return matches(doc, plain);
    };

    return {
    findUnique: async ({ where, include, select }: Doc) => {
      const doc = db[name].find((d) => match(d, where)) ?? null;
      return doc ? attach(doc, include ?? select) : null;
    },
    findUniqueOrThrow: async ({ where, include, select }: Doc) => {
      const doc = db[name].find((d) => match(d, where));
      if (!doc) throw new Error(`findUniqueOrThrow: no encontrado en ${name}`);
      return attach(doc, include ?? select);
    },
    updateMany: async ({ where, data }: Doc) => {
      const docs = db[name].filter((d) => match(d, where));
      for (const doc of docs) {
        const plain: Doc = { ...definedOnly(data) };
        for (const [key, value] of Object.entries(plain)) {
          if (value && typeof value === 'object' && !(value instanceof Date)) {
            if ('increment' in (value as Doc)) plain[key] = (doc[key] ?? 0) + (value as Doc).increment;
            if ('decrement' in (value as Doc)) plain[key] = (doc[key] ?? 0) - (value as Doc).decrement;
          }
        }
        Object.assign(doc, plain, { updatedAt: new Date() });
      }
      return { count: docs.length };
    },
    count: async ({ where }: Doc = {}) => db[name].filter((d) => match(d, where)).length,
    findFirst: async ({ where, include, select, orderBy }: Doc = {}) => {
      const doc = sort(db[name].filter((d) => match(d, where)), orderBy)[0] ?? null;
      return doc ? attach(doc, include ?? select) : null;
    },
    findMany: async ({ where, include, select, orderBy, take }: Doc = {}) => {
      let docs = sort(db[name].filter((d) => match(d, where)), orderBy);
      if (take) docs = docs.slice(0, take);
      return docs.map((d) => attach(d, include ?? select));
    },
    upsert: async ({ where, create, update }: Doc) => {
      const doc = db[name].find((d) => match(d, where));
      if (doc) {
        Object.assign(doc, update, { updatedAt: new Date() });
        return { ...doc };
      }
      const created = { id: id(), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...create };
      db[name].push(created);
      return { ...created };
    },
    create: async ({ data }: Doc) => {
      const { items, ...plain } = data;
      // _id siempre es único en Mongo
      if (plain.id != null && db[name].some((d: Doc) => d.id === plain.id)) {
        throw Object.assign(new Error(`Unique constraint failed on ${String(name)}._id_`), { code: 'P2002' });
      }
      // Índices únicos como en Mongo (P2002 si se repite)
      for (const key of opts.atlasWithoutIndexes ? [] : UNIQUE[name as string] ?? []) {
        const fields = key.split('+');
        if (fields.every((f) => plain[f] != null) && db[name].some((d: Doc) => fields.every((f) => sameValue(d[f], plain[f])))) {
          throw Object.assign(new Error(`Unique constraint failed on ${String(name)}.${key}`), { code: 'P2002' });
        }
      }
      const doc = { id: id(), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...definedOnly(plain) };
      db[name].push(doc);
      if (items?.create && name === 'order') {
        for (const item of items.create) {
          db.orderItem.push({ id: id(), orderId: doc.id, createdAt: new Date(), ...item });
        }
      }
      return { ...doc };
    },
    createMany: async ({ data }: Doc) => {
      // Como insertMany ordenado de Mongo: inserta hasta el primer _id repetido y falla
      let count = 0;
      for (const row of data) {
        if (row.id != null && db[name].some((d: Doc) => d.id === row.id)) {
          throw Object.assign(new Error(`Unique constraint failed on ${String(name)}._id_`), { code: 'P2002', inserted: count });
        }
        db[name].push({ id: id(), createdAt: new Date(), ...defaults, ...row });
        count++;
      }
      return { count };
    },
    update: async ({ where, data }: Doc) => {
      const doc = db[name].find((d) => matches(d, where));
      if (!doc) throw new Error(`update: no encontrado en ${name}`);
      const { items, ...plain } = data;
      for (const [key, value] of Object.entries(plain)) {
        if (value && typeof value === 'object' && 'increment' in (value as Doc)) {
          plain[key] = (doc[key] ?? 0) + (value as Doc).increment;
        }
      }
      Object.assign(doc, definedOnly(plain), { updatedAt: new Date() });
      if (items?.create && name === 'order') {
        for (const item of items.create) {
          db.orderItem.push({ id: id(), orderId: doc.id, createdAt: new Date(), ...item });
        }
      }
      return { ...doc };
    },
    delete: async ({ where }: Doc) => {
      const idx = db[name].findIndex((d) => match(d, where));
      if (idx === -1) throw new Error(`delete: no encontrado en ${name}`);
      const [doc] = db[name].splice(idx, 1);
      return { ...doc };
    },
    deleteMany: async ({ where }: Doc) => {
      const keep = db[name].filter((d) => !match(d, where));
      const removed = db[name].length - keep.length;
      (db[name] as Doc[]).splice(0, db[name].length, ...keep);
      return { count: removed };
    },
    };
  };

  const prisma = {
    company: model('company'),
    bot: model('bot'),
    integration: model('integration'),
    contact: model('contact'),
    customer: model('customer'),
    conversation: model('conversation', { botPaused: false, needsAttention: false, status: 'OPEN' }),
    message: model('message', { type: 'TEXT' }),
    order: model('order', { status: 'borrador', deletedAt: null }),
    orderItem: model('orderItem'),
    orderStatusHistory: model('orderStatusHistory'),
    product: model('product', { active: true, deletedAt: null }),
    aiModel: model('aiModel'),
    aiUsageEvent: model('aiUsageEvent'),
    productionArea: model('productionArea', { active: true, reminderHoursBefore: 24 }),
    reminder: model('reminder', { status: 'PENDIENTE', attempts: 0 }),
    feedback: model('feedback', { status: 'PENDIENTE', alerted: false, rating: null, respondedAt: null }),
    dailyReport: model('dailyReport'),
    auditLog: model('auditLog'),
    user: model('user', { active: true, failedLogins: 0, lockedUntil: null, sessionVersion: 0, mfaEnabled: false }),
    marketingCampaign: model('marketingCampaign', { status: 'BORRADOR', channelsJson: '[]' }),
    contentPiece: model('contentPiece', { status: 'IDEA', type: 'POST', hashtagsJson: '[]' }),
    videoJob: model('videoJob', { state: 'PENDIENTE', progress: 0, provider: 'MPT' }),
    platformSetting: model('platformSetting'),
    personaTemplate: model('personaTemplate', { personalityJson: '{}', category: 'General' }),
    plan: model('plan'),
    appointment: model('appointment', { status: 'SCHEDULED', source: 'MANUAL' }),
    followUp: model('followUp', { status: 'PENDING' }),
    courierPing: model('courierPing'),
    aiCreditLot: model('aiCreditLot', { alertedLow: false, alertedEmpty: false }),
    aiCreditUse: model('aiCreditUse', { fromIncluded: false, purpose: 'CHAT' }),
    aiCreditPackage: model('aiCreditPackage', { active: true, currency: 'COP', validityMonths: 12, sortOrder: 0 }),
    billingAdjustment: model('billingAdjustment', { active: true, recurring: false }),
    broadcast: model('broadcast', { status: 'DRAFT', recipientsCount: 0, estimatedCostUsd: 0 }),
    broadcastRecipient: model('broadcastRecipient', { status: 'PENDING' }),
    promotion: model('promotion', { usedCount: 0, active: true, public: true, productIdsJson: '[]' }),
    quickReply: model('quickReply'),
    branch: model('branch', { active: true }),
    knowledgeDoc: model('knowledgeDoc', { status: 'READY' }),
    knowledgeChunk: model('knowledgeChunk'),
    pipeline: model('pipeline', { isDefault: false }),
    payment: model('payment', { status: 'PENDING', eventsLog: '[]', purpose: 'INVOICE', metaJson: '{}' }),
    apiKey: model('apiKey', { scopesJson: '[]', revokedAt: null }),
    inboundOrderKey: model('inboundOrderKey'),
    aiKeyUsage: model('aiKeyUsage', { requests: 0, tokens: 0, exhaustedAt: null }),
    signupSession: model('signupSession', { step: 'STARTED', answers: 0, aiCalls: 0, aiTokens: 0, followStatus: 'NEW' }),
    incident: model('incident', { count: 1 }),
    addonTouch: model('addonTouch', { status: 'SENT', step: 1 }),
    receivable: model('receivable', { status: 'PENDING', remindersSent: 0 }),
    salesAudit: model('salesAudit', { source: 'REGLAS', tokens: 0, examplesJson: '[]' }),
    agentCall: model('agentCall', { status: 'REQUESTED' }),
    healthSample: model('healthSample'),
    creativeWallet: model('creativeWallet', { extraCredits: 0 }),
    creativeCreditMove: model('creativeCreditMove', { bucket: 'MONTHLY' }),
    creativeDesignVersion: model('creativeDesignVersion'),
    creativeDesign: model('creativeDesign', { status: 'ACTIVE', schemaVersion: 1, version: 1 }),
    brandAsset: model('brandAsset'),
    adAssetLink: model('adAssetLink'),
    bookingLock: model('bookingLock'),
    bookingNotice: model('bookingNotice', { status: 'PENDING', attempts: 0 }),
    calendarConnection: model('calendarConnection', { direction: 'BOTH', blockResourceIdsJson: '[]', allDayBlocks: true, importTitles: false, failureCount: 0 }),
    calendarEventLink: model('calendarEventLink', { status: 'ACTIVE', allDay: false, busy: true, attempts: 0 }),
    brandProfile: model('brandProfile', { version: 1, logosJson: '[]', colorsJson: '[]', fontsJson: '[]', vocabularyJson: '[]', avoidWordsJson: '[]', productsJson: '[]', ctasJson: '[]', offersJson: '[]', restrictionsJson: '[]', formatsJson: '[]', protectedJson: '{}', policyJson: '{}' }),
    planOrder: model('planOrder', { status: 'REQUESTED', aiPackageAmount: 0, currency: 'COP', billingCycle: 'MONTHLY' }),
    socialUsage: model('socialUsage', { images: 0, videos: 0, credits: 0, costUsd: 0 }),
    invoice: model('invoice', { status: 'PENDING', currency: 'USD', linesJson: '[]' }),
    usageRecord: model('usageRecord'),
    adAccount: model('adAccount', { mode: 'REAL', status: 'CONNECTED', scopesJson: '[]', lastSyncAt: null, tokenEnc: null, timezone: null }),
    adEntity: model('adEntity', { mode: 'REAL', issuesJson: '[]', rawJson: '{}' }),
    adInsightDaily: model('adInsightDaily', { mode: 'REAL', rawJson: '{}' }),
    adSyncRun: model('adSyncRun', { status: 'RUNNING', countsJson: '{}' }),
    opportunity: model('opportunity', { mode: 'REAL', status: 'NEW', evidenceJson: '{}', sourcesJson: '[]', periodJson: '{}', actionJson: '{}', decisionsJson: '[]', actedAt: null, snoozedUntil: null }),
    creativeEvent: model('creativeEvent', { dataJson: '{}' }),
    companyContext: model('companyContext', { overridesJson: '{}', preferencesJson: '{}', progressJson: '{}' }),
    adSettings: model('adSettings', { autonomy: 'ANALYSIS', globalPause: false, autoActionsJson: '[]', maxDailyBudget: null, maxDataAgeHours: 6 }),
    adRule: model('adRule', { active: true, minSpend: 0, checkEveryMin: 60, lastRunAt: null, operator: 'GT', level: 'CAMPAIGN', action: 'ALERT', risk: 'LOW' }),
    adActionLog: model('adActionLog', { mode: 'REAL', dataJson: '{}', reversible: false }),
    adBrief: model('adBrief', { status: 'DRAFT' }),
    adLead: model('adLead', { status: 'RECEIVED', fieldNamesJson: '[]' }),
    conversationNote: model('conversationNote'),
    inboundReceipt: model('inboundReceipt'),
    subscriptionEvent: model('subscriptionEvent', { refsJson: '{}' }),
    aiIncludedCounter: model('aiIncludedCounter', { used: 0 }),
    productionSettings: model('productionSettings', { configJson: '{}' }),
    productionCounter: model('productionCounter', { seq: 0 }),
    production: model('production', { status: 'NUEVA', version: 1, priority: 'NORMAL', channel: 'OTHER', briefJson: '{}', isTest: false }),
    productionSourceKey: model('productionSourceKey', {}),
    productionEvent: model('productionEvent', { actorType: 'USER' }),
    productionTask: model('productionTask', { status: 'TODO', priority: 'NORMAL', dependsOnJson: '[]', origin: 'MANUAL' }),
    productionResource: model('productionResource', { active: true, owned: false, attrsJson: '{}', fileRefsJson: '[]' }),
    productionRate: model('productionRate', { currency: 'COP', status: 'PENDING' }),
    productionAssignment: model('productionAssignment', { role: 'CANDIDATE', availability: 'NOT_CHECKED', reservation: 'NONE', version: 1 }),
    productionSlotLock: model('productionSlotLock', {}),
    productionQuote: model('productionQuote', { status: 'DRAFT', currency: 'COP', linesJson: '[]', totalsJson: '{}' }),
    productionIssue: model('productionIssue', { status: 'OPEN', severity: 'MEDIUM' }),
    authToken: model('authToken', { usedAt: null, revokedAt: null }),
    emailMessage: model('emailMessage', { status: 'QUEUED' }),
    workflowRun: model('workflowRun', { status: 'PENDING', attempts: 0, maxAttempts: 5, payloadJson: '{}' }),
    automation: model('automation', { status: 'DRAFT', configJson: '{}', version: 0, type: 'FLOW', runsCount: 0, successRate: 100 }),
    automationVersion: model('automationVersion'),
  };

  return { prisma, db };
}
