import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson } from '../common/constants';
import { decryptSecret, isEncrypted } from '../common/crypto';
import { entryStageFor } from '../common/pipelines';
import { contactCreated } from '../common/domain-events';
import { LeadgenEvent, contactFromFields, leadDocId } from '../common/ads/leads';
import { META_LEADS_SCOPE, META_LEADS_SCOPES, MetaAdsProvider } from '../common/ads/meta-ads-provider';
import type { FetchLike } from '../common/ads/provider';

/**
 * Leads de formularios de Meta (Lead Ads).
 *  - Se aceptan solo para páginas conectadas a la empresa del webhook.
 *  - El _id sale del leadgen_id: los reintentos de Meta no duplican nada.
 *  - Dos caminos: el aviso de Meta (webhook «leadgen») y la importación
 *    directa por anuncio con el acceso de la cuenta publicitaria, cada
 *    10 minutos. La segunda no depende de que la página esté suscrita.
 *  - Los datos personales se piden a Graph con el token de la página o el de
 *    la cuenta publicitaria; sin `leads_retrieval` el lead queda en
 *    PENDING_PERMISSION con sus IDs (sirven para atribuir) y no se crea
 *    ningún contacto inventado. Al llegar el permiso se completan solos.
 *  - El contacto conserva su primer origen; si es nuevo, el origen es el
 *    formulario (ID del anuncio incluido).
 */

const PAGE_TYPES = ['META_SOCIAL', 'MESSENGER', 'INSTAGRAM'];
/** Cada cuánto se revisan los formularios nuevos (minutos). */
export const LEAD_IMPORT_EVERY_MIN = 10;
/** Primera importación: Meta conserva los leads 90 días; se traen los de los últimos 60 (lo mismo que las métricas). */
const FIRST_IMPORT_DAYS = 60;
/** Se vuelve a mirar un rato antes de la última importación: Meta puede tardar en listar un lead recién creado. */
const OVERLAP_MS = 30 * 60e3;
const ADS_PER_RUN = 40;
const RETRY_MAX = 50;
const NO_PERMISSION = 'Para leer los formularios hace falta el permiso leads_retrieval en la conexión con Meta. Los leads quedan registrados con sus IDs y se completan apenas esté.';
const DENIED = 'Meta no entregó los datos: falta el permiso leads_retrieval (App Review) o la conexión venció.';
const importKey = (accountId: string) => `ads:leads:import:${accountId}`;

export interface LeadImportResult {
  at: string;
  /** OK | NO_PERMISSION | ERROR */
  status: 'OK' | 'NO_PERMISSION' | 'ERROR';
  /** Anuncios consultados */
  ads: number;
  /** Leads que devolvió Meta */
  found: number;
  /** Leads nuevos guardados */
  created: number;
  /** Contactos creados o unidos */
  contacts: number;
  /** Leads que estaban esperando permiso y se completaron */
  retried: number;
  /** Quedó algo por traer (se sigue en la próxima) */
  more: boolean;
  error: string | null;
  /** Hasta cuándo está al día (solo avanza con una importación completa) */
  cursor: string | null;
}

@Injectable()
export class AdLeadsService {
  private readonly logger = new Logger('AdLeads');
  fetchImpl: FetchLike = (u, i) => fetch(u, i) as any;
  now: () => Date = () => new Date();

  constructor(private readonly prisma: PrismaService) {}

  /** Páginas de la empresa con su token (si lo hay). Nunca sale del servidor. */
  private async pages(companyId: string) {
    const rows = await this.prisma.integration.findMany({ where: { companyId, type: { in: PAGE_TYPES } } });
    return rows.map((r) => {
      const cfg = parseJson<Record<string, any>>(r.configJson, {});
      let token: string | null = null;
      if (isEncrypted(cfg.accessTokenEnc)) {
        try {
          token = decryptSecret(cfg.accessTokenEnc);
        } catch {
          token = null;
        }
      }
      return { pageId: String(cfg.pageId ?? ''), token };
    }).filter((p) => p.pageId);
  }

