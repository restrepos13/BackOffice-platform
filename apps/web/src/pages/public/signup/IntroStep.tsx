import { ArrowRight, Check, Clock, MessageCircle, ShoppingBag, UserCheck } from 'lucide-react';

/**
 * Entrada para quien llega de un anuncio (utm_source=meta o fbclid): una sola
 * pantalla que continúa el anuncio (qué es, qué gana, cuánto toma) antes del
 * formulario. Antes se saltaba del reel a «Paso 1 de 4» en seco.
 * Quien llega desde la web entra directo al formulario.
 */

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

export default function IntroStep({ onStart }: { onStart: () => void }) {
  return (
    <div className="mx-auto grid max-w-5xl items-center gap-10 lg:grid-cols-[1.2fr_1fr]">
      <div>
        <p className="kicker mb-3">Asistente de WhatsApp con IA · Colombia</p>
        <h1 id="step-title" tabIndex={-1} className="display text-[clamp(2.3rem,9vw,4.4rem)] leading-[0.95] outline-none">
          Tu WhatsApp atendiendo solo,{' '}
          <span className="serif-accent text-[0.82em] normal-case">mientras tú trabajas.</span>
        </h1>
        <p className="mt-3 max-w-lg text-base text-ink-2 sm:mt-4 sm:text-[17px]">
          Cuéntanos de tu negocio y en 2 minutos armamos tu asistente: responde, vende y agenda por ti.
        </p>

        <ul className="mt-5 space-y-2.5 sm:mt-6 sm:space-y-3">
          {BENEFITS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center border-2 border-ink bg-paper sm:h-9 sm:w-9"><Icon size={16} aria-hidden /></span>
              <span className="self-center sm:self-auto">
                <b className="block text-[15px]">{title}</b>
                {/* En el celular solo el título: el botón tiene que verse sin desplazar */}
                <span className="hidden text-sm text-ink-2 sm:inline">{text}</span>
              </span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={onStart}
          className="mt-6 inline-flex w-full whitespace-nowrap sm:mt-8 cursor-pointer items-center justify-center gap-2 bg-ink px-6 py-4 text-sm font-semibold uppercase tracking-[0.08em] text-bone shadow-[6px_6px_0_0_rgba(31,122,61,0.9)] transition-transform hover:-translate-y-0.5 sm:w-auto"
        >
          Armar mi asistente gratis <ArrowRight size={16} aria-hidden />
        </button>
        <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-3">
          <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" aria-hidden /> Toma 2 minutos</li>
          <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" aria-hidden /> Sin tarjeta</li>
          <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" aria-hidden /> Desde el celular</li>
          <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" aria-hidden /> WhatsApp oficial de Meta</li>
        </ul>
      </div>

      {/* Ejemplo de conversación (ilustrativo) */}
      <figure className="border-2 border-ink bg-paper" aria-label="Ejemplo de cómo responde el asistente">
        <figcaption className="flex items-center gap-2 border-b-2 border-ink px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.08em]">
          <MessageCircle size={14} aria-hidden /> Ejemplo · restaurante con domicilios
        </figcaption>
        <div className="space-y-2.5 bg-bone p-4">
          {CHAT.map((m, i) => (
            <p
              key={i}
              className={m.from === 'client'
                ? 'mr-8 border-2 border-line bg-paper px-3 py-2 text-sm'
                : 'ml-8 border-2 border-ink bg-ink px-3 py-2 text-sm text-bone'}
            >
              {m.text}
            </p>
          ))}
        </div>
      </figure>
    </div>
  );
}

/** ¿La visita viene de un anuncio de Meta? (utm_source=meta/facebook/instagram o fbclid) */
export function fromAd(origin: { utmSource?: string; fbclid?: string }): boolean {
  return !!origin.fbclid || /^(meta|facebook|fb|instagram|ig)$/i.test(origin.utmSource ?? '');
}
