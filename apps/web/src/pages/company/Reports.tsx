import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { PageHeader, Tabs } from '../../components/ui';
import { useActiveCompany } from '../../lib/products';
import Analytics from './Analytics';
import Gerencia from './Gerencia';
import Opportunities from './Opportunities';

/**
 * Un solo lugar para ver cómo va el negocio (antes eran «Analítica» y
 * «Reporte a gerencia», que se pisaban):
 *  - Esta semana: lo que pasó y lo que hay que atender ya (citas, seguimientos vencidos, leads que se enfrían).
 *  - Tendencias: los últimos 30 días (volumen, canales, embudo y costo de la IA).
 */
const TABS = [
  { id: 'semana', label: 'Esta semana', hint: 'Qué pasó en los últimos 7 días comparado con la semana anterior, y lo que tu equipo debe atender hoy: citas próximas, seguimientos vencidos y clientes interesados que se están enfriando.' },
  { id: 'atender', label: 'Qué atender hoy', hint: 'Lo que BackOffice encontró en tus conversaciones y contactos y que vale plata: quién espera respuesta, a quién hacerle seguimiento y qué clientes reactivar. Cada uno dice cómo lo sabemos y qué hacer.' },
  { id: 'tendencias', label: 'Tendencias de 30 días', hint: 'Cómo se mueve tu atención en el mes: mensajes por día, por qué canal llegan, en qué etapa están tus clientes y cuánto costó la IA.' },
];

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const { company } = useActiveCompany();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab')! : 'semana';
  const current = TABS.find((t) => t.id === tab)!;
  const hasOrders = (company?.modules ?? []).includes('orders') && !(company?.businessProfile?.hides ?? []).includes('orders');
  return (
    <>
      <PageHeader kicker="Cómo va tu negocio" title="Reportes" />
      <Tabs active={tab} onChange={(id) => setParams({ tab: id }, { replace: true })} tabs={TABS.map(({ id, label }) => ({ id, label }))} />
      <p className="mb-6 mt-3 max-w-3xl text-sm text-ink-2">
        {current.hint}
        {hasOrders && <> Los números de ventas por pedido están en <Link to="/app/orders/reports" className="font-semibold underline">Reportes de pedidos</Link>.</>}
      </p>
      {tab === 'semana' ? <Gerencia embedded /> : tab === 'atender' ? <Opportunities embedded /> : <Analytics embedded />}
    </>
  );
}
