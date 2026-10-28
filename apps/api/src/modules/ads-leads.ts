import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson } from '../common/constants';
import { decryptSecret, isEncrypted } from '../common/crypto';
import { entryStageFor } from '../common/pipelines';
import { contactCreated } from '../common/domain-events';
import { LeadgenEvent, contactFromFields, leadDocId } from '../common/ads/leads';
import { classifyMetaError, metaAdsVersion } from '../common/ads/meta-ads-provider';
import type { FetchLike } from '../common/ads/provider';

/**
 * Leads de formularios de Meta (Lead Ads).
 *  - Se aceptan solo para páginas conectadas a la empresa del webhook.
 *  - El _id sale del leadgen_id: los reintentos de Meta no duplican nada.
 *  - Los datos personales se piden a Graph con el token de esa página; sin
 *    token o sin `leads_retrieval`, el lead queda en PENDING_PERMISSION con
 *    sus IDs (sirven para atribuir) y no se crea ningún contacto inventado.
 *  - El contacto conserva su primer origen; si es nuevo, el origen es el
 *    formulario (ID del anuncio incluido).
 */

const PAGE_TYPES = ['META_SOCIAL', 'MESSENGER', 'INSTAGRAM'];

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
    const page = (await this.pages(companyId)).find((p) => p.pageId === lead.pageId);
    if (!page?.token) {
      return set({ status: 'PENDING_PERMISSION', error: `La página ${lead.pageId} no tiene un token guardado en BackOffice. Conéctala con el permiso leads_retrieval.` });
    }
    let data: any;
    try {
      const qs = new URLSearchParams({ fields: 'field_data,created_time,ad_id,adset_id,campaign_id,form_id', access_token: page.token });
      const res = await this.fetchImpl(`https://graph.facebook.com/${metaAdsVersion()}/${lead.leadgenId}?${qs}`);
      data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw classifyMetaError(data?.error, res.status);
    } catch (err: any) {
      const kind = err?.kind;
      return set({
        status: kind === 'PERMISSION' || kind === 'AUTH' ? 'PENDING_PERMISSION' : 'ERROR',
        error: kind === 'PERMISSION' || kind === 'AUTH'
          ? 'Meta no entregó los datos: falta el permiso leads_retrieval (App Review) o el token de la página venció.'
          : String(err?.message ?? 'Error al leer el lead').slice(0, 300),
      });
    }
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

  async list(companyId: string) {
    const rows = await this.prisma.adLead.findMany({ where: { companyId }, orderBy: { receivedAt: 'desc' }, take: 100 });
    const adIds = [...new Set(rows.map((r) => r.adId).filter(Boolean))] as string[];
    const ads = adIds.length ? await this.prisma.adEntity.findMany({ where: { companyId, level: 'AD', externalId: { in: adIds } } }) : [];
    const names = new Map(ads.map((a) => [a.externalId, a.name]));
    return rows.map((r) => ({ ...r, fieldNames: parseJson<string[]>(r.fieldNamesJson, []), fieldNamesJson: undefined, adName: r.adId ? names.get(r.adId) ?? null : null }));
  }
}
