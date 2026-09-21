import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import type { PersonaTemplate } from '../lib/types';
import { Badge, Button, Input, Loading, Modal } from './ui';

/**
 * Biblioteca de personalidades: plantillas globales de BackOffice +
 * las propias de la empresa, aplicables a un bot o a una línea con un clic.
 */
export function PersonaPicker({
  open,
  onClose,
  onApply,
  scopeQuery = '',
}: {
  open: boolean;
  onClose: () => void;
  onApply: (template: PersonaTemplate) => void;
  /** query de scope (companyId=…) cuando el usuario es de plataforma */
  scopeQuery?: string;
}) {
  const [search, setSearch] = useState('');
  const { data: templates, isLoading } = useQuery({
    queryKey: ['personas', scopeQuery],
    queryFn: () =>
      api.get<PersonaTemplate[]>(`/personas${scopeQuery ? `?${scopeQuery}` : ''}`),
    enabled: open,
  });

  const grouped = useMemo(() => {
    const filtered = (templates ?? []).filter(
      (t) =>
        !search ||
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.category.toLowerCase().includes(search.toLowerCase()),
    );
    const map = new Map<string, PersonaTemplate[]>();
    for (const t of filtered) {
      const list = map.get(t.category) ?? [];
      list.push(t);
      map.set(t.category, list);
    }
    return [...map.entries()];
  }, [templates, search]);

  return (
    <Modal open={open} onClose={onClose} kicker="Biblioteca de personalidades" title="Aplicar plantilla" wide>
      <div className="mb-4">
        <Input
          placeholder="Buscar por nombre o categoría…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {isLoading ? (
        <Loading />
      ) : (
        <div className="space-y-5">
          {grouped.map(([category, items]) => (
            <div key={category}>
              <p className="kicker mb-2">{category}</p>
              <div className="grid gap-3 md:grid-cols-2">
                {items.map((template) => (
                  <div key={template.id} className="flex flex-col border-2 border-ink bg-bone p-4">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="display text-lg">{template.name}</h3>
                      {template.companyId ? (
                        <Badge tone="info">Propia</Badge>
                      ) : (
                        <Badge tone="ink">BackOffice</Badge>
                      )}
                    </div>
                    <p className="mt-1 flex-1 text-xs text-ink-2">
                      {template.description ?? '—'}
                    </p>
                    {template.personality.tone && (
                      <p className="mt-2 text-[11px] text-ink-3">
                        Tono: {template.personality.tone}
                      </p>
                    )}
                    <Button
                      size="sm"
                      className="mt-3 w-full"
                      onClick={() => {
                        onApply(template);
                        onClose();
                      }}
                    >
                      Aplicar esta personalidad
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {grouped.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-3">
              No hay plantillas que coincidan.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
