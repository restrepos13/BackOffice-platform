import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const INK = '#1a1a1a';
const INK3 = '#6b6560';
const LINE = '#c3bbb2';
const OK = '#1f7a3d';
const WA = '#128c50';

const axisProps = {
  stroke: INK3,
  fontSize: 11,
  tickLine: false,
  axisLine: { stroke: INK },
} as const;

function BrutalTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="border-2 border-ink bg-paper px-3 py-2 text-xs shadow-[4px_4px_0_0_rgba(26,26,26,0.9)]">
      <p className="kicker mb-1">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2" style={{ background: p.color ?? p.fill }} />
          <span className="text-ink-2">{p.name}:</span>
          <span className="font-semibold">
            {formatter ? formatter(p.value) : p.value}
          </span>
        </p>
      ))}
    </div>
  );
}

const shortDate = (d: string) => {
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
};

/** Serie temporal de mensajes (in/out apilados). */
export function MessagesChart({
  data,
  keys,
}: {
  data: any[];
  keys: { key: string; name: string; color?: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="0" vertical={false} />
        <XAxis dataKey="date" {...axisProps} tickFormatter={shortDate} minTickGap={28} />
        <YAxis {...axisProps} />
        <Tooltip content={<BrutalTooltip />} />
        {keys.map((k, i) => (
          <Area
            key={k.key}
            type="stepAfter"
            dataKey={k.key}
            name={k.name}
            stackId="1"
            stroke={k.color ?? (i === 0 ? INK : WA)}
            fill={k.color ?? (i === 0 ? INK : WA)}
            fillOpacity={i === 0 ? 0.85 : 0.55}
            strokeWidth={1.5}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Serie de costos (USD). */
export function CostChart({ data }: { data: any[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={LINE} vertical={false} />
        <XAxis dataKey="date" {...axisProps} tickFormatter={shortDate} minTickGap={28} />
        <YAxis {...axisProps} tickFormatter={(v: number) => `$${v}`} />
        <Tooltip
          content={<BrutalTooltip formatter={(v: number) => `$${Number(v).toFixed(2)}`} />}
        />
        <Area
          type="stepAfter" dataKey="aiCostUsd" name="IA" stackId="1"
          stroke={INK} fill={INK} fillOpacity={0.85} strokeWidth={1.5}
        />
        <Area
          type="stepAfter" dataKey="waCostUsd" name="WhatsApp API" stackId="1"
          stroke={OK} fill={OK} fillOpacity={0.55} strokeWidth={1.5}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Serie simple de costo IA (una sola métrica USD). */
export function CostSeriesChart({ data, height = 240 }: { data: any[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke={LINE} vertical={false} />
        <XAxis dataKey="date" {...axisProps} tickFormatter={shortDate} minTickGap={28} />
        <YAxis {...axisProps} tickFormatter={(v: number) => `$${v}`} />
        <Tooltip
          content={<BrutalTooltip formatter={(v: number) => `$${Number(v).toFixed(2)}`} />}
        />
        <Area
          type="stepAfter" dataKey="costUsd" name="Costo IA"
          stroke={INK} fill={INK} fillOpacity={0.85} strokeWidth={1.5}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Barras horizontales simples (funnel, canales, top empresas). */
export function BarsChart({
  data,
  dataKey,
  labelKey,
  name,
  height = 220,
  formatter,
}: {
  data: any[];
  dataKey: string;
  labelKey: string;
  name: string;
  height?: number;
  formatter?: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
      >
        <CartesianGrid stroke={LINE} horizontal={false} />
        <XAxis type="number" {...axisProps} />
        <YAxis
          type="category" dataKey={labelKey} {...axisProps} width={110}
          tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
        />
        <Tooltip content={<BrutalTooltip formatter={formatter} />} />
        <Bar dataKey={dataKey} name={name} fill={INK} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}
