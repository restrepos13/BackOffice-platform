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
    const value = doc[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
    } else if (typeof cond === 'object' && cond !== null && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('in' in cond && !cond.in.includes(value)) return false;
      if ('notIn' in cond && cond.notIn.includes(value)) return false;
      if ('gt' in cond && !(value > cond.gt)) return false;
      if ('contains' in cond && !(typeof value === 'string' && value.includes(cond.contains))) return false;
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

function sort(docs: Doc[], orderBy?: Doc): Doc[] {
  if (!orderBy) return docs;
  const [[field, dir]] = Object.entries(orderBy) as [string, 'asc' | 'desc'][];
  return [...docs].sort((a, b) => {
    const va = a[field] instanceof Date ? a[field].getTime() : a[field];
    const vb = b[field] instanceof Date ? b[field].getTime() : b[field];
    return (va < vb ? -1 : va > vb ? 1 : 0) * (dir === 'desc' ? -1 : 1);
  });
}

export function createMockPrisma() {
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
    socialUsage: [] as Doc[],
    invoice: [] as Doc[],
    usageRecord: [] as Doc[],
  };

  // Filtros por relación (where: { conversation: {...} }) — resueltos por FK
  const RELATION_FILTERS: Partial<Record<keyof typeof db, Array<{ key: string; fk: string; collection: keyof typeof db }>>> = {
    message: [{ key: 'conversation', fk: 'conversationId', collection: 'conversation' }],
    orderItem: [{ key: 'order', fk: 'orderId', collection: 'order' }],
    feedback: [{ key: 'order', fk: 'orderId', collection: 'order' }],
  };

  const name_isOrder = (doc: Doc) => db.order.includes(doc);
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
    if (include.conversation && doc.conversationId) {
      const conversation = db.conversation.find((c) => c.id === doc.conversationId) ?? null;
      out.conversation = conversation
        ? attach(conversation, include.conversation.include)
        : null;
    }
    return out;
  };

  const model = (name: keyof typeof db, defaults: Doc = {}) => {
    // matches + filtros por relación y claves compuestas (companyId_date)
    const match = (doc: Doc, where: Doc | undefined): boolean => {
      if (!where) return true;
      const rels = RELATION_FILTERS[name] ?? [];
      const plain: Doc = {};
      for (const [key, cond] of Object.entries(where)) {
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
      for (const row of data) db[name].push({ id: id(), createdAt: new Date(), ...defaults, ...row });
      return { count: data.length };
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
    user: model('user', { active: true, failedLogins: 0, lockedUntil: null }),
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
    socialUsage: model('socialUsage', { images: 0, videos: 0, credits: 0, costUsd: 0 }),
    invoice: model('invoice', { status: 'PENDING', currency: 'USD', linesJson: '[]' }),
    usageRecord: model('usageRecord'),
  };

  return { prisma, db };
}
