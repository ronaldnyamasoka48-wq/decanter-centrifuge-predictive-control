'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, CheckCircle2, XCircle, Info } from 'lucide-react';

interface Props {
  status: 'OPTIMAL' | 'WARNING' | 'CRITICAL' | 'STANDBY';
  alerts: string[];
  confidence: number;
}

const STATUS_CONFIG = {
  OPTIMAL:  { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', icon: CheckCircle2, label: 'OPTIMAL' },
  WARNING:  { color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   icon: AlertTriangle, label: 'WARNING' },
  CRITICAL: { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30',     icon: XCircle,       label: 'CRITICAL' },
  STANDBY:  { color: 'text-slate-400',   bg: 'bg-slate-500/10',   border: 'border-slate-500/30',   icon: Info,          label: 'STANDBY' },
};

export default function StatusPanel({ status, alerts, confidence }: Props) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;

  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-4 space-y-3`}>
      {/* Status header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <motion.div
            animate={{ scale: status === 'CRITICAL' ? [1, 1.15, 1] : 1 }}
            transition={{ repeat: Infinity, duration: 0.8 }}
          >
            <Icon className={`w-5 h-5 ${cfg.color}`} />
          </motion.div>
          <span className={`font-bold text-sm tracking-widest uppercase ${cfg.color}`}>
            System {cfg.label}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-500">AI Confidence</span>
          <span className={`text-xs font-bold font-mono ${cfg.color}`}>{confidence}%</span>
        </div>
      </div>

      {/* Alerts */}
      <AnimatePresence>
        {alerts.length === 0 ? (
          <motion.p
            key="no-alerts"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-xs text-slate-500"
          >
            No active alerts — all parameters within operational envelope.
          </motion.p>
        ) : (
          <ul className="space-y-1.5">
            {alerts.map((alert, i) => (
              <motion.li
                key={alert}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ delay: i * 0.05 }}
                className="text-xs text-amber-300/80 bg-amber-900/10 rounded-lg px-3 py-1.5 border border-amber-700/20"
              >
                {alert}
              </motion.li>
            ))}
          </ul>
        )}
      </AnimatePresence>
    </div>
  );
}
