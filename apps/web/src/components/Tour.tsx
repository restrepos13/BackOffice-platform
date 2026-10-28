import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Recorridos guiados. El de bienvenida se muestra UNA sola vez por usuario
 * (User.tourDoneAt) y los de cada sección también (User.toursJson): funciona
 * igual en cualquier dispositivo. Sin librerías: overlay propio anclado a
 * elementos [data-tour].
 */

export interface TourStep {
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
  { target: 'product-switcher', title: 'Tus productos', body: 'BackOffice tiene tres productos: Automation (ventas, atención y operación con IA), Creative (diseños y marca) y Ads Intelligence (publicidad). Aquí cambias de uno a otro; el menú de abajo muestra solo lo del producto activo.' },
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

/** Recorrido de Ads Intelligence: qué hace la plataforma con la cuenta de Meta. */
export const ADS_STEPS: TourStep[] = [
  { target: '', title: 'Así funciona Ads Intelligence', body: 'BackOffice lee tus campañas de Facebook e Instagram, las mide y te dice en palabras simples qué está funcionando y qué no. Con permisos completos también puede pausar anuncios o crear campañas en pausa, pero nada cambia en tu cuenta de Meta sin que tú lo apruebes.' },
  { target: 'ads-cuentas', title: '1. Conecta tu cuenta publicitaria', body: 'Aquí conectas tu cuenta de Meta Ads con una guía paso a paso: dándole acceso de socio a BackOffice o con un token de tu negocio. Nunca te pedimos tu contraseña de Facebook. Traemos 60 días, actualizamos cada 6 horas y te mostramos qué permisos quedaron activos.' },
  { target: 'ads-resumen', title: '2. Resultados', body: 'Gasto, impresiones, clics, CTR, CPC y CPM del periodo, comparados con el periodo anterior. El día de hoy no se cuenta hasta que termina, para no comparar un día a medias. Los días son los de la zona horaria de tu cuenta, como en Meta.' },
  { target: 'ads-campanas', title: '3. Campañas', body: 'Cada campaña se mide por lo que busca: conversaciones, formularios o visitas a tu web. Si mezclas objetivos distintos no inventamos un «costo por resultado» total: lo ves campaña por campaña.' },
  { target: 'ads-crear', title: '4. Crear anuncios', body: 'Un paso a paso: página, objetivo, público, presupuesto, fechas, imagen y texto. Antes de crearlo lo revisamos: con reglas siempre y, si configuraste tu proveedor de IA, también con IA (ese consumo lo pagas aparte a tu proveedor). Se crea en pausa; tú lo activas.' },
  { target: 'ads-semana', title: '5. Programación semanal', body: 'Una vista de lunes a domingo con lo que corre cada día: lo que creaste en BackOffice y lo que ya tenías en Meta.' },
  { target: 'ads-oportunidades', title: '6. Oportunidades', body: 'Cuando algo cambia (el costo sube, el gasto se cae, un anuncio gasta sin resultados) te avisamos con los datos, la regla que lo detectó y qué revisar. Puedes posponer o descartar cada aviso.' },
  { target: 'ads-autopilot', title: '7. Tú decides', body: 'Por defecto BackOffice solo analiza. Si activas recomendaciones, una persona aprueba cada pausa y queda registrado quién la aprobó. BackOffice nunca sube presupuestos ni activa campañas por su cuenta.' },
  { target: 'ads-leads', title: '8. Leads y ventas', body: 'Si más adelante conectas tu WhatsApp o tus formularios a BackOffice, aquí verás qué anuncios traen clientes y ventas reales, no solo clics.' },
  { target: '', title: 'Listo', body: 'Empieza conectando tu cuenta en «Cuentas publicitarias». Puedes volver a ver este recorrido cuando quieras con el botón «¿Cómo funciona?».' },
];

/** Si el ancla no se ve (menú cerrado en el celular), el paso se muestra centrado. */
function visibleAnchor(target: string): DOMRect | null {
  if (!target) return null;
  const el = document.querySelector(`[data-tour="${target}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** Overlay del recorrido. skipMissing: salta los pasos cuyo ancla no existe (módulos no contratados). */
export function TourOverlay({ steps, label, skipMissing = false, onFinish }: { steps: TourStep[]; label: string; skipMissing?: boolean; onFinish: () => void }) {
  const [step, setStep] = useState(0);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const current = steps[step];

  // Medir el ancla del paso actual (y seguirla si la ventana cambia)
  useEffect(() => {
    if (!current) return;
    const measure = () => {
      const el = current.target ? document.querySelector(`[data-tour="${current.target}"]`) : null;
      el?.scrollIntoView({ block: 'nearest' });
      setAnchor(visibleAnchor(current.target));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [current]);

  if (!current) return null;

  // Si el ancla no existe (módulo no contratado), saltar el paso
  if (skipMissing && current.target && !document.querySelector(`[data-tour="${current.target}"]`)) {
    if (step < steps.length - 1) {
      setStep(step + 1);
      return null;
    }
  }

  const next = () => (step < steps.length - 1 ? setStep(step + 1) : onFinish());

  // Posición de la tarjeta: junto al ancla, o centrada
  const cardStyle: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        top: Math.max(16, Math.min(anchor.top, window.innerHeight - 280)),
        left: Math.max(16, Math.min(anchor.right + 16, window.innerWidth - 356)),
        maxWidth: 340,
      }
    : {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        maxWidth: 380,
        width: 'calc(100vw - 32px)',
      };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label={label}>
      {/* Velo con recorte sobre el ancla */}
      <div className="absolute inset-0 bg-ink/60" onClick={onFinish} aria-hidden />
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
            onClick={onFinish}
            className="cursor-pointer text-xs font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-ink"
          >
            Saltar recorrido
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

/** Los recorridos esperan a que el cliente acepte los términos (misma consulta en caché). */
function useTermsPending() {
  const { user } = useAuth();
  const needsTerms = user?.role === 'COMPANY_ADMIN' || user?.role === 'COMPANY_VIEWER';
  const { data: terms } = useQuery({
    queryKey: ['terms-status'],
    queryFn: () => api.get<{ required: boolean }>('/terms/status'),
    enabled: !!user && needsTerms,
  });
  return needsTerms && (!terms || terms.required);
}

/** Recorridos de sección ya vistos por el usuario. */
export function toursSeen(json: string | null | undefined): Record<string, string> {
  try {
    const v = JSON.parse(json ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Tour de bienvenida. Con solo Ads contratado no aplica: lo reemplaza el recorrido de Ads. */
export default function Tour({ products }: { products?: string[] }) {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  const steps = useMemo(() => {
    if (!user) return [];
    if (user.role === 'COMPANY_AREA') return AREA_STEPS;
    if (user.role === 'SUPER_ADMIN' || user.role === 'DEV') return PLATFORM_STEPS;
    if (products && products.length === 1 && products[0] === 'ADS') return [];
    return COMPANY_STEPS;
  }, [user, products]);

  // En "Primeros pasos" la guía es la IA: el tour espera a que la empresa esté lista
  const onboarding = user?.company?.status === 'ONBOARDING';
  const termsPending = useTermsPending();
  const show = !!user && !user.tourDoneAt && !dismissed && !onboarding && !termsPending && steps.length > 0;
  if (!show) return null;

  const finish = () => {
    setDismissed(true);
    api.post('/auth/tour-done').catch(() => undefined);
  };
  return <TourOverlay steps={steps} label="Tour de bienvenida" skipMissing onFinish={finish} />;
}

/**
 * Recorrido de Ads: la primera vez que un usuario de la empresa entra a Ads
 * (aunque la empresa siga en configuración), o cuando lo pide con «¿Cómo funciona?».
 */
export function AdsTour({ replay, onClose }: { replay: boolean; onClose: () => void }) {
  const { user, markTourSeen } = useAuth();
  const [closed, setClosed] = useState(false);
  const termsPending = useTermsPending();
  const company = !!user && !['SUPER_ADMIN', 'DEV', 'COMPANY_AREA', 'COMPANY_COURIER'].includes(user.role);
  const firstTime = company && !toursSeen(user?.toursJson).ads && !termsPending && !closed;
  if (!replay && !firstTime) return null;

  const finish = () => {
    setClosed(true);
    onClose();
    if (firstTime) markTourSeen('ads');
  };
  return <TourOverlay steps={ADS_STEPS} label="Recorrido de Ads Intelligence" onFinish={finish} />;
}
