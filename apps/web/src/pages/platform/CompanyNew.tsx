import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Copy, Dice5, Sparkles, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { CHANNEL_LABELS, MODULE_LABELS, fmtUsd } from '../../lib/format';
import type { Company, PersonaTemplate, Plan } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Switch, Textarea,
} from '../../components/ui';
import { ModelSelect } from '../../components/media';
import { PersonaPicker } from '../../components/PersonaPicker';

/* ─── Tipos ──────────────────────────────────────────────────────────── */

interface TemplateArea {
  name: string;
  description?: string;
  notifyChannel: string;
  reminderHoursBefore: number;
}

interface CompanyTemplateOption {
  id: string;
  name: string;
  description: string;
  includes: string[];
  modules: string[];
  currency: string;
  orderConfig: Record<string, any> | null;
  areas: TemplateArea[];
  botName: string | null;
  botSummary: string | null;
}

type StepKey =
  | 'plantilla' | 'datos' | 'plan' | 'modulos' | 'vertical'
  | 'admin' | 'bot' | 'confirmar';

const STEP_LABELS: Record<StepKey, string> = {
  plantilla: 'Plantilla',
  datos: 'Datos e identidad',
  plan: 'Plan y límites',
  modulos: 'Módulos',
  vertical: 'Agenda y áreas',
  admin: 'Administrador',
  bot: 'Asistente IA',
  confirmar: 'Confirmar',
};

const ALL_MODULES = Object.keys(MODULE_LABELS);
const ALL_CHANNELS = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'TELEGRAM', 'META_ADS', 'N8N', 'GOOGLE_CALENDAR'];
const COUNTRIES = ['Colombia', 'Costa Rica', 'México', 'Perú', 'Ecuador', 'Chile', 'Argentina', 'Estados Unidos', 'España', 'Otro'];
const CURRENCIES = [
  { code: 'COP', label: 'Peso colombiano (COP)' },
  { code: 'USD', label: 'Dólar (USD)' },
  { code: 'MXN', label: 'Peso mexicano (MXN)' },
  { code: 'EUR', label: 'Euro (EUR)' },
];
const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

interface WizardState {
  /** '' = desde cero · 'tpl:<id>' = plantilla · 'clone:<companyId>' = clonar */
  base: string;
  name: string; slug: string; legalName: string; industry: string;
  country: string; city: string; website: string;
  contactEmail: string; contactPhone: string; timezone: string;
  language: string; brandColor: string; currency: string; notes: string;
  planId: string; status: string; trialDays: number;
  maxBots: string; maxUsers: string;
  modules: string[];
  /** Agenda del vertical (editable sobre la plantilla) */
  schedule: { days: number[]; open: string; close: string };
  orderCutoff: string; minLeadHours: string; maxPerSlot: string;
  areas: TemplateArea[];
  verticalTouched: boolean;
  adminName: string; adminEmail: string; adminPassword: string; adminJobTitle: string;
  botName: string; botDescription: string; botPrompt: string; botWelcome: string; botModel: string;
  personaId: string; personaName: string;
  channels: string[];
}

const initial: WizardState = {
  base: '',
  name: '', slug: '', legalName: '', industry: '', country: 'Colombia',
  city: '', website: '', contactEmail: '', contactPhone: '',
  timezone: 'America/Bogota', language: 'es', brandColor: '#1A1A1A',
  currency: 'COP', notes: '',
  planId: '', status: 'TRIAL', trialDays: 14, maxBots: '', maxUsers: '',
  modules: [...ALL_MODULES],
  schedule: { days: [1, 2, 3, 4, 5], open: '08:00', close: '18:00' },
  orderCutoff: '14:00', minLeadHours: '18', maxPerSlot: '8',
  areas: [],
  verticalTouched: false,
  adminName: '', adminEmail: '', adminPassword: '', adminJobTitle: 'Administrador',
  botName: '', botDescription: '', botPrompt: '', botWelcome: '',
  botModel: 'meta-llama/Llama-3.3-70B-Instruct',
  personaId: '', personaName: '',
  channels: ['WHATSAPP'],
};

function slugify(input: string): string {
  return input.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function strongPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const pick = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint32Array(n)), (v) => chars[v % chars.length]).join('');
  return `BO-${pick(12)}`;
}

/* ─── Vista previa de la marca (correo con la identidad) ─────────────── */

