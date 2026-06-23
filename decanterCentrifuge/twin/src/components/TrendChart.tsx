'use client';

import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { TrendPoint } from '@/lib/predictive-engine';

interface Props {
  history: TrendPoint[];
  activeMetric: 'bowlSpeed' | 'scrollSpeed' | 'energy' | 'flowRate' | 'gForce' | 'efficiency';
}

const METRIC_CONFIG = {
  bowlSpeed:   { color: '#00d4ff', label: 'Bowl Speed',   unit: 'RPM',  gradId: 'gradBowl' },
  scrollSpeed: { color: '#7c3aed', label: 'Scroll Speed', unit: 'RPM',  gradId: 'gradScroll' },
  energy:      { color: '#f59e0b', label: 'Energy',       unit: 'kW',   gradId: 'gradEnergy' },
  flowRate:    { color: '#10b981', label: 'Flow Rate',    unit: 'L/min', gradId: 'gradFlow' },
  gForce:      { color: '#f43f5e', label: 'G-Force',      unit: 'G',    gradId: 'gradG' },
  efficiency:  { color: '#a78bfa', label: 'Efficiency',   unit: '%',    gradId: 'gradEff' },
};

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: {value: number}[]; label?: string }) => {
  if (active && payload && payload.length) {
    return (
      <div className="rounded-lg border border-white/10 bg-slate-900/95 backdrop-blur px-3 py-2 text-xs">
        <p className="text-slate-400">{new Date(label || '').toLocaleTimeString()}</p>
        <p className="font-bold text-cyan-400">{payload[0].value.toFixed(1)}</p>
      </div>
    );
  }
  return null;
};

export default function TrendChart({ history, activeMetric }: Props) {
  const cfg = METRIC_CONFIG[activeMetric];
  const latest = history[history.length - 1]?.[activeMetric] ?? 0;

  return (
    <div className="w-full h-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={history} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
          <defs>
            <linearGradient id={cfg.gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={cfg.color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={cfg.color} stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3d" vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t: number) => new Date(t).toLocaleTimeString('en', { minute: '2-digit', second: '2-digit' })}
            tick={{ fill: '#475569', fontSize: 9 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fill: '#475569', fontSize: 9 }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={latest} stroke={cfg.color} strokeDasharray="6 3" strokeOpacity={0.4} />
          <Area
            type="monotone"
            dataKey={activeMetric}
            stroke={cfg.color}
            strokeWidth={2}
            fill={`url(#${cfg.gradId})`}
            dot={false}
            activeDot={{ r: 4, fill: cfg.color, stroke: '#020714', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
