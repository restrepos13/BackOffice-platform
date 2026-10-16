import { ArrowLeft, Check, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtMoney } from '../../lib/format';
import type { AuthUser, SetupProposal } from '../../lib/types';
import { Button, Field, Input, Select, Textarea } from '../../components/ui';

/**
 * Registro por la web: 1) describe tu negocio, 2) la IA lo arma y lo revisas,
 * 3) creas tu cuenta y entras a "Primeros pasos". Sin tarjeta, sin prueba gratis.
 */

const RUBRO_LABELS: Record<string, string> = {
  COMIDAS: 'Comidas',
  WEBCAM: 'Webcam y creadores',
  SERVICIOS: 'Servicios con citas',
  VENTAS: 'Tiendas y ventas',
};

const EXAMPLES: Array<{ label: string; text: string }> = [
  {
    label: 'Restaurante',
    text: 'Somos un restaurante de almuerzos en Laureles, Medellín. Abrimos de lunes a sábado de 11 a 3. Bandeja paisa 18.000, ajiaco 16.000 y menú vegetariano 15.000. Hacemos domicilios hasta 4 km, el envío vale 3.000. Recibimos Nequi y efectivo.',
  },
  {
    label: 'Tienda de ropa',
    text: 'Tienda de ropa para mujer en Envigado. Vendemos blusas de lino a 89.000, jeans tiro alto a 120.000 y vestidos desde 140.000. Atendemos de lunes a sábado de 9 a 7, enviamos a todo el país con Servientrega y aceptamos transferencia.',
  },
  {
    label: 'Consultorio',
    text: 'Consultorio odontológico en Pereira. Limpieza 90.000, valoración gratis, blanqueamiento 450.000. Atendemos de lunes a viernes de 8 a 6 con cita previa. Queremos que el asistente agende citas y recuerde un día antes.',
  },
];

const DAY = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const LOADING = ['Leyendo tu negocio…', 'Armando tu catálogo…', 'Preparando tu asistente…', 'Casi listo…'];

interface Preview {
  rubro: string;
  rubroLabel: string;
  company: { name: string; city: string; summary: string };
  proposal: SetupProposal;
}

