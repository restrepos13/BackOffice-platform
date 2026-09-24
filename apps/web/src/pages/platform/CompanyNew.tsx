import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { CHANNEL_LABELS, MODULE_LABELS, fmtUsd } from '../../lib/format';
import type { Company, Plan } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, PageHeader, Select, Switch, Textarea,
} from '../../components/ui';
import { ModelSelect } from '../../components/media';

const STEPS = [
  'Plantilla',
  'Datos de la empresa',
  'Plan y límites',
  'Módulos',
  'Administrador',
  'Bot y canales',
  'Confirmar',
];

interface CompanyTemplateOption {
  id: string;
  name: string;
  description: string;
  includes: string[];
  modules: string[];
  currency: string;
}

const ALL_MODULES = Object.keys(MODULE_LABELS);
const ALL_CHANNELS = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'TELEGRAM', 'META_ADS', 'N8N', 'GOOGLE_CALENDAR'];

const COUNTRIES = ['Colombia', 'Costa Rica', 'México', 'Perú', 'Ecuador', 'Chile', 'Argentina', 'Estados Unidos', 'España', 'Otro'];

interface WizardState {
  /** '' = desde cero · 'tpl:<id>' = plantilla · 'clone:<companyId>' = clonar */
  base: string;
  name: string; slug: string; legalName: string; industry: string;
  country: string; city: string; website: string;
  contactEmail: string; contactPhone: string; timezone: string;
  language: string; brandColor: string; notes: string;
  planId: string; status: string; trialDays: number;
  maxBots: string; maxUsers: string;
  modules: string[];
  adminName: string; adminEmail: string; adminPassword: string; adminJobTitle: string;
  botName: string; botDescription: string; botPrompt: string; botWelcome: string; botModel: string;
  channels: string[];
}

const initial: WizardState = {
  base: '',
  name: '', slug: '', legalName: '', industry: '', country: 'Colombia',
  city: '', website: '', contactEmail: '', contactPhone: '',
  timezone: 'America/Bogota', language: 'es', brandColor: '#1A1A1A', notes: '',
  planId: '', status: 'TRIAL', trialDays: 14, maxBots: '', maxUsers: '',
  modules: [...ALL_MODULES],
  adminName: '', adminEmail: '', adminPassword: '', adminJobTitle: 'Administrador',
  botName: '', botDescription: '', botPrompt: '', botWelcome: '',
  botModel: 'meta-llama/Llama-3.3-70B-Instruct',
  channels: ['WHATSAPP'],
};

