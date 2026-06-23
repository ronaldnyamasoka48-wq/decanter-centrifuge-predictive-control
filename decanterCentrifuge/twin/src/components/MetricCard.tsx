'use client';

import { motion } from 'framer-motion';

interface Props {
  label: string;
  value: number | string;
  unit?: string;
  icon?: string;
  colorClass?: string;
  subLabel?: string;
  pulse?: boolean;
}

export default function MetricCard({ label, value, unit, icon, colorClass = 'text-cyan-400', subLabel, pulse }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-xl border border-white/5 bg-gradient-to-br from-slate-900/80 to-slate-800/40 backdrop-blur-sm p-4 group hover:border-cyan-500/30 transition-all duration-300"
    >
      {/* Background glow */}
      <div className={`absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-gradient-to-br from-cyan-500/5 to-violet-500/5 pointer-events-none`} />

      {/* Top row */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-slate-400 uppercase tracking-widest">{label}</span>
        {icon && <span className="text-lg">{icon}</span>}
        {pulse && (
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500" />
          </span>
        )}
      </div>

      {/* Value */}
      <div className={`flex items-baseline gap-1 ${colorClass}`}>
        <span className="text-2xl font-bold font-mono tabular-nums tracking-tight">
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>
        {unit && <span className="text-xs text-slate-500 font-medium">{unit}</span>}
      </div>

      {subLabel && <p className="text-xs text-slate-600 mt-1">{subLabel}</p>}
    </motion.div>
  );
}