  async ingest(companyId: string, events: LeadgenEvent[]) {
    const pages = await this.pages(companyId);
    const out = { stored: 0, duplicates: 0, ignored: 0 };
    for (const ev of events) {
      // Una página que la empresa no conectó no se le atribuye (podría ser de otra)
      if (!pages.some((p) => p.pageId === ev.pageId)) {
        out.ignored++;
        this.logger.warn(`Lead ${ev.leadgenId} de una página no conectada en la empresa ${companyId}`);
        continue;
      }
      const id = leadDocId(ev.leadgenId);
      const existing = await this.prisma.adLead.findUnique({ where: { id } });
      if (existing) {
        if (existing.companyId !== companyId) {
          out.ignored++;
          continue;
        }
        out.duplicates++;
        if (existing.status !== 'FETCHED') await this.fetch(companyId, id);
        continue;
      }
      // El conjunto y la campaña salen del anuncio sincronizado (si está)
      const ad = ev.adId ? await this.prisma.adEntity.findFirst({ where: { companyId, level: 'AD', externalId: ev.adId } }) : null;
      try {
        await this.prisma.adLead.create({
          data: {
            id, companyId, leadgenId: ev.leadgenId, pageId: ev.pageId, formId: ev.formId, adId: ev.adId,
            adsetId: ev.adsetId ?? ad?.adsetExternalId ?? null, campaignId: ad?.campaignExternalId ?? null,
            status: 'RECEIVED', fieldNamesJson: '[]', leadCreatedAt: ev.createdTime, receivedAt: this.now(),
          },
        });
        out.stored++;
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err;
        out.duplicates++;
        continue;
      }
      await this.fetch(companyId, id);
    }
    return out;
  }

  /** Pide los datos del lead a Graph y crea/une el contacto. Una sola vez a la vez (compare-and-set). */
  async fetch(companyId: string, id: string) {
    const claim = await this.prisma.adLead.updateMany({ where: { id, companyId, status: { in: ['RECEIVED', 'PENDING_PERMISSION', 'ERROR'] } }, data: { status: 'FETCHING' } });
    if (claim.count !== 1) return this.prisma.adLead.findUnique({ where: { id } });
    const lead = (await this.prisma.adLead.findUnique({ where: { id } }))!;
    const set = (data: Record<string, unknown>) => this.prisma.adLead.update({ where: { id }, data });
    // Primero el token de la página; si no hay o Meta lo rechaza, el de la cuenta publicitaria con leads_retrieval
    const page = lead.pageId ? (await this.pages(companyId)).find((p) => p.pageId === lead.pageId) : undefined;
    const tokens = [...(page?.token ? [page.token] : []), ...(await this.accountTokens(companyId)).map((t) => t.token)];
    if (!tokens.length) return set({ status: 'PENDING_PERMISSION', error: NO_PERMISSION });
    let data: any = null;
    let failure: any = null;
    for (const token of tokens) {
      try {
        data = await new MetaAdsProvider(this.fetchImpl).fetchLead(lead.leadgenId, token);
        failure = null;
        break;
      } catch (err: any) {
        failure = err;
        if (err?.kind !== 'PERMISSION' && err?.kind !== 'AUTH') break;
      }
    }
    if (failure) {
      const denied = failure?.kind === 'PERMISSION' || failure?.kind === 'AUTH';
      return set({ status: denied ? 'PENDING_PERMISSION' : 'ERROR', error: denied ? DENIED : String(failure?.message ?? 'Error al leer el lead').slice(0, 300) });
    }
    return this.apply(lead, data);
  }

