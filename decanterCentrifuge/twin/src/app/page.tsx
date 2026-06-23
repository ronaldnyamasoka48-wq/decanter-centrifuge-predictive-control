'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import {
  predict, generateTrendHistory,
  type FeedProperties, type ControlOutputs, type TrendPoint
} from '@/lib/predictive-engine';
import {
  SerialBridge, telemetryToOutputs, telemetryToTrendPoint,
  type Esp32Telemetry
} from '@/lib/serial-bridge';
import MetricCard from '@/components/MetricCard';
import StatusPanel from '@/components/StatusPanel';
import GaugeRing from '@/components/GaugeRing';
import SerialConnect from '@/components/SerialConnect';
import HardwarePanel from '@/components/HardwarePanel';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import {
  Activity, Cpu, Zap, Gauge, Droplets, Wind,
  Thermometer, FlaskConical, Settings2, Play, Pause,
  RefreshCw, ChevronRight, BarChart3, AlertTriangle, Wifi,
  Download, Trash2,
} from 'lucide-react';

const CentrifugeCanvas = dynamic(() => import('@/components/CentrifugeCanvas'), { ssr: false });
const TrendChart = dynamic(() => import('@/components/TrendChart'), { ssr: false });

// ─── Default feed parameters ──────────────────────────────────
const DEFAULT_FEED: FeedProperties = {
  density:      1.25,
  solidContent: 25,
  viscosity:    120,
  particleSize: 80,
  temperature:  35,
  flowRate:     60,
};

// ─── Slider config ────────────────────────────────────────────
const FEED_SLIDERS = [
  { key: 'density',      label: 'Feed Density',      unit: 'g/cm³', min: 1.0,  max: 1.8,   step: 0.01, icon: FlaskConical,  color: '#00d4ff', decimals: 2 },
  { key: 'solidContent', label: 'Solid Content',     unit: '%',     min: 0,    max: 60,    step: 0.5,  icon: BarChart3,     color: '#f59e0b', decimals: 1 },
  { key: 'viscosity',    label: 'Viscosity',         unit: 'cP',    min: 1,    max: 5000,  step: 10,   icon: Droplets,      color: '#7c3aed', decimals: 0 },
  { key: 'particleSize', label: 'Particle Size',     unit: 'µm',    min: 1,    max: 500,   step: 1,    icon: Wind,          color: '#10b981', decimals: 0 },
  { key: 'temperature',  label: 'Feed Temperature',  unit: '°C',    min: 10,   max: 80,    step: 0.5,  icon: Thermometer,   color: '#f43f5e', decimals: 1 },
  { key: 'flowRate',     label: 'Feed Flow Rate',    unit: 'L/min', min: 5,    max: 200,   step: 1,    icon: Gauge,         color: '#a78bfa', decimals: 0 },
] as const;

type MetricKey = 'bowlSpeed' | 'scrollSpeed' | 'energy' | 'flowRate' | 'gForce' | 'efficiency';

const TREND_TABS: { key: MetricKey; label: string }[] = [
  { key: 'bowlSpeed',   label: 'Bowl RPM' },
  { key: 'scrollSpeed', label: 'Scroll RPM' },
  { key: 'energy',      label: 'Energy' },
  { key: 'flowRate',    label: 'Flow Rate' },
  { key: 'gForce',      label: 'G-Force' },
  { key: 'efficiency',  label: 'Efficiency' },
];