function slugify(input: string): string {
  return input.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default function CompanyNew() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [s, setS] = useState<WizardState>(initial);
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
        brandColor: s.brandColor, notes: s.notes || undefined,
        planId: s.planId || undefined, status: s.status,
        trialDays: s.trialDays,
        limits: {
          ...(s.maxBots ? { maxBots: Number(s.maxBots) } : {}),
          ...(s.maxUsers ? { maxUsers: Number(s.maxUsers) } : {}),
        },
        modules: s.modules,
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
        channels: s.channels,
      }),
    onSuccess: (company) => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      toast.success(`${company.name} aprovisionada correctamente`);
      navigate(`/platform/companies/${company.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error al crear'),
  });

  const canNext = (): boolean => {
    switch (step) {
      case 1: return s.name.trim().length >= 2;
      case 4:
        return (
          !s.adminEmail ||
          (s.adminName.trim().length >= 2 && s.adminPassword.length >= 8)
        );
      default: return true;
    }
  };

  /** Elegir base: plantilla precarga los módulos; clon copia los del origen. */
  const chooseBase = (base: string) => {
    if (base.startsWith('tpl:')) {
      const tpl = templates?.find((t) => t.id === base.slice(4));
      set({ base, modules: tpl ? [...tpl.modules] : s.modules });
    } else if (base.startsWith('clone:')) {
      const src = companies?.find((c) => c.id === base.slice(6));
      set({ base, modules: src ? [...src.modules] : s.modules });
    } else {
      set({ base: '', modules: [...ALL_MODULES] });
    }
  };

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <>
      <PageHeader kicker="Aprovisionamiento" title="Nueva" accent="empresa." />

      {/* Indicador de pasos */}
      <ol className="mb-6 flex flex-wrap border-2 border-ink bg-paper">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={clsx(
              'flex items-center gap-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.08em]',
              i === step ? 'bg-ink text-bone' : i < step ? 'text-ok' : 'text-ink-3',
            )}
          >
            <span className="font-display">{String(i + 1).padStart(2, '0')}</span>
            {label}
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          {step === 0 && (
            <div className="space-y-5">
              <p className="text-sm text-ink-2">
                Una plantilla deja la empresa LISTA para operar en su vertical:
                módulos, configuración, áreas y asistente IA — sin tocar código.
                También puedes clonar la configuración de una empresa existente.
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

          {step === 1 && (
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
              <Field label="Sitio web">
                <Input value={s.website} onChange={(e) => set({ website: e.target.value })} placeholder="https://…" />
              </Field>
              <Field label="Zona horaria">
                <Select value={s.timezone} onChange={(e) => set({ timezone: e.target.value })}>
                  {['America/Bogota', 'America/Costa_Rica', 'America/Mexico_City', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/New_York', 'Europe/Madrid'].map((tz) => (
                    <option key={tz}>{tz}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Correo de contacto">
                <Input type="email" value={s.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} />
              </Field>
              <Field label="WhatsApp / teléfono">
                <Input value={s.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} placeholder="+57 …" />
              </Field>
              <Field label="Color de marca">
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

          {step === 2 && (
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

          {step === 3 && (
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

          {step === 4 && (
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
                <Input type="text" value={s.adminPassword} onChange={(e) => set({ adminPassword: e.target.value })} />
              </Field>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-5">
              {(selectedTemplate || cloneSource) && (
                <p className="border-2 border-info bg-info-soft px-4 py-2.5 text-sm text-info">
                  {selectedTemplate
                    ? `La plantilla "${selectedTemplate.name}" ya trae su asistente IA configurado — deja estos campos vacíos para usarlo, o escribe uno propio para reemplazarlo.`
                    : `Se clonarán los asistentes de ${cloneSource?.name} (en borrador) — deja estos campos vacíos para usarlos.`}
                </p>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Nombre del bot" hint="Vacío = sin bot inicial">
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
                  <Field label="System prompt inicial">
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

          {step === 6 && (
            <div className="space-y-4 text-sm">
              <p className="serif-accent text-xl">Revisar antes de aprovisionar:</p>
              <dl className="grid gap-x-6 gap-y-2 md:grid-cols-2">
                <Row
                  k="Base"
                  v={
                    selectedTemplate
                      ? `Plantilla: ${selectedTemplate.name}`
                      : cloneSource
                        ? `Clon de ${cloneSource.name} (sin credenciales ni datos)`
                        : 'Desde cero'
                  }
                />
                <Row k="Empresa" v={`${s.name} (${slug})`} />
                <Row k="Ubicación" v={[s.city, s.country].filter(Boolean).join(', ') || '—'} />
                <Row k="Plan" v={selectedPlan ? `${selectedPlan.name} · ${selectedPlan.isCustom ? 'a medida' : fmtUsd(selectedPlan.priceMonthly) + '/mes'}` : 'Sin plan'} />
                <Row k="Estado" v={s.status === 'TRIAL' ? `Trial ${s.trialDays} días` : 'Activa'} />
                <Row k="Módulos" v={s.modules.map((m) => MODULE_LABELS[m]).join(', ')} />
                <Row k="Admin" v={s.adminEmail ? `${s.adminName} <${s.adminEmail}>` : 'Se crea después'} />
                <Row k="Bot inicial" v={s.botName || 'Sin bot'} />
                <Row k="Canales" v={s.channels.map((c) => CHANNEL_LABELS[c]).join(', ') || 'Ninguno'} />
              </dl>
            </div>
          )}

          {/* Navegación */}
          <div className="mt-6 flex justify-between border-t-2 border-line pt-4">
            <Button variant="outline" disabled={step === 0} onClick={() => setStep(step - 1)}>
              ← Atrás
            </Button>
            {step < STEPS.length - 1 ? (
              <Button disabled={!canNext()} onClick={() => setStep(step + 1)}>
                Siguiente →
              </Button>
            ) : (
              <Button disabled={mutation.isPending} onClick={() => mutation.mutate()}>
                {mutation.isPending ? 'Aprovisionando…' : 'Crear empresa ✓'}
              </Button>
            )}
          </div>
        </Card>

        {/* Resumen lateral */}
        <div className="space-y-4">
          <Card kicker="Vista previa" title={s.name || 'Sin nombre'}>
            <div className="space-y-2 text-sm">
              <p className="flex items-center gap-2">
                <span className="inline-block h-4 w-4 border-2 border-ink" style={{ background: s.brandColor }} />
                <span className="text-ink-3">{slug || '—'}</span>
              </p>
              <p>
                <Badge tone={s.status === 'ACTIVE' ? 'ok' : 'warn'}>
                  {s.status === 'ACTIVE' ? 'Activa' : `Trial ${s.trialDays}d`}
                </Badge>
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
                  <li>{s.adminEmail ? '1 usuario admin' : 'Sin usuarios'}</li>
                  <li>{s.botName ? '1 bot en borrador' : 'Sin bot'}</li>
                  <li>{s.channels.length} canales preparados</li>
                </ul>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="border-b border-line pb-1">
      <dt className="kicker">{k}</dt>
      <dd className="mt-0.5">{v}</dd>
    </div>
  );
}
