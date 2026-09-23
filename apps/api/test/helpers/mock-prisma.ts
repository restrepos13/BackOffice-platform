/**
 * Prisma en memoria para las pruebas del motor: colecciones simples con los
 * filtros exactos que usa el EngineService. No pretende ser un Prisma general.
 */

type Doc = Record<string, any>;

let seq = 0;
const id = () => `test_${++seq}`;

function matches(doc: Doc, where: Doc | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    const value = doc[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
    } else if (typeof cond === 'object' && cond !== null && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('in' in cond && !cond.in.includes(value)) return false;
      if ('gte' in cond && !(value >= cond.gte)) return false;
      if ('lte' in cond && !(value <= cond.lte)) return false;
      if ('lt' in cond && !(value < cond.lt)) return false;
      if ('not' in cond && value === cond.not) return false;
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
  };

  const attach = (doc: Doc, include?: Doc): Doc => {
    if (!include) return doc;
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
    return out;
  };

  const model = (name: keyof typeof db, defaults: Doc = {}) => ({
    findUnique: async ({ where, include }: Doc) => {
      const doc = db[name].find((d) => matches(d, where)) ?? null;
      return doc ? attach(doc, include) : null;
    },
    findFirst: async ({ where, include, orderBy }: Doc = {}) => {
      const doc = sort(db[name].filter((d) => matches(d, where)), orderBy)[0] ?? null;
      return doc ? attach(doc, include) : null;
    },
    findMany: async ({ where, include, orderBy, take }: Doc = {}) => {
      let docs = sort(db[name].filter((d) => matches(d, where)), orderBy);
      if (take) docs = docs.slice(0, take);
      return docs.map((d) => attach(d, include));
    },
    create: async ({ data }: Doc) => {
      const { items, ...plain } = data;
      const doc = { id: id(), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...plain };
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
      Object.assign(doc, plain, { updatedAt: new Date() });
      if (items?.create && name === 'order') {
        for (const item of items.create) {
          db.orderItem.push({ id: id(), orderId: doc.id, createdAt: new Date(), ...item });
        }
      }
      return { ...doc };
    },
    deleteMany: async ({ where }: Doc) => {
      const keep = db[name].filter((d) => !matches(d, where));
      const removed = db[name].length - keep.length;
      (db[name] as Doc[]).splice(0, db[name].length, ...keep);
      return { count: removed };
    },
  });

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
  };

  return { prisma, db };
}
