import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import type { AuditEntry, Company } from '../../lib/types';
import { Badge, Input, Loading, PageHeader, Select, Table } from '../../components/ui';

export default function Audit() {
  const [companyId, setCompanyId] = useState('');
  const [search, setSearch] = useState('');

  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
  });
  const { data, isLoading } = useQuery({
    queryKey: ['audit-full', companyId],
    queryFn: () =>
      api.get<AuditEntry[]>(`/audit?take=300${companyId ? `&companyId=${companyId}` : ''}`),
  });

  const filtered = (data ?? []).filter(
    (entry) =>
      !search ||
      entry.action.includes(search.toLowerCase()) ||
      (entry.detail ?? '').toLowerCase().includes(search.toLowerCase()) ||
      entry.actorName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <>
      <PageHeader kicker="Trazabilidad" title="Auditoría" />

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          placeholder="Buscar acción, detalle o actor…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="max-w-[220px]">
          <option value="">Todas las empresas</option>
          {companies?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>

      {isLoading ? (
        <Loading />
      ) : (
        <Table head={['Fecha', 'Acción', 'Detalle', 'Actor', 'Empresa']}>
          {filtered.map((entry) => (
            <tr key={entry.id}>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-3">
                {fmtDateTime(entry.createdAt)}
              </td>
              <td className="px-4 py-3">
                <Badge tone={entry.action.includes('delete') ? 'bad' : entry.action.includes('create') || entry.action.includes('provision') ? 'ok' : 'neutral'}>
                  {entry.action}
                </Badge>
              </td>
              <td className="px-4 py-3 text-sm">{entry.detail ?? '—'}</td>
              <td className="px-4 py-3 text-sm">{entry.actorName}</td>
              <td className="px-4 py-3 text-sm text-ink-3">{entry.company?.name ?? '—'}</td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={5} className="px-4 py-10 text-center text-ink-3">Sin registros.</td></tr>
          )}
        </Table>
      )}
    </>
  );
}
