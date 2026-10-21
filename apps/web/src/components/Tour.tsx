import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Tour de bienvenida: se muestra UNA sola vez por usuario (User.tourDoneAt en
 * la base — funciona igual en cualquier dispositivo). Pasos según el rol.
 * Sin librerías: overlay propio anclado a elementos [data-tour].
 */

interface TourStep {
  target: string; // valor de data-tour, '' = paso centrado sin ancla
  title: string;
  body: string;
}

const PLATFORM_STEPS: TourStep[] = [
  { target: '', title: 'Bienvenido a BackOffice', body: 'Este es el panel de plataforma: desde aquí administras TODAS las empresas del estudio. Te mostramos lo esencial en 30 segundos.' },
  { target: 'nav-platform', title: 'Panel de plataforma', body: 'Empresas, planes, personalidades, modelos IA, consumo global, correos y auditoría. Todo lo del estudio vive aquí.' },
  { target: 'company-picker', title: 'Entrar a cualquier empresa', body: 'Elige una empresa y verás SU panel tal como lo ve el cliente — ideal para soporte y configuración.' },
  { target: 'nav-company', title: 'El panel del cliente', body: 'Bandeja con IA, CRM, pedidos (si la empresa tiene el módulo), reportes y configuración. Cambia según los módulos contratados.' },
];

const COMPANY_STEPS: TourStep[] = [
  { target: '', title: '¡Bienvenido!', body: 'Este es el panel de tu empresa. En 30 segundos te mostramos dónde está todo.' },
  { target: 'nav-inbox', title: 'Conversaciones', body: 'Aquí ves TODO lo que conversa tu asistente IA por WhatsApp, en vivo. Puedes intervenir como humano cuando quieras — la IA se pausa sola en esa conversación.' },
  { target: 'nav-orders', title: 'Pedidos', body: 'Los pedidos que toma la IA (o tu equipo) con su trazabilidad completa: confirmación, áreas de producción, recordatorios y entrega.' },
  { target: 'nav-reports', title: 'Reportes', body: 'El reporte diario con alertas, comparativos, la precisión real de la IA y una pestaña para preguntarle a tus datos en lenguaje natural.' },
  { target: 'nav-usage', title: 'Consumo IA', body: 'Cuánto consume tu IA y tus mensajes de WhatsApp, en tu moneda y con proyección de fin de mes. Sin sorpresas.' },
  { target: 'nav-settings', title: 'Configuración', body: 'Los datos de tu empresa, horarios y catálogo. Lo técnico lo dejamos listo contigo en una llamada.' },
];

const AREA_STEPS: TourStep[] = [
  { target: '', title: '¡Bienvenido!', body: 'Esta es tu vista de trabajo: solo lo de tu área, sin ruido.' },
  { target: 'nav-area', title: 'Tu área', body: 'Aquí caen los ítems de los pedidos confirmados que le tocan a tu área, ordenados por hora de entrega. Cuando termines algo, márcalo listo.' },
];

export default function Tour() {
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const steps = useMemo(() => {
    if (!user) return [];
    if (user.role === 'COMPANY_AREA') return AREA_STEPS;
    if (user.role === 'SUPER_ADMIN' || user.role === 'DEV') return PLATFORM_STEPS;
    const base = [...COMPANY_STEPS];
    // Sin módulo de pedidos: se quitan esos pasos (los data-tour no existen)
    return base;
  }, [user]);

  // En "Primeros pasos" la guía es la IA: el tour espera a que la empresa esté lista
  const onboarding = user?.company?.status === 'ONBOARDING';
  // Primero los términos: el tour no se monta encima del aviso de aceptación (misma consulta en caché)
  const needsTerms = user?.role === 'COMPANY_ADMIN' || user?.role === 'COMPANY_VIEWER';
  const { data: terms } = useQuery({
    queryKey: ['terms-status'],
    queryFn: () => api.get<{ required: boolean }>('/terms/status'),
    enabled: !!user && needsTerms,
  });
  const termsPending = needsTerms && (!terms || terms.required);
  const show = !!user && !user.tourDoneAt && !dismissed && !onboarding && !termsPending && steps.length > 0;
  const current = steps[step];

  // Medir el ancla del paso actual (y seguirla si la ventana cambia)
  useEffect(() => {
    if (!show || !current) return;
    const measure = () => {
      if (!current.target) {
        setAnchor(null);
        return;
      }
      const el = document.querySelector(`[data-tour="${current.target}"]`);
      if (!el) {
        setAnchor(null);
        return;
      }
      el.scrollIntoView({ block: 'nearest' });
      setAnchor(el.getBoundingClientRect());
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [show, current]);

  if (!show || !current) return null;

  // Si el ancla no existe (módulo no contratado), saltar el paso
  if (current.target && !document.querySelector(`[data-tour="${current.target}"]`)) {
    if (step < steps.length - 1) {
      setStep(step + 1);
      return null;
    }
  }

  const finish = () => {
    setDismissed(true);
    api.post('/auth/tour-done').catch(() => undefined);
  };

  const next = () => (step < steps.length - 1 ? setStep(step + 1) : finish());

  // Posición de la tarjeta: junto al ancla, o centrada
  const cardStyle: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        top: Math.min(anchor.top, window.innerHeight - 240),
        left: Math.min(anchor.right + 16, window.innerWidth - 360),
        maxWidth: 340,
      }
    : {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        maxWidth: 380,
      };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label="Tour de bienvenida">
      {/* Velo con recorte sobre el ancla */}
      <div className="absolute inset-0 bg-ink/60" onClick={finish} aria-hidden />
      {anchor && (
        <div
          className="pointer-events-none absolute border-2 border-bone bg-transparent shadow-[0_0_0_9999px_rgba(26,26,26,0.6)]"
          style={{
            top: anchor.top - 4, left: anchor.left - 4,
            width: anchor.width + 8, height: anchor.height + 8,
          }}
          aria-hidden
        />
      )}
      <div
        className="border-2 border-ink bg-paper p-5 shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]"
        style={cardStyle}
      >
        <p className="kicker">
          Paso {step + 1} de {steps.length}
        </p>
        <h2 className="display mt-1 text-xl">{current.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">{current.body}</p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            onClick={finish}
            className="cursor-pointer text-xs font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-ink"
          >
            Saltar tour
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(step - 1)}
                className="cursor-pointer border-2 border-ink px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] hover:bg-bone-2"
              >
                ← Atrás
              </button>
            )}
            <button
              onClick={next}
              className="cursor-pointer border-2 border-ink bg-ink px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-bone hover:bg-transparent hover:text-ink"
            >
              {step === steps.length - 1 ? 'Empezar ✓' : 'Siguiente →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
