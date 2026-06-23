'use client';

import { motion } from 'framer-motion';

interface GaugeProps {
  value: number;
  min: number;
  max: number;
  label: string;
  unit: string;
  color?: string;
  size?: number;
  warningAt?: number;
  criticalAt?: number;
}

export default function GaugeRing({
  value, min, max, label, unit,
  color = '#00d4ff', size = 120,
  warningAt, criticalAt,
}: GaugeProps) {
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const radius = size * 0.38;
  const stroke = size * 0.055;
  const circumference = 2 * Math.PI * radius;
  const arcPct = 0.75; // 270° arc
  const offset = circumference * (1 - arcPct * pct);
  const trackOffset = circumference * (1 - arcPct);
  const cx = size / 2;
  const cy = size / 2;

  let displayColor = color;
  if (criticalAt && value >= criticalAt) displayColor = '#f43f5e';
  else if (warningAt && value >= warningAt) displayColor = '#f59e0b';

  return (
    <div className="flex flex-col items-center gap-1">
      <div style={{ width: size, height: size }} className="relative">
        <svg width={size} height={size} className="-rotate-[225deg]">
          {/* Track */}
          <circle
            cx={cx} cy={cy} r={radius}
            fill="none"
            stroke="#0f2030"
            strokeWidth={stroke}
            strokeDasharray={`${circumference * arcPct} ${circumference * (1 - arcPct)}`}
            strokeDashoffset={0}
            strokeLinecap="round"
          />
          {/* Value arc */}
          <motion.circle
            cx={cx} cy={cy} r={radius}
            fill="none"
            stroke={displayColor}
            strokeWidth={stroke}
            strokeDasharray={`${circumference * arcPct} ${circumference * (1 - arcPct)}`}
            initial={{ strokeDashoffset: circumference * arcPct }}
            animate={{ strokeDashoffset: circumference * arcPct * (1 - pct) }}
            transition={{ type: 'spring', damping: 22, stiffness: 120 }}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 ${stroke * 0.6}px ${displayColor})` }}
          />
        </svg>
        {/* Center value */}
        <div className="absolute inset-0 flex flex-col items-center justify-center rotate-0">
          <motion.span
            key={value}
            initial={{ scale: 1.1 }}
            animate={{ scale: 1 }}
            className="text-white font-bold font-mono tabular-nums leading-none"
            style={{ fontSize: size * 0.15 }}
          >
            {value.toLocaleString()}
          </motion.span>
          <span className="text-slate-500 leading-none mt-0.5" style={{ fontSize: size * 0.09 }}>{unit}</span>
        </div>
      </div>
      <span className="text-xs text-slate-400 font-medium text-center leading-tight">{label}</span>
    </div>
  );
}
