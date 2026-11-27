import { ArrowRight, Check, Clock, Lock, MessageCircle, ShoppingBag, UserCheck } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { formatPhone, validateField, type AccountForm } from '../signup-helpers';

/**
 * Paso 0: la pantalla de entrada Y el formulario, en una sola pantalla.
 * En el celular, arriba del botón solo hay una frase, el nombre del negocio y
 * el WhatsApp: nada más. La explicación (beneficios y ejemplo) queda debajo.
 *
 * Se prerenderiza en registro.html (scripts/prerender.mjs): se ve apenas llega
 * el HTML, antes de que cargue el JavaScript. Lo que la persona alcance a
 * escribir antes (o si toca «Empezar») lo recoge public/early.js y llega aquí
 * como `initial` / `autoSubmit`.
 *
 * Al enviarlo NO se gasta IA y no se espera al servidor: el contacto se manda
 * por detrás (con reintentos) y la persona sigue con la primera pregunta.
 */

export interface ContactValues { companyName: string; phone: string; email: string }

const BENEFITS = [
  { icon: Clock, title: 'Responde al instante, 24/7', text: 'Nadie se queda esperando, ni de noche ni el domingo.' },
  { icon: ShoppingBag, title: 'Toma pedidos, reservas y citas', text: 'Pregunta lo necesario y lo deja anotado en tu panel.' },
  { icon: UserCheck, title: 'Te pasa los clientes listos', text: 'Cuando hace falta una persona, te avisa y tomas el control.' },
];

const CHAT = [
  { from: 'client', text: 'Hola, ¿tienen almuerzo hoy? ¿Hacen domicilio?' },
  { from: 'bot', text: '¡Hola! Sí. Hoy hay sancocho o pollo a la plancha, $18.000 con jugo. ¿A qué dirección te lo enviamos?' },
  { from: 'client', text: 'Calle 10 #43-20, dos de sancocho' },
  { from: 'bot', text: 'Listo: 2 sancochos, $36.000. Llega en 35 min. ¿Pagas en efectivo o transferencia?' },
] as const;

function check(values: ContactValues) {
  const form = { ...values, name: '', city: '', password: '', accept: true } as AccountForm;
  return {
    companyName: validateField('companyName', form),
    phone: validateField('phone', form),
    email: values.email.trim() ? validateField('email', form) : undefined,
  };
}

const inputClass =
  'block w-full border-2 border-ink bg-paper px-3 py-3 text-base text-ink outline-none placeholder:text-ink-3 focus:border-ok aria-[invalid=true]:border-bad';