  /** Con los datos que entregó Meta: crea o une el contacto y cierra el lead. Los datos personales van al contacto, no al lead. */
  private async apply(lead: any, data: any) {
    const companyId = lead.companyId as string;
    const set = (patch: Record<string, unknown>) => this.prisma.adLead.update({ where: { id: lead.id }, data: patch });
    const person = contactFromFields(data?.field_data);
    const ids = {
      adId: lead.adId ?? (data?.ad_id ? String(data.ad_id) : null),
      adsetId: lead.adsetId ?? (data?.adset_id ? String(data.adset_id) : null),
      campaignId: lead.campaignId ?? (data?.campaign_id ? String(data.campaign_id) : null),
    };
    if (!person.email && !person.phone) {
      return set({ status: 'FETCHED', fetchedAt: this.now(), fieldNamesJson: JSON.stringify(person.fieldNames), error: 'El formulario no trae correo ni teléfono: no se creó contacto.', ...ids });
    }
    const where = { companyId, OR: [...(person.phone ? [{ phone: person.phone }] : []), ...(person.email ? [{ email: person.email }] : [])] };
    let contact = await this.prisma.contact.findFirst({ where });
    const origin = JSON.stringify({ kind: 'AD', via: 'LEAD_FORM', sourceId: ids.adId ?? undefined, leadgenId: lead.leadgenId, formId: lead.formId ?? undefined, at: (lead.leadCreatedAt ?? this.now()).toISOString() });
    if (!contact) {
      contact = await this.prisma.contact.create({
        data: {
          companyId, name: person.name ?? person.email ?? person.phone ?? 'Lead de formulario', phone: person.phone, email: person.email, channel: 'META_ADS',
          originJson: origin, ...(await entryStageFor(this.prisma, companyId)),
        },
      });
      await contactCreated(companyId, contact.id);
    } else if (!contact.originJson) {
      // Primer origen: solo si no tenía uno (nunca se sobrescribe)
      await this.prisma.contact.update({ where: { id: contact.id }, data: { originJson: origin } });
    }
    return set({ status: 'FETCHED', fetchedAt: this.now(), contactId: contact.id, error: null, fieldNamesJson: JSON.stringify(person.fieldNames), ...ids });
  }

  /* ── Importación directa (sin depender del aviso de Meta) ── */

  /** Cuentas publicitarias reales de Meta cuyo acceso incluye leads_retrieval, con su token. */
  private async accountTokens(companyId: string, accountId?: string) {
    const rows = await this.prisma.adAccount.findMany({ where: { companyId, provider: 'META', mode: 'REAL', status: { in: ['CONNECTED', 'ERROR'] }, ...(accountId ? { id: accountId } : {}) } });
    const out: Array<{ accountId: string; token: string }> = [];
    for (const a of rows) {
      if (!a.tokenEnc || !parseJson<string[]>(a.scopesJson, []).includes(META_LEADS_SCOPE)) continue;
      try {
        out.push({ accountId: a.id, token: decryptSecret(a.tokenEnc) });
      } catch {
        /* conexión ilegible: se ignora, la sincronización ya lo reporta */
      }
    }
    return out;
  }

  /** Estado de la lectura de formularios de la empresa (para la pantalla). */
  async status(companyId: string) {
    const accounts = await this.prisma.adAccount.findMany({ where: { companyId, provider: 'META', mode: 'REAL', status: { not: 'DISCONNECTED' } } });
    const withScope = accounts.filter((a) => parseJson<string[]>(a.scopesJson, []).includes(META_LEADS_SCOPE));
    const settings = accounts.length ? await this.prisma.platformSetting.findMany({ where: { key: { in: accounts.map((a) => importKey(a.id)) } } }) : [];
    const runs = settings.map((x) => parseJson<LeadImportResult | null>(x.value, null)).filter(Boolean) as LeadImportResult[];
    const last = runs.sort((x, y) => (x.at < y.at ? 1 : -1))[0] ?? null;
    const pending = await this.prisma.adLead.count({ where: { companyId, status: { in: ['PENDING_PERMISSION', 'ERROR', 'RECEIVED'] } } });
    return {
      connected: accounts.length > 0,
      canRead: withScope.length > 0,
      missing: withScope.length ? [] : META_LEADS_SCOPES.filter((sc) => !accounts.some((a) => parseJson<string[]>(a.scopesJson, []).includes(sc))),
      everyMinutes: LEAD_IMPORT_EVERY_MIN,
      pending,
      lastImport: last ? { at: last.at, status: last.status, ads: last.ads, found: last.found, created: last.created, contacts: last.contacts, retried: last.retried, more: last.more, error: last.error } : null,
    };
  }

