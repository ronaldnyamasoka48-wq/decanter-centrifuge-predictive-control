'use client';

import { useState } from 'react';
import { Volume2, Thermometer, Droplets, Zap, Play, Square, Power, RotateCw, Wifi, WifiOff, Gauge } from 'lucide-react';
import type { SerialBridge } from '@/lib/serial-bridge';
import { Slider } from '@/components/ui/slider';

interface Props {
  bridgeRef: React.MutableRefObject<SerialBridge | null>;
  isLive: boolean;
  telemetry: {
    oilLevelCm: number;
    tempC: number;
    flowKgh: number;
    bowlCurrentA: number;
    bowlRpm: number;
    screwRpm: number;
    pumpOn: boolean;
    feedMode: string;
  } | null;
}

const SCREW_RPM_MIN = 2470;
const SCREW_RPM_MAX = 3990;

export default function HardwarePanel({ bridgeRef, isLive, telemetry }: Props) {
  const [screwTarget, setScrewTarget] = useState(2985);

  const send = (cmd: string) => {
    console.log('[HardwarePanel] Sending:', cmd);
    if (bridgeRef.current) {
      bridgeRef.current.send(cmd).catch(e => console.error('[HardwarePanel] Send error:', e));
    } else {
      console.error('[HardwarePanel] bridgeRef.current is NULL');
    }
  };

  const setScrewSpeed = (rpm: number) => {
    const clamped = Math.round(Math.min(SCREW_RPM_MAX, Math.max(SCREW_RPM_MIN, rpm)));
    setScrewTarget(clamped);
    const bowl = telemetry?.bowlRpm || 3000;
    send(`SET:${bowl},${clamped}`);
  };

  const bowlOn = telemetry ? telemetry.bowlRpm > 0 : false;

  return (
    <div className={`rounded-2xl border ${isLive ? 'border-emerald-500/15' : 'border-white/5'} bg-gradient-to-br from-slate-900/60 to-slate-800/30 backdrop-blur p-5 transition-all`}>
      <div className="flex items-center gap-2 mb-4">
        <Zap className={`w-4 h-4 ${isLive ? 'text-emerald-400' : 'text-slate-600'}`} />
        <span className="text-xs font-bold tracking-widest uppercase text-slate-400">Hardware Control</span>
        {isLive
          ? <span className="text-[9px] text-emerald-500 flex items-center gap-1 ml-auto"><Wifi className="w-3 h-3" /> Connected</span>
          : <span className="text-[9px] text-slate-600 flex items-center gap-1 ml-auto"><WifiOff className="w-3 h-3" /> Connect ESP32 to enable</span>
        }
      </div>

      {telemetry ? (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="bg-slate-800/40 rounded-xl p-3">
            <div className="flex items-center gap-1 text-[10px] text-slate-500 mb-1">
              <Volume2 className="w-3 h-3" /> Oil Level
            </div>
            <p className="text-lg font-bold font-mono text-cyan-400">
              {telemetry.oilLevelCm.toFixed(1)}
              <span className="text-xs font-normal text-slate-500 ml-1">cm</span>
            </p>
          </div>
          <div className="bg-slate-800/40 rounded-xl p-3">
            <div className="flex items-center gap-1 text-[10px] text-slate-500 mb-1">
              <Thermometer className="w-3 h-3" /> Temperature
            </div>
            <p className="text-lg font-bold font-mono text-red-400">
              {telemetry.tempC.toFixed(1)}
              <span className="text-xs font-normal text-slate-500 ml-1">°C</span>
            </p>
          </div>
          <div className="bg-slate-800/40 rounded-xl p-3">
            <div className="flex items-center gap-1 text-[10px] text-slate-500 mb-1">
              <Droplets className="w-3 h-3" /> Flow Rate
            </div>
            <p className="text-lg font-bold font-mono text-emerald-400">
              {(telemetry.flowKgh / 1.15 / 60).toFixed(1)}
              <span className="text-xs font-normal text-slate-500 ml-1">L/min</span>
            </p>
          </div>
          <div className="bg-slate-800/40 rounded-xl p-3">
            <div className="flex items-center gap-1 text-[10px] text-slate-500 mb-1">ACS712 Current</div>
            <p className="text-lg font-bold font-mono text-amber-400">
              {telemetry.bowlCurrentA.toFixed(2)}
              <span className="text-xs font-normal text-slate-500 ml-1">A</span>
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[0,1,2,3].map(i => (
            <div key={i} className="bg-slate-800/20 rounded-xl p-3">
              <div className="h-3 w-16 bg-slate-800/50 rounded mb-2" />
              <div className="h-6 w-20 bg-slate-800/50 rounded" />
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[10px] font-bold tracking-widest uppercase text-slate-500 mb-2">Motors</p>
        <div className="flex gap-2">
          <button
            onClick={() => send('BOWL:ON')}
            disabled={!isLive}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
              !isLive
                ? 'bg-slate-900/50 border border-slate-800 text-slate-600 cursor-not-allowed'
                : bowlOn
                  ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-400'
                  : 'bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <Power className="w-3.5 h-3.5" />
            Bowl ON
          </button>
          <button
            onClick={() => send('BOWL:OFF')}
            disabled={!isLive}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
              !isLive
                ? 'bg-slate-900/50 border border-slate-800 text-slate-600 cursor-not-allowed'
                : 'bg-slate-800 border border-slate-700 text-slate-400 hover:bg-red-500/20 hover:border-red-500/30 hover:text-red-400'
            }`}
          >
            <Power className="w-3.5 h-3.5" />
            Bowl OFF
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => send('PUMP:ON')}
            disabled={!isLive}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
              !isLive
                ? 'bg-slate-900/50 border border-slate-800 text-slate-600 cursor-not-allowed'
                : telemetry?.pumpOn
                  ? 'bg-blue-500/20 border border-blue-500/40 text-blue-400'
                  : 'bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700'
            }`}
          >
            <RotateCw className="w-3.5 h-3.5" />
            Pump ON
          </button>
          <button
            onClick={() => send('PUMP:OFF')}
            disabled={!isLive}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
              !isLive
                ? 'bg-slate-900/50 border border-slate-800 text-slate-600 cursor-not-allowed'
                : 'bg-slate-800 border border-slate-700 text-slate-400 hover:bg-red-500/20 hover:border-red-500/30 hover:text-red-400'
            }`}
          >
            <RotateCw className="w-3.5 h-3.5" />
            Pump OFF
          </button>
        </div>
        <div className="flex gap-2">
          {(['WATERY', 'NOMINAL', 'THICKER'] as const).map(p => (
            <button
              key={p}
              onClick={() => send(`FEED:${p}`)}
              disabled={!isLive}
              className={`flex-1 px-2 py-1.5 rounded-lg text-[10px] font-semibold transition-all ${
                !isLive
                  ? 'bg-slate-900/50 border border-slate-800 text-slate-600 cursor-not-allowed'
                  : 'bg-slate-800 border border-slate-700 text-slate-400 hover:bg-emerald-500/10 hover:border-emerald-500/30 hover:text-emerald-400'
              }`}
            >
              {p.charAt(0) + p.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        <p className="text-[10px] font-bold tracking-widest uppercase text-slate-500 mb-2 mt-3">Pulse Mode (Bowl)</p>
        <div className="flex gap-2">
          <button
            onClick={() => send('PULSE:3000,1000')}
            disabled={!isLive}
            className="flex-1 px-2 py-1.5 rounded-lg text-[10px] font-semibold bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 transition-all"
          >
            Fast (3s ON / 1s OFF)
          </button>
          <button
            onClick={() => send('PULSE:1000,2000')}
            disabled={!isLive}
            className="flex-1 px-2 py-1.5 rounded-lg text-[10px] font-semibold bg-amber-500/20 border border-amber-500/40 text-amber-400 hover:bg-amber-500/30 transition-all"
          >
            Slow (1s ON / 2s OFF)
          </button>
          <button
            onClick={() => send('PULSE:OFF')}
            disabled={!isLive}
            className="flex-1 px-2 py-1.5 rounded-lg text-[10px] font-semibold bg-slate-800 border border-slate-700 text-slate-400 hover:bg-red-500/20 hover:border-red-500/30 hover:text-red-400 transition-all"
          >
            Stop Pulse
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => send('BUZZER:TEST')}
            disabled={!isLive}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
              !isLive
                ? 'bg-slate-900/50 border border-slate-800 text-slate-600 cursor-not-allowed'
                : 'bg-slate-800 border border-slate-700 text-slate-400 hover:bg-yellow-500/10 hover:border-yellow-500/30 hover:text-yellow-400'
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" />
            Buzzer Test
          </button>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => send('SCREW:TEST')}
            disabled={!isLive}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-violet-500/20 border border-violet-500/40 text-violet-400 hover:bg-violet-500/30 transition-all"
          >
            <Power className="w-3.5 h-3.5" />
            Screw Test (100%)
          </button>
          <button
            onClick={() => send('SCREW:OFF')}
            disabled={!isLive}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-slate-800 border border-slate-700 text-slate-400 hover:bg-red-500/20 hover:border-red-500/30 hover:text-red-400 transition-all"
          >
            <Power className="w-3.5 h-3.5" />
            Screw OFF
          </button>
        </div>

        <div className="space-y-2 pt-3 border-t border-white/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Gauge className="w-3.5 h-3.5 text-violet-400" />
              <span className="text-[10px] font-bold tracking-widest uppercase text-slate-500">Screw Motor Speed</span>
            </div>
            <div className="flex items-center gap-2">
              {(telemetry?.screwRpm ?? 0) > 0 && (
                <span className="flex items-center gap-1 text-[9px] text-emerald-400 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  RUNNING
                </span>
              )}
              <span className="text-xs font-mono font-bold text-violet-400">
                {telemetry?.screwRpm ?? screwTarget} RPM
              </span>
            </div>
          </div>
          <Slider
            value={[screwTarget]}
            min={SCREW_RPM_MIN}
            max={SCREW_RPM_MAX}
            step={10}
            onValueChange={(val) => { const v = Array.isArray(val) ? val[0] : val; setScrewSpeed(v); }}
            disabled={!isLive}
            className="w-full"
          />
          <div className="flex justify-between text-[9px] text-slate-600">
            <span>{SCREW_RPM_MIN} RPM</span>
            <span>{SCREW_RPM_MAX} RPM</span>
          </div>
        </div>
      </div>

      {isLive && (
        <div className="flex gap-2 mt-4 pt-4 border-t border-white/5">
          <button
            onClick={() => { send('BOWL:ON'); send(`SET:3000,${screwTarget}`); }}
            className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg text-xs font-bold bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/30 transition-all flex-1"
          >
            <Play className="w-4 h-4" />
            START
          </button>
          <button
            onClick={() => send('STOP')}
            className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg text-xs font-bold bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 transition-all flex-1"
          >
            <Square className="w-4 h-4" />
            STOP
          </button>
        </div>
      )}
    </div>
  );
}