function BrandPreview({ name, color }: { name: string; color: string }) {
  return (
    <div className="border-2 border-ink bg-bone">
      <div style={{ height: 6, background: color }} />
      <div className="border-b-2 border-ink px-3 py-2">
        <p className="text-sm font-extrabold uppercase tracking-wide" style={{ color }}>
          {name || 'Tu empresa'}
        </p>
      </div>
      <div className="space-y-1.5 px-3 py-2.5">
        <div className="h-1.5 w-4/5 bg-line" />
        <div className="h-1.5 w-3/5 bg-line" />
        <div className="h-1.5 w-2/3 bg-line" />
      </div>
      <div className="border-t border-line px-3 py-1.5">
        <p className="text-[9px] uppercase tracking-wider text-ink-3">
          Así se verán sus correos y PDFs
        </p>
      </div>
    </div>
  );
}

/* ─── Página ─────────────────────────────────────────────────────────── */

export default function CompanyNew() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [stepIdx, setStepIdx] = useState(0);
  const [maxVisited, setMaxVisited] = useState(0);
  const [s, setS] = useState<WizardState>(initial);
  const [pickingPersona, setPickingPersona] = useState(false);
  const [created, setCreated] = useState<Company | null>(null);
  const set = (patch: Partial<WizardState>) => setS((prev) => ({ ...prev, ...patch }));

  const { data: plans } = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<Plan[]>('/plans'),
  });
  const { data: templates } = useQuery({
    queryKey: ['company-templates'],
    queryFn: () => api.get<CompanyTemplateOption[]>('/companies/templates'),
  });
  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
  });

  const selectedPlan = plans?.find((p) => p.id === s.planId);
  const slug = useMemo(() => s.slug || slugify(s.name), [s.slug, s.name]);
  const templateId = s.base.startsWith('tpl:') ? s.base.slice(4) : undefined;
  const cloneFromCompanyId = s.base.startsWith('clone:') ? s.base.slice(6) : undefined;
  const selectedTemplate = templates?.find((t) => t.id === templateId);
  const cloneSource = companies?.find((c) => c.id === cloneFromCompanyId);

  // Pasos dinámicos: "Agenda y áreas" solo si la base trae módulo de pedidos
  const hasVertical = !!selectedTemplate?.orderConfig && s.modules.includes('orders');
  const stepKeys: StepKey[] = useMemo(
    () => [
      'plantilla', 'datos', 'plan', 'modulos',
      ...(hasVertical ? (['vertical'] as StepKey[]) : []),
      'admin', 'bot', 'confirmar',
    ],
    [hasVertical],
  );
  const step = stepKeys[Math.min(stepIdx, stepKeys.length - 1)];

  /** Elegir base: precarga módulos, moneda, agenda y áreas editables. */
  const chooseBase = (base: string) => {
    if (base.startsWith('tpl:')) {
      const tpl = templates?.find((t) => t.id === base.slice(4));
      set({
        base,
        modules: tpl ? [...tpl.modules] : s.modules,
        currency: tpl?.currency ?? s.currency,
        verticalTouched: false,
        ...(tpl?.orderConfig
          ? {
              schedule: {
                days: tpl.orderConfig.schedule?.days ?? [1, 2, 3, 4, 5],
                open: tpl.orderConfig.schedule?.open ?? '08:00',
                close: tpl.orderConfig.schedule?.close ?? '18:00',
              },
              orderCutoff: tpl.orderConfig.orderCutoff ?? '14:00',
              minLeadHours: String(tpl.orderConfig.minLeadHours ?? 18),
              maxPerSlot: String(tpl.orderConfig.maxPerSlot ?? 8),
              areas: tpl.areas.map((a) => ({ ...a })),
            }
          : { areas: [] }),
      });
    } else if (base.startsWith('clone:')) {
      const src = companies?.find((c) => c.id === base.slice(6));
      set({
        base,
        modules: src ? [...src.modules] : s.modules,
        currency: src?.currency ?? s.currency,
        verticalTouched: false,
        areas: [],
      });
    } else {
      set({ base: '', modules: [...ALL_MODULES], verticalTouched: false, areas: [] });
    }
  };

  const mutation = useMutation({
    mutationFn: () =>
      api.post<Company>('/companies', {
        templateId,
        cloneFromCompanyId,
        name: s.name, slug, legalName: s.legalName || undefined,
        industry: s.industry || undefined, country: s.country,
        city: s.city || undefined, website: s.website || undefined,
        contactEmail: s.contactEmail || undefined,
        contactPhone: s.contactPhone || undefined,
        timezone: s.timezone, language: s.language,
        brandColor: s.brandColor, currency: s.currency,
        notes: s.notes || undefined,
        planId: s.planId || undefined, status: s.status,
        trialDays: s.trialDays,
        limits: {
          ...(s.maxBots ? { maxBots: Number(s.maxBots) } : {}),
          ...(s.maxUsers ? { maxUsers: Number(s.maxUsers) } : {}),
        },
        modules: s.modules,
        // Personalización del vertical hecha en el wizard (si la tocó)
        ...(hasVertical && s.verticalTouched
          ? {
              orderConfigOverrides: {
                schedule: s.schedule,
                orderCutoff: s.orderCutoff,
                minLeadHours: Number(s.minLeadHours) || 0,
                maxPerSlot: Number(s.maxPerSlot) || null,
              },
              areas: s.areas,
            }
          : {}),
        admin: s.adminEmail
          ? {
              name: s.adminName, email: s.adminEmail,
              password: s.adminPassword, jobTitle: s.adminJobTitle,
            }
          : undefined,
        bot: s.botName
          ? {
              name: s.botName, description: s.botDescription || undefined,
              systemPrompt: s.botPrompt || undefined,
              welcomeMessage: s.botWelcome || undefined, model: s.botModel,
            }
          : undefined,
        personaTemplateId: s.personaId || undefined,
        channels: s.channels,
      }),
    onSuccess: (company) => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      setCreated(company); // pantalla de éxito con credenciales
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error al crear'),
  });

  const canNext = (): boolean => {
    switch (step) {
      case 'datos': return s.name.trim().length >= 2;
      case 'vertical': return s.areas.every((a) => a.name.trim().length > 0);
      case 'admin':
        return (
          !s.adminEmail ||
          (s.adminName.trim().length >= 2 && s.adminPassword.length >= 8)
        );
      default: return true;
    }
  };

  const goTo = (idx: number) => {
    setStepIdx(idx);
    setMaxVisited((m) => Math.max(m, idx));
  };
  const next = () => canNext() && goTo(stepIdx + 1);

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const setArea = (idx: number, patch: Partial<TemplateArea>) =>
    set({
      verticalTouched: true,
      areas: s.areas.map((a, i) => (i === idx ? { ...a, ...patch } : a)),
    });

  return (
    <>
      <PageHeader kicker="Aprovisionamiento" title="Nueva" accent="empresa." />

      {/* Indicador de pasos — clickable hacia pasos ya visitados */}
      <ol className="mb-6 flex flex-wrap border-2 border-ink bg-paper">
        {stepKeys.map((key, i) => (
          <li key={key}>
            <button
              type="button"
              disabled={i > maxVisited}
              onClick={() => i <= maxVisited && setStepIdx(i)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em]',
                i === stepIdx
                  ? 'bg-ink text-bone'
                  : i <= maxVisited
                    ? 'cursor-pointer text-ok hover:bg-bone-2'
                    : 'cursor-default text-ink-3',
              )}
            >
              <span className="font-display">{String(i + 1).padStart(2, '0')}</span>
              {STEP_LABELS[key]}
            </button>
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          {step === 'plantilla' && (
            <div className="space-y-5">
              <p className="text-sm text-ink-2">
                Una plantilla deja la empresa LISTA para operar en su vertical —
                y todo lo que trae se puede <strong>personalizar en los pasos
                siguientes</strong>, sin tocar código. También puedes clonar la
                configuración de una empresa existente.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => chooseBase('')}
                  className={clsx(
                    'cursor-pointer border-2 p-4 text-left transition-colors',
                    s.base === '' ? 'border-ink bg-ink text-bone' : 'border-ink bg-paper hover:bg-bone-2',
                  )}
                >
                  <p className="display text-xl">Desde cero</p>
                  <p className="mt-1 text-xs opacity-80">
                    Solo los módulos base. Todo se configura a mano después.
                  </p>
                </button>
                {templates?.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => chooseBase(`tpl:${tpl.id}`)}
                    className={clsx(
                      'cursor-pointer border-2 p-4 text-left transition-colors',
                      s.base === `tpl:${tpl.id}` ? 'border-ink bg-ink text-bone' : 'border-ink bg-paper hover:bg-bone-2',
                    )}
                  >
                    <p className="display text-xl">{tpl.name}</p>
                    <p className="mt-1 text-xs opacity-80">{tpl.description}</p>
                    <ul className="mt-2 space-y-0.5 text-xs opacity-90">
                      {tpl.includes.slice(0, 4).map((inc) => <li key={inc}>— {inc}</li>)}
                      {tpl.includes.length > 4 && <li>— y {tpl.includes.length - 4} cosas más</li>}
                    </ul>
                  </button>
                ))}
              </div>
              {(companies?.length ?? 0) > 0 && (
                <div className="border-t-2 border-line pt-4">
                  <Field
                    label="O clonar la configuración de una empresa existente"
                    hint="Copia módulos, agenda, catálogo, áreas, bots y líneas — JAMÁS credenciales, llaves ni datos de clientes; las líneas nacen en sandbox"
                  >
                    <Select
                      value={cloneFromCompanyId ?? ''}
                      onChange={(e) => chooseBase(e.target.value ? `clone:${e.target.value}` : '')}
                    >
                      <option value="">No clonar</option>
                      {companies?.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
              )}
            </div>
          )}

          {step === 'datos' && (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Nombre de la empresa" required>
                <Input value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder="Clínica Ejemplo" autoFocus />
              </Field>
              <Field label="Slug (URL interna)" hint={`Se usará como identificador: ${slug || '—'}`}>
                <Input value={s.slug} onChange={(e) => set({ slug: slugify(e.target.value) })} placeholder={slug || 'clinica-ejemplo'} />
              </Field>
              <Field label="Razón social">
                <Input value={s.legalName} onChange={(e) => set({ legalName: e.target.value })} />
              </Field>
              <Field label="Industria">
                <Input value={s.industry} onChange={(e) => set({ industry: e.target.value })} placeholder="Salud, Automotriz, Inmobiliaria…" />
              </Field>
              <Field label="País">
                <Select value={s.country} onChange={(e) => set({ country: e.target.value })}>
                  {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Ciudad">
                <Input value={s.city} onChange={(e) => set({ city: e.target.value })} />
              </Field>
              <Field label="Zona horaria" hint="Los horarios y recordatorios dependen de ella">
                <Select value={s.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                  {['America/Bogota', 'America/Costa_Rica', 'America/Mexico_City', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/New_York', 'Europe/Madrid'].map((tz) => (
                    <option key={tz}>{tz}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Moneda" hint="Consumos y pagos se muestran en esta moneda">
                <Select value={s.currency} onChange={(e) => set({ currency: e.target.value })}>
                  {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </Select>
              </Field>
              <Field label="Sitio web">
                <Input value={s.website} onChange={(e) => set({ website: e.target.value })} placeholder="https://…" />
              </Field>
              <Field label="Correo de contacto">
                <Input type="email" value={s.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} />
              </Field>
              <Field label="WhatsApp / teléfono">
                <Input value={s.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} placeholder="+57 …" />
              </Field>
              <Field label="Color de marca" hint="Cabecera de sus correos, PDFs y reportes">
                <div className="flex gap-2">
                  <input
                    type="color" value={s.brandColor} aria-label="Color de marca"
                    onChange={(e) => set({ brandColor: e.target.value })}
                    className="h-10 w-14 cursor-pointer border-2 border-ink bg-bone p-1"
                  />
                  <Input value={s.brandColor} onChange={(e) => set({ brandColor: e.target.value })} />
                </div>
              </Field>
              <div className="md:col-span-2">
                <Field label="Notas internas" hint="Solo visibles para el equipo BackOffice">
                  <Textarea rows={2} value={s.notes} onChange={(e) => set({ notes: e.target.value })} />
                </Field>
              </div>
            </div>
          )}

          {step === 'plan' && (
            <div className="space-y-5">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {plans?.filter((p) => p.active).map((plan) => (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => set({ planId: plan.id })}
                    className={clsx(
                      'cursor-pointer border-2 p-4 text-left transition-colors',
                      s.planId === plan.id
                        ? 'border-ink bg-ink text-bone'
                        : 'border-ink bg-paper hover:bg-bone-2',
                    )}
                  >
                    <p className="kicker" style={s.planId === plan.id ? { color: '#c3bbb2' } : undefined}>
                      {plan.highlight ? 'Recomendado' : plan.isCustom ? 'A medida' : 'Plan'}
                    </p>
                    <p className="display text-2xl">{plan.name}</p>
                    <p className="mt-1 text-sm font-semibold">
                      {plan.isCustom ? 'Cotización' : `${fmtUsd(plan.priceMonthly)}/mes`}
                    </p>
                    <p className="mt-1 text-xs opacity-80">
                      {plan.maxBots} bots · {plan.maxUsers} usuarios
                    </p>
                  </button>
                ))}
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Field label="Estado inicial">
                  <Select value={s.status} onChange={(e) => set({ status: e.target.value })}>
                    <option value="TRIAL">Trial</option>
                    <option value="ACTIVE">Activa</option>
                  </Select>
                </Field>
                {s.status === 'TRIAL' && (
                  <Field label="Días de trial">
                    <Input type="number" min={1} value={s.trialDays} onChange={(e) => set({ trialDays: Number(e.target.value) })} />
                  </Field>
                )}
                <Field label="Override: máx. bots" hint="Vacío = límite del plan">
                  <Input type="number" min={1} value={s.maxBots} onChange={(e) => set({ maxBots: e.target.value })} placeholder={selectedPlan ? String(selectedPlan.maxBots) : '—'} />
                </Field>
                <Field label="Override: máx. usuarios" hint="Vacío = límite del plan">
                  <Input type="number" min={1} value={s.maxUsers} onChange={(e) => set({ maxUsers: e.target.value })} placeholder={selectedPlan ? String(selectedPlan.maxUsers) : '—'} />
                </Field>
              </div>
            </div>
          )}

          {step === 'modulos' && (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">
                Módulos visibles en el panel del cliente. Se pueden cambiar después
                desde la ficha de la empresa.
              </p>
              {ALL_MODULES.map((module) => (
                <div key={module} className="flex items-center justify-between border-2 border-line bg-bone px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold">{MODULE_LABELS[module]}</p>
                    <p className="kicker">{module}</p>
                  </div>
                  <Switch
                    checked={s.modules.includes(module)}
                    onChange={() => set({ modules: toggle(s.modules, module) })}
                    label={MODULE_LABELS[module]}
                  />
                </div>
              ))}
            </div>
          )}

          {step === 'vertical' && (
            <div className="space-y-6">
              <p className="text-sm text-ink-2">
                La plantilla trae esta operación de base — ajústala al negocio REAL
                del cliente aquí mismo. Todo se puede refinar después desde su panel.
              </p>
              <div>
                <p className="kicker mb-2">Días de entrega / atención</p>
                <div className="flex flex-wrap gap-2">
                  {DAY_NAMES.map((label, d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() =>
                        set({
                          verticalTouched: true,
                          schedule: {
                            ...s.schedule,
                            days: s.schedule.days.includes(d)
                              ? s.schedule.days.filter((x) => x !== d)
                              : [...s.schedule.days, d].sort(),
                          },
                        })
                      }
                      className={clsx(
                        'cursor-pointer border-2 border-ink px-3 py-1.5 text-xs font-semibold uppercase',
                        s.schedule.days.includes(d) ? 'bg-ink text-bone' : 'bg-paper hover:bg-bone-2',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Field label="Apertura">
                  <Input type="time" value={s.schedule.open}
                    onChange={(e) => set({ verticalTouched: true, schedule: { ...s.schedule, open: e.target.value } })} />
                </Field>
                <Field label="Cierre">
                  <Input type="time" value={s.schedule.close}
                    onChange={(e) => set({ verticalTouched: true, schedule: { ...s.schedule, close: e.target.value } })} />
                </Field>
                <Field label="Corte de pedidos" hint="Hora límite del día anterior">
                  <Input type="time" value={s.orderCutoff}
                    onChange={(e) => set({ verticalTouched: true, orderCutoff: e.target.value })} />
                </Field>
                <Field label="Anticipación mínima (h)">
                  <Input type="number" min={0} value={s.minLeadHours}
                    onChange={(e) => set({ verticalTouched: true, minLeadHours: e.target.value })} />
                </Field>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="kicker">Áreas de producción</p>
                  <Button size="sm" variant="outline"
                    onClick={() => set({ verticalTouched: true, areas: [...s.areas, { name: '', notifyChannel: 'PANEL', reminderHoursBefore: 24 }] })}>
                    + Agregar área
                  </Button>
                </div>
                <div className="space-y-2">
                  {s.areas.map((area, idx) => (
                    <div key={idx} className="grid gap-2 border-2 border-line p-2 sm:grid-cols-2 xl:grid-cols-[1.2fr_1.2fr_150px_100px_auto]">
                      <Input value={area.name} placeholder="Nombre (Cocina…)" aria-label="Nombre del área"
                        onChange={(e) => setArea(idx, { name: e.target.value })} />
                      <Input value={area.description ?? ''} placeholder="Descripción" aria-label="Descripción"
                        onChange={(e) => setArea(idx, { description: e.target.value })} />
                      <Select value={area.notifyChannel} aria-label="Canal de aviso"
                        onChange={(e) => setArea(idx, { notifyChannel: e.target.value })}>
                        <option value="PANEL">Panel</option>
                        <option value="EMAIL">Correo</option>
                        <option value="WHATSAPP">WhatsApp</option>
                      </Select>
                      <Input type="number" min={1} value={area.reminderHoursBefore} aria-label="Horas de anticipación"
                        onChange={(e) => setArea(idx, { reminderHoursBefore: Number(e.target.value) })} />
                      <Button size="sm" variant="ghost" aria-label={`Quitar ${area.name}`}
                        onClick={() => set({ verticalTouched: true, areas: s.areas.filter((_, i) => i !== idx) })}>
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  ))}
                  {s.areas.length === 0 && (
                    <p className="border-2 border-dashed border-line px-4 py-3 text-sm text-ink-3">
                      Sin áreas: los pedidos no se distribuyen hasta crearlas (se puede hacer después).
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 'admin' && (
            <div className="grid gap-4 md:grid-cols-2">
              <p className="md:col-span-2 text-sm text-ink-2">
                Usuario con rol <strong>Admin de empresa</strong> — el dueño del negocio.
                Puedes dejarlo vacío y crearlo después.
              </p>
              <Field label="Nombre">
                <Input value={s.adminName} onChange={(e) => set({ adminName: e.target.value })} />
              </Field>
              <Field label="Cargo">
                <Input value={s.adminJobTitle} onChange={(e) => set({ adminJobTitle: e.target.value })} />
              </Field>
              <Field label="Correo">
                <Input type="email" value={s.adminEmail} onChange={(e) => set({ adminEmail: e.target.value })} />
              </Field>
              <Field label="Contraseña temporal" hint="Mínimo 8 caracteres">
                <div className="flex gap-2">
                  <Input type="text" value={s.adminPassword} onChange={(e) => set({ adminPassword: e.target.value })} />
                  <Button variant="outline" onClick={() => set({ adminPassword: strongPassword() })}
                    aria-label="Generar contraseña segura" title="Generar contraseña segura">
                    <Dice5 size={15} />
                  </Button>
                </div>
              </Field>
            </div>
          )}

          {step === 'bot' && (
            <div className="space-y-5">
              {(selectedTemplate?.botSummary || cloneSource) && !s.personaId && (
                <p className="border-2 border-info bg-info-soft px-4 py-2.5 text-sm text-info">
                  {selectedTemplate?.botSummary
                    ? `La plantilla ya trae su asistente: "${selectedTemplate.botSummary}". Deja estos campos vacíos para usarlo, elige una personalidad de la biblioteca, o escribe uno propio.`
                    : `Se clonarán los asistentes de ${cloneSource?.name} (en borrador) — deja estos campos vacíos para usarlos.`}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3 border-2 border-line bg-bone p-3">
                <Sparkles size={16} className="text-ink-2" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">
                    {s.personaId ? `Personalidad elegida: ${s.personaName}` : 'Biblioteca de personalidades'}
                  </p>
                  <p className="text-xs text-ink-3">
                    {s.personaId
                      ? 'El asistente nace con este prompt, tono y bienvenida.'
                      : 'Aplica una personalidad probada (clínicas, ventas, webcam…) con un clic.'}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setPickingPersona(true)}>
                  {s.personaId ? 'Cambiar' : 'Elegir de la biblioteca'}
                </Button>
                {s.personaId && (
                  <Button size="sm" variant="ghost" onClick={() => set({ personaId: '', personaName: '' })}>
                    Quitar
                  </Button>
                )}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Nombre del bot" hint="Vacío = el de la plantilla/personalidad (o sin bot)">
                  <Input value={s.botName} onChange={(e) => set({ botName: e.target.value })} placeholder="Asistente Clínica Ejemplo" />
                </Field>
                <Field label="Modelo IA (DeepInfra)">
                  <ModelSelect value={s.botModel} onChange={(v) => set({ botModel: v })} />
                </Field>
                <div className="md:col-span-2">
                  <Field label="Descripción">
                    <Input value={s.botDescription} onChange={(e) => set({ botDescription: e.target.value })} />
                  </Field>
                </div>
                <div className="md:col-span-2">
                  <Field label="System prompt inicial" hint={s.personaId ? 'Vacío = usa el de la personalidad elegida' : undefined}>
                    <Textarea value={s.botPrompt} onChange={(e) => set({ botPrompt: e.target.value })} placeholder="Eres el asistente de…" />
                  </Field>
                </div>
                <div className="md:col-span-2">
                  <Field label="Mensaje de bienvenida">
                    <Input value={s.botWelcome} onChange={(e) => set({ botWelcome: e.target.value })} />
                  </Field>
                </div>
              </div>
              <div>
                <p className="kicker mb-2">Canales a dejar preparados (sin conectar)</p>
                <div className="flex flex-wrap gap-2">
                  {ALL_CHANNELS.map((channel) => (
                    <button
                      key={channel}
                      type="button"
                      onClick={() => set({ channels: toggle(s.channels, channel) })}
                      className={clsx(
                        'cursor-pointer border-2 border-ink px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em]',
                        s.channels.includes(channel)
                          ? 'bg-ink text-bone'
                          : 'bg-paper hover:bg-bone-2',
                      )}
                    >
                      {CHANNEL_LABELS[channel]}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-ink-3">
                  Cada canal queda creado con su link de conexión listo; las cuentas
                  se vinculan después desde Integraciones.
                </p>
              </div>
            </div>
          )}

          {step === 'confirmar' && (
            <div className="space-y-4 text-sm">
              <p className="serif-accent text-xl">Revisar antes de aprovisionar:</p>
              <dl className="grid gap-x-6 gap-y-2 md:grid-cols-2">
                <Row
                  k="Base"
                  v={
                    selectedTemplate
                      ? `Plantilla: ${selectedTemplate.name}${s.verticalTouched ? ' (personalizada)' : ''}`
                      : cloneSource
                        ? `Clon de ${cloneSource.name} (sin credenciales ni datos)`
                        : 'Desde cero'
                  }
                  onEdit={() => setStepIdx(0)}
                />
                <Row k="Empresa" v={`${s.name} (${slug}) · ${s.currency}`} onEdit={() => setStepIdx(stepKeys.indexOf('datos'))} />
                <Row k="Ubicación" v={[s.city, s.country].filter(Boolean).join(', ') || '—'} onEdit={() => setStepIdx(stepKeys.indexOf('datos'))} />
                <Row k="Plan" v={selectedPlan ? `${selectedPlan.name} · ${selectedPlan.isCustom ? 'a medida' : fmtUsd(selectedPlan.priceMonthly) + '/mes'}` : 'Sin plan'} onEdit={() => setStepIdx(stepKeys.indexOf('plan'))} />
                <Row k="Estado" v={s.status === 'TRIAL' ? `Trial ${s.trialDays} días` : 'Activa'} onEdit={() => setStepIdx(stepKeys.indexOf('plan'))} />
                <Row k="Módulos" v={s.modules.map((m) => MODULE_LABELS[m]).join(', ')} onEdit={() => setStepIdx(stepKeys.indexOf('modulos'))} />
                {hasVertical && (
                  <Row
                    k="Operación"
                    v={`${s.schedule.days.length} días/sem · ${s.schedule.open}–${s.schedule.close} · corte ${s.orderCutoff} · ${s.areas.length} áreas`}
                    onEdit={() => setStepIdx(stepKeys.indexOf('vertical'))}
                  />
                )}
                <Row k="Admin" v={s.adminEmail ? `${s.adminName} <${s.adminEmail}>` : 'Se crea después'} onEdit={() => setStepIdx(stepKeys.indexOf('admin'))} />
                <Row
                  k="Asistente IA"
                  v={s.botName || s.personaName || selectedTemplate?.botName || (cloneSource ? 'Clonados' : 'Sin bot')}
                  onEdit={() => setStepIdx(stepKeys.indexOf('bot'))}
                />
                <Row k="Canales" v={s.channels.map((c) => CHANNEL_LABELS[c]).join(', ') || 'Ninguno'} onEdit={() => setStepIdx(stepKeys.indexOf('bot'))} />
              </dl>
            </div>
          )}

          {/* Navegación */}
          <div className="mt-6 flex justify-between border-t-2 border-line pt-4">
            <Button variant="outline" disabled={stepIdx === 0} onClick={() => setStepIdx(stepIdx - 1)}>
              ← Atrás
            </Button>
            {step !== 'confirmar' ? (
              <Button disabled={!canNext()} onClick={next}>
                Siguiente →
              </Button>
            ) : (
              <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
                {mutation.isPending ? 'Aprovisionando…' : 'Crear empresa ✓'}
              </Button>
            )}
          </div>
        </Card>

        {/* Resumen lateral con vista previa de la marca */}
        <div className="space-y-4">
          <Card kicker="Vista previa" title={s.name || 'Sin nombre'}>
            <div className="space-y-3 text-sm">
              <BrandPreview name={s.name} color={s.brandColor} />
              <p>
                <Badge tone={s.status === 'ACTIVE' ? 'ok' : 'warn'}>
                  {s.status === 'ACTIVE' ? 'Activa' : `Trial ${s.trialDays}d`}
                </Badge>{' '}
                <Badge tone="neutral">{s.currency}</Badge>
              </p>
              {selectedPlan && (
                <div className="border-t border-line pt-2">
                  <p className="font-semibold">{selectedPlan.name}</p>
                  <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
                    {selectedPlan.features.slice(0, 4).map((f) => <li key={f}>— {f}</li>)}
                  </ul>
                </div>
              )}
              <div className="border-t border-line pt-2">
                <p className="kicker mb-1">Se creará</p>
                <ul className="space-y-0.5 text-xs">
                  <li>{s.modules.length} módulos activos</li>
                  {hasVertical && <li>{s.areas.length} áreas de producción + agenda configurada</li>}
                  <li>{s.adminEmail ? '1 usuario admin' : 'Sin usuarios'}</li>
                  <li>
                    {s.botName || s.personaName || selectedTemplate?.botName
                      ? `1 asistente IA en borrador${s.personaName ? ` (${s.personaName})` : ''}`
                      : cloneSource ? 'Asistentes clonados' : 'Sin bot'}
                  </li>
                  <li>{s.channels.length} canales preparados{selectedTemplate?.orderConfig ? ' (WhatsApp en sandbox)' : ''}</li>
                </ul>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Biblioteca de personalidades */}
      <PersonaPicker
        open={pickingPersona}
        onClose={() => setPickingPersona(false)}
        onApply={(persona: PersonaTemplate) =>
          set({ personaId: persona.id, personaName: persona.name })
        }
      />

      {/* Éxito: credenciales listas para entregar al cliente */}
      <Modal
        open={!!created}
        onClose={() => created && navigate(`/platform/companies/${created.id}`)}
        kicker="Empresa aprovisionada"
        title={created?.name ?? ''}
      >
        <div className="space-y-4">
          <p className="flex items-center gap-2 text-sm text-ok">
            <Check size={16} /> Todo creado: módulos, configuración
            {hasVertical ? ', agenda y áreas' : ''}{s.adminEmail ? ', usuario admin' : ''} y canales.
          </p>
          {s.adminEmail && (
            <div className="border-2 border-ink bg-bone p-3">
              <p className="kicker mb-2">Credenciales para entregar al cliente</p>
              <p className="font-mono text-sm">{s.adminEmail}</p>
              <p className="font-mono text-sm">{s.adminPassword}</p>
              <Button
                size="sm" variant="outline" className="mt-2"
                onClick={() => {
                  navigator.clipboard.writeText(
                    `Panel: ${window.location.origin}\nUsuario: ${s.adminEmail}\nContraseña temporal: ${s.adminPassword}`,
                  );
                  toast.success('Credenciales copiadas');
                }}
              >
                <Copy size={13} /> Copiar acceso completo
              </Button>
            </div>
          )}
          <div className="space-y-1 text-sm text-ink-2">
            <p className="kicker">Qué sigue</p>
            <p>1. La empresa conecta su llave de DeepInfra (Configuración).</p>
            <p>2. Credenciales de Twilio en la línea y probar EN SANDBOX.</p>
            <p>3. Activar el asistente cuando la personalidad esté validada.</p>
          </div>
          <Button className="w-full" onClick={() => navigate(`/platform/companies/${created!.id}`)}>
            Ir a la ficha de la empresa →
          </Button>
        </div>
      </Modal>
    </>
  );
}

function Row({ k, v, onEdit }: { k: string; v: string; onEdit?: () => void }) {
  return (
    <div className="border-b border-line pb-1">
      <dt className="flex items-center justify-between">
        <span className="kicker">{k}</span>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-ink-3 hover:text-ink"
          >
            Editar
          </button>
        )}
      </dt>
      <dd className="mt-0.5">{v}</dd>
    </div>
  );
}