export default function Signup() {
  const { user, loading, adopt } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [form, setForm] = useState({ companyName: '', city: '', name: '', email: '', phone: '', password: '', accept: false });

  useEffect(() => {
    document.title = 'Crea tu empresa · BackOffice';
  }, []);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setTick((n) => n + 1), 2200);
    return () => clearInterval(t);
  }, [busy]);

  if (!loading && user) return <Navigate to="/" replace />;

  async function generate() {
    setBusy(true);
    setTick(0);
    try {
      const r = await api.post<Preview>('/public/signup/preview', { description });
      setPreview(r);
      setForm((f) => ({ ...f, companyName: f.companyName || r.company.name, city: f.city || r.company.city }));
      setStep(2);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos armar tu empresa');
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    setBusy(true);
    try {
      const res = await api.post<{ token: string; user: AuthUser }>('/public/signup', {
        description,
        rubro: preview.rubro,
        proposal: preview.proposal,
        company: { name: form.companyName, city: form.city },
        admin: { name: form.name, email: form.email, phone: form.phone, password: form.password },
        acceptTerms: form.accept,
      });
      adopt(res.token, res.user);
      toast.success('¡Tu empresa quedó creada!');
      navigate('/app/bienvenida', { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No pudimos crear tu cuenta');
    } finally {
      setBusy(false);
    }
  }

  const p = preview?.proposal;
  const setProposal = (next: SetupProposal) => preview && setPreview({ ...preview, proposal: next });

  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5 md:px-6">
        <Link to="/" className="display text-2xl leading-none">
          BackOffice<span className="text-ok">.</span>
        </Link>
        <Link to="/login" className="text-xs font-semibold uppercase tracking-[0.08em] hover:underline">
          Ya tengo cuenta
        </Link>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-16 md:px-6">
        {/* Pasos */}
        <ol className="mb-8 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.1em]">
          {['Tu negocio', 'Revisa', 'Tu cuenta'].map((label, i) => (
            <li
              key={label}
              className={`flex items-center gap-2 border-2 px-3 py-1.5 ${step === i + 1 ? 'border-ink bg-ink text-bone' : step > i + 1 ? 'border-ink bg-paper' : 'border-line text-ink-3'}`}
            >
              {step > i + 1 ? <Check size={12} /> : <span>{i + 1}</span>} {label}
            </li>
          ))}
        </ol>

        {step === 1 && (
          <section className="max-w-3xl">
            <h1 className="display text-5xl leading-none md:text-6xl">
              Cuéntanos <span className="serif-accent normal-case">tu negocio.</span>
            </h1>
            <p className="mt-4 text-ink-2">
              Escríbelo como se lo contarías a un empleado nuevo: qué vendes u ofreces, precios, horario, cómo te pagan y si haces envíos.
              Con eso la IA arma tu empresa.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <span className="kicker self-center">Ejemplos:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => setDescription(ex.text)}
                  className="cursor-pointer border-2 border-ink bg-paper px-3 py-1 text-xs font-semibold hover:bg-bone-2"
                >
                  {ex.label}
                </button>
              ))}
            </div>
            <Textarea
              rows={9}
              className="mt-3 text-base"
              value={description}
              maxLength={4000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ej.: Tengo una panadería en Bello. Vendemos pan francés a 500, pandebono a 1.500…"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-ink-3">{description.length} / 4.000 · mínimo 40 caracteres</span>
              <Button disabled={busy || description.trim().length < 40} onClick={generate}>
                <Sparkles size={14} /> {busy ? LOADING[tick % LOADING.length] : 'Armar mi empresa con IA'}
              </Button>
            </div>
          </section>
        )}

        {step === 2 && preview && p && (
          <section>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="kicker">Esto armó la IA · puedes ajustarlo después</p>
                <h1 className="display text-4xl md:text-5xl">{form.companyName || 'Tu empresa'}</h1>
                {preview.company.summary && <p className="serif-accent text-xl text-ink-2">{preview.company.summary}</p>}
              </div>
              <Field label="Tipo de negocio">
                <Select value={preview.rubro} onChange={(e) => setPreview({ ...preview, rubro: e.target.value, rubroLabel: RUBRO_LABELS[e.target.value] })}>
                  {Object.entries(RUBRO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="border-2 border-ink bg-paper p-5">
                <p className="kicker mb-3">{preview.rubro === 'SERVICIOS' ? 'Servicios' : preview.rubro === 'COMIDAS' ? 'Menú' : 'Catálogo'} ({p.products.length})</p>
                {p.products.length === 0 && <p className="text-sm text-ink-3">No mencionaste productos o servicios: los cargas después en tu panel.</p>}
                <ul className="divide-y divide-line">
                  {p.products.map((prod, i) => (
                    <li key={`${prod.name}-${i}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="font-semibold">{prod.name}</p>
                        {(prod.category || prod.description) && <p className="truncate text-xs text-ink-3">{[prod.category, prod.description].filter(Boolean).join(' · ')}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="tabular-nums">{prod.price != null ? fmtMoney(prod.price) : <span className="text-xs text-ink-3">sin precio</span>}</span>
                        <button
                          type="button"
                          aria-label={`Quitar ${prod.name}`}
                          className="cursor-pointer p-1 text-ink-3 hover:text-bad"
                          onClick={() => setProposal({ ...p, products: p.products.filter((_, j) => j !== i) })}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-4">
                <div className="border-2 border-ink bg-paper p-5 text-sm">
                  <p className="kicker mb-2">Horario</p>
                  {p.schedule ? <p>{p.schedule.days.map((d) => DAY[d]).join(', ')} · {p.schedule.open} a {p.schedule.close}</p> : <p className="text-ink-3">Lo defines después.</p>}
                  {p.delivery?.enabled && (
                    <>
                      <p className="kicker mb-1 mt-4">Domicilios</p>
                      <p>Envío {p.delivery.baseFee != null ? fmtMoney(p.delivery.baseFee) : 'por definir'}{p.delivery.maxKm ? ` · hasta ${p.delivery.maxKm} km` : ''}</p>
                    </>
                  )}
                </div>
                {p.assistant && (
                  <div className="border-2 border-ink bg-ink p-5 text-sm text-bone">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-line">Tu asistente</p>
                    <p className="display mt-1 text-3xl">{p.assistant.name}</p>
                    <p className="mt-2 bg-bone/10 p-3 italic">"{p.assistant.welcome}"</p>
                    <p className="mt-2 text-xs text-line">Tono: {p.assistant.tone}</p>
                  </div>
                )}
                {p.faqs.length > 0 && (
                  <div className="border-2 border-ink bg-paper p-5 text-sm">
                    <p className="kicker mb-2">Preguntas que ya sabe responder ({p.faqs.length})</p>
                    <ul className="space-y-1 text-xs">
                      {p.faqs.slice(0, 5).map((f) => <li key={f.question}>— {f.question}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <div className="mt-6 flex flex-wrap justify-between gap-3">
              <Button variant="outline" onClick={() => setStep(1)}><ArrowLeft size={14} /> Cambiar descripción</Button>
              <Button onClick={() => setStep(3)}>Se ve bien, crear mi cuenta</Button>
            </div>
          </section>
        )}

        {step === 3 && preview && (
          <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <form onSubmit={create} className="space-y-4 border-2 border-ink bg-paper p-6 shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]">
              <h1 className="display text-4xl">Tu cuenta</h1>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Nombre de la empresa" required>
                  <Input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} required maxLength={80} />
                </Field>
                <Field label="Ciudad">
                  <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} maxLength={60} />
                </Field>
                <Field label="Tu nombre" required>
                  <Input autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
                </Field>
                <Field label="WhatsApp" required hint="Por aquí te escribimos para dejar todo listo">
                  <Input type="tel" autoComplete="tel" placeholder="300 123 4567" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
                </Field>
                <Field label="Correo" required>
                  <Input type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
                </Field>
                <Field label="Contraseña" required hint="Mínimo 8 caracteres">
                  <Input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
                </Field>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={form.accept} onChange={(e) => setForm({ ...form, accept: e.target.checked })} />
                <span>Acepto los términos del servicio y autorizo el tratamiento de mis datos para crear y operar mi cuenta.</span>
              </label>
              <div className="flex flex-wrap justify-between gap-3">
                <Button type="button" variant="outline" onClick={() => setStep(2)}><ArrowLeft size={14} /> Atrás</Button>
                <Button type="submit" disabled={busy || !form.accept}>{busy ? 'Creando tu empresa…' : 'Crear mi empresa'}</Button>
              </div>
            </form>
            <aside className="space-y-3 text-sm">
              <p className="kicker">Qué pasa después</p>
              <ol className="space-y-3">
                <li className="border-l-2 border-ink pl-3"><b>Entras a tu panel</b> y ves lo que falta, con una guía con IA que te ayuda paso a paso.</li>
                <li className="border-l-2 border-ink pl-3"><b>Te escribimos por WhatsApp</b> para conectar tu número y probar tu asistente.</li>
                <li className="border-l-2 border-ink pl-3"><b>Eliges tu plan</b> cuando todo esté funcionando. Sin tarjeta para empezar.</li>
              </ol>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}