export default function ContactStep(props: {
  initial?: Partial<ContactValues>;
  /** Tocó «Empezar» antes de que cargara la página: se envía solo si está bien */
  autoSubmit?: boolean;
  onSubmit: (v: ContactValues) => void;
  /** Eventos del embudo */
  onSeen?: () => void;
  onTyping?: () => void;
  onAttempt?: () => void;
}) {
  const [values, setValues] = useState<ContactValues>({
    companyName: props.initial?.companyName ?? '',
    phone: formatPhone(props.initial?.phone ?? ''),
    email: props.initial?.email ?? '',
  });
  const [errors, setErrors] = useState<Partial<Record<keyof ContactValues, string>>>({});
  const typed = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  // «Vio el formulario»: cuando de verdad aparece en pantalla
  useEffect(() => {
    const el = formRef.current;
    if (!el || !props.onSeen) return;
    if (typeof IntersectionObserver === 'undefined') {
      props.onSeen();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        props.onSeen?.();
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (props.autoSubmit) submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    props.onAttempt?.();
    const errs = check(values);
    setErrors(errs);
    const first = (['companyName', 'phone', 'email'] as const).find((f) => errs[f]);
    if (first) {
      document.getElementById(`signup-${first === 'companyName' ? 'company' : first}`)?.focus();
      return;
    }
    props.onSubmit({ companyName: values.companyName.trim(), phone: values.phone, email: values.email.trim().toLowerCase() });
  }

  function set(field: keyof ContactValues, value: string) {
    if (!typed.current) {
      typed.current = true;
      props.onTyping?.();
    }
    const next = { ...values, [field]: value };
    setValues(next);
    if (errors[field]) setErrors((x) => ({ ...x, [field]: check(next)[field] }));
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[1fr_1fr] lg:items-start">
      <div className="mx-auto w-full max-w-md lg:mx-0">
        <h1 id="step-title" tabIndex={-1} className="text-[1.6rem] font-semibold leading-tight outline-none sm:text-3xl">
          Tu WhatsApp atendiendo solo. <span className="text-ink-2">Créalo gratis en 2 minutos.</span>
        </h1>

        <form id="signup-contact" ref={formRef} noValidate onSubmit={submit} className="mt-5 space-y-4" aria-label="Tus datos de contacto">
          <div>
            <label htmlFor="signup-company" className="mb-1 block text-sm font-semibold">Nombre de tu negocio</label>
            <input
              id="signup-company"
              name="companyName"
              className={inputClass}
              autoComplete="organization"
              autoCapitalize="words"
              enterKeyHint="next"
              maxLength={80}
              placeholder="Ej.: Restaurante Doña Rosa"
              value={values.companyName}
              aria-invalid={errors.companyName ? true : undefined}
              aria-describedby={errors.companyName ? 'signup-company-error' : undefined}
              onChange={(e) => set('companyName', e.target.value)}
            />
            {errors.companyName && <p id="signup-company-error" role="alert" className="mt-1 text-xs font-semibold text-bad">{errors.companyName}</p>}
          </div>

          <div>
            <label htmlFor="signup-phone" className="mb-1 block text-sm font-semibold">Tu WhatsApp</label>
            <div className="flex">
              <span className="flex items-center border-2 border-r-0 border-ink bg-bone-2 px-3 text-base font-semibold text-ink-2" aria-hidden>+57</span>
              <input
                id="signup-phone"
                name="phone"
                className={inputClass}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                enterKeyHint="go"
                placeholder="300 123 4567"
                value={values.phone}
                aria-invalid={errors.phone ? true : undefined}
                aria-describedby={errors.phone ? 'signup-phone-error' : undefined}
                onChange={(e) => set('phone', formatPhone(e.target.value))}
              />
            </div>
            {errors.phone && <p id="signup-phone-error" role="alert" className="mt-1 text-xs font-semibold text-bad">{errors.phone}</p>}
          </div>

          <button
            type="submit"
            className="flex w-full cursor-pointer items-center justify-center gap-2 bg-ink px-6 py-4 text-sm font-semibold uppercase tracking-[0.08em] text-bone shadow-[6px_6px_0_0_rgba(31,122,61,0.9)] transition-transform hover:-translate-y-0.5"
          >
            Empezar mi diagnóstico <ArrowRight size={16} aria-hidden />
          </button>

          <p className="flex items-start gap-2 text-xs text-ink-3">
            <Lock size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              Sin tarjeta. Al tocar «Empezar mi diagnóstico» autorizas que te escribamos por WhatsApp sobre tu cuenta, según la{' '}
              <Link to="/privacidad" target="_blank" className="font-semibold underline">política de tratamiento de datos</Link> (Ley 1581 de 2012).
            </span>
          </p>

          {/* Funciona sin JavaScript (HTML prerenderizado) */}
          <details className="text-sm" open={!!values.email || !!errors.email}>
            <summary className="cursor-pointer font-semibold text-ink-2 underline-offset-2 hover:underline">Agregar mi correo (opcional)</summary>
            <div className="mt-2">
              <label htmlFor="signup-email" className="mb-1 block text-xs text-ink-3">Te mandamos el resumen y, si te quedas a mitad, un enlace para seguir</label>
              <input
                id="signup-email"
                name="email"
                className={inputClass}
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                placeholder="nombre@gmail.com"
                value={values.email}
                aria-invalid={errors.email ? true : undefined}
                onChange={(e) => set('email', e.target.value.replace(/\s/g, ''))}
              />
              {errors.email && <p role="alert" className="mt-1 text-xs font-semibold text-bad">{errors.email}</p>}
            </div>
          </details>
        </form>
      </div>

      {/* La explicación va debajo del botón (en el celular, después de desplazar) */}
      <div className="space-y-6">
        <ul className="space-y-3">
          {BENEFITS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center border-2 border-ink bg-paper"><Icon size={16} aria-hidden /></span>
              <span>
                <b className="block text-[15px]">{title}</b>
                <span className="text-sm text-ink-2">{text}</span>
              </span>
            </li>
          ))}
        </ul>
        <figure className="border-2 border-ink bg-paper" aria-label="Ejemplo de cómo responde el asistente">
          <figcaption className="flex items-center gap-2 border-b-2 border-ink px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.08em]">
            <MessageCircle size={14} aria-hidden /> Ejemplo · restaurante con domicilios
          </figcaption>
          <div className="space-y-2.5 bg-bone p-4">
            {CHAT.map((m, i) => (
              <p key={i} className={m.from === 'client' ? 'mr-8 border-2 border-line bg-paper px-3 py-2 text-sm' : 'ml-8 border-2 border-ink bg-ink px-3 py-2 text-sm text-bone'}>
                {m.text}
              </p>
            ))}
          </div>
        </figure>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-3">
          <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" aria-hidden /> 5 preguntas · 2 minutos</li>
          <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" aria-hidden /> Sin tarjeta</li>
          <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" aria-hidden /> WhatsApp oficial de Meta</li>
        </ul>
      </div>
    </div>
  );
}

/** ¿La visita viene de un anuncio de Meta? (utm_source=meta/facebook/instagram o fbclid) */
export function fromAd(origin: { utmSource?: string; fbclid?: string }): boolean {
  return !!origin.fbclid || /^(meta|facebook|fb|instagram|ig)$/i.test(origin.utmSource ?? '');
}
