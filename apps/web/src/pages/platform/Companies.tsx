import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { COMPANY_STATUS_LABELS, fmtDate, fmtUsd, planPriceLabel } from '../../lib/format';
import type { Company } from '../../lib/types';
import {
  Badge, Button, Input, Loading, PageHeader, Select, Table, statusTone,
} from '../../components/ui';

export default function Companies() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
  });

  const filtered = (data ?? []).filter(
    (c) =>
      (!status || c.status === status) &&
      (!search ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        (c.country ?? '').toLowerCase().includes(search.toLowerCase()) ||
        (c.industry ?? '').toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <>
      <PageHeader
        kicker="Plataforma"
        title="Empresas"
        actions={
          <Link to="/platform/companies/new">
            <Button>+ Nueva empresa</Button>
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          placeholder="Buscar por nombre, país o industria…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[180px]">
          <option value="">Todos los estados</option>
          {Object.entries(COMPANY_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>
      </div>

      {isLoading ? (
        <Loading />
      ) : (
        <Table head={['Empresa', 'Plan', 'Estado', 'Usuarios', 'Bots', 'Convers.', 'Alta', '']}>
          {filtered.map((c) => (
            <tr
              key={c.id}
              className="cursor-pointer hover:bg-bone-2"
              onClick={() => navigate(`/platform/companies/${c.id}`)}
            >
              <td className="px-4 py-3">
                <p className="font-semibold">{c.name}</p>
                <p className="text-xs text-ink-3">
                  {[c.industry, c.country].filter(Boolean).join(' · ')}
                </p>
              </td>
              <td className="px-4 py-3">
                {c.plan ? (
                  <>
                    <p className="text-[13px] font-medium">{c.plan.name}</p>
                    <p className="text-xs text-ink-3">{planPriceLabel(c.plan, false)}{c.billingCycle === 'ANNUAL' ? ' · anual' : ''}</p>
                  </>
                ) : (
                  <span className="text-ink-3">—</span>
                )}
              </td>
              <td className="px-4 py-3">
                {c.status === 'TRIAL' && c.trialEndsAt && new Date(c.trialEndsAt) < new Date() ? (
                  <Badge tone="bad">Trial vencido</Badge>
                ) : (
                  <Badge tone={statusTone(c.status)}>{COMPANY_STATUS_LABELS[c.status]}</Badge>
                )}
              </td>
              <td className="px-4 py-3 tabular-nums">{c._count?.users ?? 0}</td>
              <td className="px-4 py-3 tabular-nums">{c._count?.bots ?? 0}</td>
              <td className="px-4 py-3 tabular-nums">{c._count?.conversations ?? 0}</td>
              <td className="px-4 py-3 text-xs text-ink-3">{fmtDate(c.createdAt)}</td>
              <td className="px-4 py-3 text-right text-ink-3">→</td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-10 text-center text-ink-3">
                No hay empresas que coincidan.
              </td>
            </tr>
          )}
        </Table>
      )}
    </>
  );
}