  /** Importa los formularios de todas las cuentas de la empresa que tengan el permiso. */
  async importCompany(companyId: string): Promise<LeadImportResult> {
    const accounts = await this.prisma.adAccount.findMany({ where: { companyId, provider: 'META', mode: 'REAL', status: { in: ['CONNECTED', 'ERROR'] } } });
    const total: LeadImportResult = { at: this.now().toISOString(), status: 'NO_PERMISSION', ads: 0, found: 0, created: 0, contacts: 0, retried: 0, more: false, error: NO_PERMISSION, cursor: null };
    for (const a of accounts) {
      const r = await this.importAccount(a);
      if (r.status === 'NO_PERMISSION' && total.status !== 'NO_PERMISSION') continue;
      if (total.status === 'NO_PERMISSION' || r.status === 'ERROR') {
        total.status = r.status;
        total.error = r.error;
      }
      total.ads += r.ads; total.found += r.found; total.created += r.created; total.contacts += r.contacts; total.retried += r.retried; total.more = total.more || r.more;
    }
    return total;
  }

  /**
   * Trae de Meta los formularios de una cuenta publicitaria, anuncio por
   * anuncio, desde la última importación (la primera vez, 60 días):
   *  - Solo anuncios de campañas de clientes potenciales o que ya reportaron leads.
   *  - El _id sale del leadgen_id: repetir la importación no duplica nada.
   *  - Si Meta niega el permiso, no se guarda nada y queda dicho por qué.
   *  - Al terminar reintenta los leads que habían quedado esperando permiso.
   */
  async importAccount(a: any): Promise<LeadImportResult> {
    const start = this.now();
    const out: LeadImportResult = { at: start.toISOString(), status: 'OK', ads: 0, found: 0, created: 0, contacts: 0, retried: 0, more: false, error: null, cursor: null };
    const key = importKey(a.id);
    const prev = parseJson<LeadImportResult | null>((await this.prisma.platformSetting.findUnique({ where: { key } }))?.value, null);
    out.cursor = prev?.cursor ?? null;
    const save = async () => {
      await this.prisma.platformSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(out) }, update: { value: JSON.stringify(out) } });
      return out;
    };
    const token = (await this.accountTokens(a.companyId, a.id))[0]?.token;
    if (!token) {
      out.status = 'NO_PERMISSION';
      out.error = NO_PERMISSION;
      return save();
    }
    const since = prev?.cursor ? new Date(new Date(prev.cursor).getTime() - OVERLAP_MS) : new Date(start.getTime() - FIRST_IMPORT_DAYS * 86400e3);
    const ads = await this.leadAds(a, start);
    const provider = new MetaAdsProvider(this.fetchImpl);
    let failed = false;
    for (const ad of ads) {
      let res: { leads: any[]; more: boolean };
      try {
        res = await provider.fetchAdLeads(ad.externalId, token, since);
      } catch (err: any) {
        if (err?.kind === 'NOT_FOUND') continue; // anuncio borrado en Meta
        failed = true;
        const denied = err?.kind === 'PERMISSION' || err?.kind === 'AUTH';
        out.status = denied ? 'NO_PERMISSION' : 'ERROR';
        out.error = denied ? DENIED : String(err?.message ?? 'Error al leer los formularios').slice(0, 300);
        break; // permisos o límite: los demás anuncios fallarían igual
      }
      out.ads++;
      out.more = out.more || res.more;
      for (const raw of res.leads) {
        const leadgenId = /^\d{1,30}$/.test(String(raw?.id ?? '')) ? String(raw.id) : null;
        if (!leadgenId) continue;
        out.found++;
        const r = await this.store(a.companyId, leadgenId, raw, ad);
        if (r.created) out.created++;
        if (r.contact) out.contacts++;
      }
    }
    if (!failed) {
      // Los que llegaron por aviso y quedaron sin datos: ahora sí se pueden pedir
      const waiting = await this.prisma.adLead.findMany({ where: { companyId: a.companyId, status: { in: ['PENDING_PERMISSION', 'RECEIVED'] } }, orderBy: { receivedAt: 'desc' }, take: RETRY_MAX });
      for (const w of waiting) {
        const r = await this.fetch(a.companyId, w.id);
        if (r?.status === 'FETCHED') {
          out.retried++;
          if (r.contactId) out.contacts++;
        }
      }
      // Solo una importación completa mueve la marca: si faltó algo, la próxima vuelve a cubrirlo
      if (!out.more) out.cursor = start.toISOString();
    }
    return save();
  }

  /** Anuncios que pueden tener formularios: campañas de clientes potenciales o anuncios que ya reportaron leads. */
  private async leadAds(a: any, now: Date) {
    const entities = await this.prisma.adEntity.findMany({ where: { companyId: a.companyId, accountId: a.id, level: { in: ['CAMPAIGN', 'AD'] } } });
    const leadCampaigns = new Set(entities.filter((e) => e.level === 'CAMPAIGN' && /LEAD/i.test(String(e.objective ?? ''))).map((e) => e.externalId));
    const sinceDay = new Date(now.getTime() - FIRST_IMPORT_DAYS * 86400e3).toISOString().slice(0, 10);
    const withLeads = await this.prisma.adInsightDaily.findMany({ where: { companyId: a.companyId, accountId: a.id, level: 'AD', leads: { gt: 0 }, date: { gte: sinceDay } }, select: { externalId: true } });
    const reported = new Set(withLeads.map((r) => r.externalId));
    const active = (e: any) => ((e.effectiveStatus ?? e.status) === 'ACTIVE' ? 0 : 1);
    return entities
      .filter((e) => e.level === 'AD' && (reported.has(e.externalId) || (e.campaignExternalId && leadCampaigns.has(e.campaignExternalId))))
      .sort((x, y) => active(x) - active(y) || (reported.has(y.externalId) ? 1 : 0) - (reported.has(x.externalId) ? 1 : 0))
      .slice(0, ADS_PER_RUN);
  }

  /** Guarda un lead que ya viene con sus datos (importación). Devuelve si era nuevo y si quedó con contacto. */
  private async store(companyId: string, leadgenId: string, raw: any, ad: { externalId: string; adsetExternalId?: string | null; campaignExternalId?: string | null }) {
    const id = leadDocId(leadgenId);
    const existing = await this.prisma.adLead.findUnique({ where: { id } });
    if (existing) {
      // De otra empresa: no se toca. Ya completo: nada que hacer.
      if (existing.companyId !== companyId || existing.status === 'FETCHED' || existing.status === 'FETCHING') return { created: false, contact: false };
      const claim = await this.prisma.adLead.updateMany({ where: { id, companyId, status: { in: ['RECEIVED', 'PENDING_PERMISSION', 'ERROR'] } }, data: { status: 'FETCHING' } });
      if (claim.count !== 1) return { created: false, contact: false };
      const done = await this.apply(existing, raw);
      return { created: false, contact: !!done.contactId };
    }
    const t = Date.parse(String(raw?.created_time ?? ''));
    const num = (v: unknown) => (/^\d{1,30}$/.test(String(v ?? '')) ? String(v) : null);
    let lead;
    try {
      lead = await this.prisma.adLead.create({
        data: {
          id, companyId, leadgenId, pageId: null, formId: num(raw?.form_id), adId: num(raw?.ad_id) ?? ad.externalId,
          adsetId: num(raw?.adset_id) ?? ad.adsetExternalId ?? null, campaignId: num(raw?.campaign_id) ?? ad.campaignExternalId ?? null,
          status: 'FETCHING', fieldNamesJson: '[]', leadCreatedAt: Number.isFinite(t) ? new Date(t) : null, receivedAt: this.now(),
        },
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err;
      return { created: false, contact: false }; // otra importación lo guardó a la vez
    }
    const done = await this.apply(lead, raw);
    return { created: true, contact: !!done.contactId };
  }

  async list(companyId: string) {
    const rows = await this.prisma.adLead.findMany({ where: { companyId }, orderBy: { receivedAt: 'desc' }, take: 100 });
    const adIds = [...new Set(rows.map((r) => r.adId).filter(Boolean))] as string[];
    const ads = adIds.length ? await this.prisma.adEntity.findMany({ where: { companyId, level: 'AD', externalId: { in: adIds } } }) : [];
    const names = new Map(ads.map((a) => [a.externalId, a.name]));
    return rows.map((r) => ({ ...r, fieldNames: parseJson<string[]>(r.fieldNamesJson, []), fieldNamesJson: undefined, adName: r.adId ? names.get(r.adId) ?? null : null }));
  }
}
