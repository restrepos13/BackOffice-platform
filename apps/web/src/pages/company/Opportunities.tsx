import { OpportunityList } from '../../components/opportunities/Opportunities';
import { PageHeader } from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

/**
 * Oportunidades del CRM en Automation: chats que esperan respuesta, contactos
 * sin seguimiento, clientes para reactivar. Es el mismo Radar que ya existía
 * (antes solo se veía dentro de Creative); aquí se filtra a la fuente CRM.
 */
export default function Opportunities() {
  const { ready, q, canWrite } = useCompanyScope();
  if (!ready) return <PickCompany />;
  return (
    <>
      <PageHeader kicker="Ventas y clientes" title="Oportunidades" />
      <p className="mb-4 max-w-3xl text-sm text-ink-2">
        Lo que el sistema encontró en tus conversaciones y contactos: quién espera respuesta, a quién hacerle seguimiento y qué clientes reactivar. Cada una dice cómo lo sabemos y qué hacer.
      </p>
      <OpportunityList
        scope={(p) => withScope(p, q)}
        query={{ source: 'CRM' }}
        canWrite={canWrite}
        emptyHint="Por ahora no hay nada pendiente en tus conversaciones y contactos."
      />
    </>
  );
}