export default function Dashboard() {
  const [feed, setFeed]       = useState<FeedProperties>(DEFAULT_FEED);
  const [outputs, setOutputs] = useState<ControlOutputs>(() => predict(DEFAULT_FEED));
  const [history, setHistory] = useState<TrendPoint[]>(() => generateTrendHistory(DEFAULT_FEED, 60));
  const [running, setRunning] = useState(true);
  const [trendKey, setTrendKey] = useState<MetricKey>('bowlSpeed');
  const [tick, setTick] = useState(0);
  const [isLive, setIsLive]   = useState(false);
  const [dataLog, setDataLog] = useState<Esp32Telemetry[]>([]);
  const [latestTelemetry, setLatestTelemetry] = useState<Esp32Telemetry | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bridgeRef = useRef<SerialBridge | null>(null);

  // ── Predict on feed change (simulation mode only) ──────────
  useEffect(() => {
    if (!isLive) {
      const out = predict(feed);
      setOutputs(out);
    }
  }, [feed, isLive]);

  // ── Real-time tick (simulation jitter or live serial) ──────
  useEffect(() => {
    if (!running) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    if (isLive) {
      // In live mode, serial data drives outputs/trends — skip sim tick
      return;
    }

    intervalRef.current = setInterval(() => {
      setTick(t => t + 1);
      const noisy: FeedProperties = {
        density:      feed.density      * (1 + (Math.random() - 0.5) * 0.02),
        solidContent: feed.solidContent * (1 + (Math.random() - 0.5) * 0.04),
        viscosity:    feed.viscosity    * (1 + (Math.random() - 0.5) * 0.05),
        particleSize: feed.particleSize * (1 + (Math.random() - 0.5) * 0.04),
        temperature:  feed.temperature  * (1 + (Math.random() - 0.5) * 0.03),
        flowRate:     feed.flowRate     * (1 + (Math.random() - 0.5) * 0.03),
      };
      const out = predict(noisy);
      setHistory(prev => [
        ...prev.slice(-119),
        {
          time:        Date.now(),
          bowlSpeed:   out.bowlSpeed,
          scrollSpeed: out.scrollSpeed,
          energy:      out.energyConsumption,
          flowRate:    out.adjustedFlowRate,
          gForce:      out.gForce,
          efficiency:  out.separationEfficiency,
        },
      ]);
    }, 2500);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [running, feed, isLive]);

  // ── Serial data handler ────────────────────────────────────
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge || !isLive) return;

    bridge.onData = (t: Esp32Telemetry) => {
      const out = telemetryToOutputs(t, feed.density);
      setOutputs(out);
      setHistory(prev => [
        ...prev.slice(-119),
        telemetryToTrendPoint(t, feed.density),
      ]);
      setDataLog(prev => [...prev, t]);
      setLatestTelemetry(t);
    };

    return () => { if (bridge) bridge.onData = null; };
  }, [isLive, feed.density]);

  const handleSlider = useCallback((key: keyof FeedProperties, val: number[]) => {
    setFeed(prev => ({ ...prev, [key]: val[0] }));
    // In live mode, send relevant changes to ESP32
    if (isLive && bridgeRef.current) {
      if (key === 'flowRate') {
        bridgeRef.current.send(`SET:${Math.round(outputs.bowlSpeed)},${Math.round(outputs.scrollSpeed)}`);
      }
    }
  }, [isLive, outputs.bowlSpeed, outputs.scrollSpeed]);

  const handleReset = useCallback(() => {
    setFeed(DEFAULT_FEED);
    setHistory(generateTrendHistory(DEFAULT_FEED, 60));
  }, []);

  const exportCsv = useCallback(() => {
    if (dataLog.length === 0) return;
    const headers = 'timestamp,flowKgh,oilLevelCm,tempC,bowlRpm,screwRpm,bowlCurrentA,totalPowerW,specificEnergy,predictedEff,pumpOn,pumpMode';
    const rows = dataLog.map(t => {
      const ts = new Date().toISOString();
      return `${ts},${t.flowKgh},${t.oilLevelCm},${t.tempC},${t.bowlRpm},${t.screwRpm},${t.bowlCurrentA},${t.totalPowerW},${t.specificEnergy},${t.predictedEff},${t.pumpOn ? 1 : 0},${t.pumpMode}`;
    });
    const csv = headers + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `decanter_data_${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }, [dataLog]);

  const clearLog = useCallback(() => setDataLog([]), []);

  return (
    <div className="min-h-screen bg-[#020714] text-white font-sans overflow-x-hidden" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* ── Ambient background blobs ── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-cyan-500/8 rounded-full blur-3xl" />
        <div className="absolute top-1/3 right-0 w-80 h-80 bg-violet-600/6 rounded-full blur-3xl" />
        <div className="absolute bottom-0 left-1/3 w-72 h-72 bg-blue-600/5 rounded-full blur-3xl" />
      </div>

      {/* ═══ HEADER ══════════════════════════════════════════════ */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-[#020714]/80 backdrop-blur-xl">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-7 h-7 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center">
                <Activity className="w-4 h-4 text-cyan-400" />
              </div>
              <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-wider text-white">DECANTER CENTRIFUGE</h1>
              <p className="text-[10px] text-slate-500 tracking-widest uppercase">Digital Twin · Predictive Control System</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <SerialConnect bridgeRef={bridgeRef} onConnectedChange={setIsLive} />
            {isLive && (
              <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-400 bg-emerald-500/10">
                <Wifi className="w-3 h-3 mr-1" /> LIVE
              </Badge>
            )}
            <Badge
              variant="outline"
              className={`text-[10px] font-bold tracking-widest uppercase border ${
                outputs.status === 'OPTIMAL'  ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10' :
                outputs.status === 'WARNING'  ? 'border-amber-500/40  text-amber-400  bg-amber-500/10' :
                outputs.status === 'CRITICAL' ? 'border-red-500/40    text-red-400    bg-red-500/10' :
                'border-slate-500/40 text-slate-400 bg-slate-500/10'
              }`}
            >
              {outputs.status}
            </Badge>
            <Badge variant="outline" className="text-[10px] border-slate-700 text-slate-400">
              {isLive ? 'Sensor' : 'AI'} {isLive ? '98' : outputs.confidence}% confidence
            </Badge>
            <button
              onClick={() => setRunning(r => !r)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                running
                  ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20'
                  : 'bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {running ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {running ? 'Running' : 'Paused'}
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700 transition-all"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reset
            </button>
            {isLive && dataLog.length > 0 && (
              <>
                <button
                  onClick={exportCsv}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-all"
                >
                  <Download className="w-3.5 h-3.5" />
                  CSV ({dataLog.length})
                </button>
                <button
                  onClick={clearLog}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ═══ MAIN LAYOUT ══════════════════════════════════════════ */}
      <main className="max-w-screen-2xl mx-auto px-4 sm:px-6 pb-10 pt-5 space-y-5">

        {/* ── Row 1: 3D + Gauges ─────────────────────────────── */}
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">

          {/* 3D Centrifuge */}
          <div className="xl:col-span-3 relative rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/60 to-slate-800/30 backdrop-blur overflow-hidden" style={{ minHeight: 380 }}>
            <div className="absolute top-3 left-4 z-10 flex items-center gap-2">
              <span className="text-[10px] font-bold tracking-widest uppercase text-slate-500">3D TWIN VISUALIZATION</span>
              <span className="text-[9px] text-slate-600">· drag to orbit</span>
            </div>
            <div className="absolute top-3 right-4 z-10 flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-cyan-400" />
                <span className="text-[9px] text-slate-500">Outer Bowl</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-[9px] text-slate-500">Inner (Perf.)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-violet-400" />
                <span className="text-[9px] text-slate-500">Scroll</span>
              </div>
            </div>
            <CentrifugeCanvas
              bowlRPM={outputs.bowlSpeed}
              scrollRPM={outputs.scrollSpeed}
              running={running}
            />
          </div>

          {/* Gauges + Status */}
          <div className="xl:col-span-2 flex flex-col gap-4">
            {/* Motor gauges */}
            <div className="rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/60 to-slate-800/30 backdrop-blur p-4">
              <p className="text-[10px] font-bold tracking-widest uppercase text-slate-500 mb-4">Motor Control</p>
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col items-center gap-3">
                  <div className="text-[9px] font-bold tracking-widest text-cyan-400 uppercase">Bowl Motor (M1)</div>
                  <GaugeRing
                    value={outputs.bowlSpeed}
                    min={800} max={4500}
                    label="Bowl Speed"
                    unit="RPM"
                    color="#00d4ff"
                    size={130}
                    warningAt={3800} criticalAt={4200}
                  />
                  <div className="text-center space-y-0.5">
                    <p className="text-[10px] text-slate-500">Torque</p>
                    <p className="text-sm font-bold font-mono text-cyan-300">{outputs.bowlMotorTorque} <span className="text-xs font-normal text-slate-500">N·m</span></p>
                  </div>
                </div>
                <div className="flex flex-col items-center gap-3">
                  <div className="text-[9px] font-bold tracking-widest text-violet-400 uppercase">Scroll Motor (M2)</div>
                  <GaugeRing
                    value={outputs.scrollSpeed}
                    min={800} max={4500}
                    label="Scroll Speed"
                    unit="RPM"
                    color="#7c3aed"
                    size={130}
                    warningAt={3800} criticalAt={4200}
                  />
                  <div className="text-center space-y-0.5">
                    <p className="text-[10px] text-slate-500">Torque</p>
                    <p className="text-sm font-bold font-mono text-violet-300">{outputs.scrollMotorTorque} <span className="text-xs font-normal text-slate-500">N·m</span></p>
                  </div>
                </div>
              </div>
              <Separator className="my-3 bg-white/5" />
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">Differential Speed</span>
                <span className="font-mono font-bold text-amber-400">{outputs.differentialSpeed} RPM</span>
              </div>
            </div>

            {/* Status panel */}
            <StatusPanel
              status={outputs.status}
              alerts={outputs.alerts}
              confidence={outputs.confidence}
            />
          </div>
        </div>

        {/* ── Row 2: KPI cards ────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <MetricCard label="G-Force" value={outputs.gForce} unit="G" icon="🌀" colorClass="text-red-400" pulse={running} />
          <MetricCard label="Energy Draw" value={outputs.energyConsumption} unit="kW" icon="⚡" colorClass="text-amber-400" pulse={running} />
          <MetricCard label="Flow Rate (adj)" value={outputs.adjustedFlowRate} unit="L/min" icon="💧" colorClass="text-emerald-400" />
          <MetricCard label="Efficiency" value={`${outputs.separationEfficiency}%`} icon="📊" colorClass="text-violet-400" />
          <MetricCard label="Retention Time" value={outputs.retentionTime} unit="s" icon="⏱" colorClass="text-blue-400" />
          <MetricCard label="Cake Moisture" value={`${outputs.solidsMoisture}%`} icon="🧪" colorClass="text-pink-400" />
        </div>

        {/* ── Row 3: Trends + Controls ─────────────────────────── */}
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">

          {/* Trend Chart */}
          <div className="xl:col-span-3 rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/60 to-slate-800/30 backdrop-blur p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-bold tracking-widest uppercase text-slate-400">Real-time Trends</span>
              </div>
              <div className="flex items-center gap-1 bg-slate-800/60 rounded-lg p-1 flex-wrap gap-y-1">
                {TREND_TABS.map(t => (
                  <button
                    key={t.key}
                    onClick={() => setTrendKey(t.key)}
                    className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all whitespace-nowrap ${
                      trendKey === t.key
                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ height: 200 }}>
              <TrendChart history={history} activeMetric={trendKey} />
            </div>
          </div>

          {/* Feed Parameters Panel */}
          <div className="xl:col-span-2 rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/60 to-slate-800/30 backdrop-blur p-5">
            <div className="flex items-center gap-2 mb-4">
              <Settings2 className="w-4 h-4 text-violet-400" />
              <span className="text-xs font-bold tracking-widest uppercase text-slate-400">Feed Properties</span>
              <Badge variant="outline" className={`ml-auto text-[9px] ${isLive ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10' : 'border-slate-600 text-slate-500 bg-slate-800'}`}>
                {isLive ? 'HARDWARE' : 'SIMULATED'}
              </Badge>
            </div>
            <div className="space-y-5">
              {FEED_SLIDERS.map(({ key, label, unit, min, max, step, icon: Icon, color, decimals }) => (
                <div key={key} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Icon className="w-3.5 h-3.5" style={{ color }} />
                      <span className="text-xs text-slate-400">{label}</span>
                    </div>
                    <span className="text-xs font-mono font-bold" style={{ color }}>
                      {Number(feed[key as keyof FeedProperties]).toFixed(decimals)} {unit}
                    </span>
                  </div>
                  <Slider
                    value={[feed[key as keyof FeedProperties]]}
                    min={min}
                    max={max}
                    step={step}
                    onValueChange={(val) => handleSlider(key as keyof FeedProperties, val as number[])}
                    className="w-full"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Row 4: Energy + Process detail ──────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* Energy breakdown */}
          <div className="rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/60 to-slate-800/30 backdrop-blur p-5">
            <div className="flex items-center gap-2 mb-4">
              <Zap className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-bold tracking-widest uppercase text-slate-400">Energy Prediction</span>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Bowl Motor (M1)',    value: outputs.bowlMotorTorque   * ((outputs.bowlSpeed   * 2 * Math.PI / 60)) / 1000, color: '#00d4ff', max: 80 },
                { label: 'Scroll Motor (M2)',  value: outputs.scrollMotorTorque * ((outputs.scrollSpeed * 2 * Math.PI / 60)) / 1000, color: '#7c3aed', max: 40 },
                { label: 'Mechanical Losses',  value: outputs.energyConsumption * 0.13, color: '#f59e0b', max: 20 },
              ].map(({ label, value, color, max }) => (
                <div key={label} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">{label}</span>
                    <span className="font-mono font-bold" style={{ color }}>{Math.abs(value).toFixed(1)} kW</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-800">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ backgroundColor: color }}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, Math.abs(value) / max * 100)}%` }}
                      transition={{ type: 'spring', damping: 20 }}
                    />
                  </div>
                </div>
              ))}
              <Separator className="bg-white/5 my-2" />
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-400 font-semibold">Total Predicted</span>
                <span className="font-mono font-bold text-amber-400 text-lg">{outputs.energyConsumption} <span className="text-xs text-slate-500 font-normal">kW</span></span>
              </div>
            </div>
          </div>

          {/* Process state */}
          <div className="rounded-2xl border border-white/5 bg-gradient-to-br from-slate-900/60 to-slate-800/30 backdrop-blur p-5">
            <div className="flex items-center gap-2 mb-4">
              <Cpu className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-bold tracking-widest uppercase text-slate-400">Process State</span>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Pool Depth',        value: `${outputs.poolDepth} mm`,   pct: outputs.poolDepth / 120,     color: '#10b981' },
                { label: 'Solids Moisture',   value: `${outputs.solidsMoisture}%`, pct: outputs.solidsMoisture / 60, color: '#f43f5e' },
                { label: 'Efficiency',        value: `${outputs.separationEfficiency}%`, pct: outputs.separationEfficiency / 100, color: '#a78bfa' },
                { label: 'Feed Flow (actual)', value: `${outputs.adjustedFlowRate} L/min`, pct: outputs.adjustedFlowRate / 200, color: '#00d4ff' },
              ].map(({ label, value, pct, color }) => (
                <div key={label} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">{label}</span>
                    <span className="font-mono font-bold" style={{ color }}>{value}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-800">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ backgroundColor: color }}
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.min(100, pct * 100)}%` }}
                      transition={{ type: 'spring', damping: 20 }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Hardware panel (real components) */}
          <HardwarePanel
            bridgeRef={bridgeRef}
            isLive={isLive}
            telemetry={latestTelemetry ? {
              oilLevelCm: latestTelemetry.oilLevelCm,
              tempC: latestTelemetry.tempC,
              flowKgh: latestTelemetry.flowKgh,
              bowlCurrentA: latestTelemetry.bowlCurrentA,
              bowlRpm: latestTelemetry.bowlRpm,
              screwRpm: latestTelemetry.screwRpm,
              pumpOn: latestTelemetry.pumpOn,
              feedMode: latestTelemetry.feedMode,
            } : null}
          />
        </div>

        {/* ── Footer ──────────────────────────────────────────── */}
        <div className="text-center pt-2">
          <p className="text-[10px] text-slate-700 tracking-widest uppercase">
            Decanter Centrifuge Digital Twin · Predictive &amp; Adaptive Control System · v2.0
          </p>
        </div>
      </main>
    </div>
  );
}
