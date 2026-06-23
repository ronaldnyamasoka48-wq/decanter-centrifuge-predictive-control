'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { SerialBridge, type SerialStatus } from '@/lib/serial-bridge';
import { Plug, PlugZap, Loader2, AlertCircle } from 'lucide-react';

interface Props {
  bridgeRef: React.MutableRefObject<SerialBridge | null>;
  onConnectedChange: (connected: boolean) => void;
}

const STATUS_MAP: Record<SerialStatus, { label: string; color: string; bg: string }> = {
  disconnected: { label: 'Connect ESP32',  color: 'text-slate-400', bg: 'bg-slate-800 border-slate-700 hover:bg-slate-700' },
  connecting:   { label: 'Connecting...',  color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' },
  connected:    { label: 'Disconnect',     color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20' },
  error:        { label: 'Retry',          color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/30 hover:bg-red-500/20' },
};

export default function SerialConnect({ bridgeRef, onConnectedChange }: Props) {
  const [status, setStatus] = useState<SerialStatus>('disconnected');
  const [portInfo, setPortInfo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bridge = useRef<SerialBridge | null>(null);

  useEffect(() => {
    const b = new SerialBridge();
    bridge.current = b;
    bridgeRef.current = b;

    b.onStatus = (s, msg) => {
      setStatus(s);
      if (s === 'connected' && msg) setPortInfo(msg);
      if (s === 'error' && msg) setError(msg);
      if (s === 'connected' || s === 'disconnected') {
        onConnectedChange(s === 'connected');
      }
    };

    return () => { b.disconnect(); bridgeRef.current = null; };
  }, []);

  const toggle = useCallback(async () => {
    setError(null);
    if (status === 'connected') {
      await bridge.current?.disconnect();
    } else {
      await bridge.current?.connect();
    }
  }, [status]);

  const st = STATUS_MAP[status];

  return (
    <div className="flex items-center gap-2">
      {status === 'connected' && (
        <span className="text-[10px] text-emerald-600 font-mono truncate max-w-28" title={portInfo}>
          {portInfo}
        </span>
      )}
      <button
        onClick={toggle}
        disabled={status === 'connecting'}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${st.bg}`}
      >
        {status === 'connecting' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : status === 'connected' ? (
          <PlugZap className="w-3.5 h-3.5" />
        ) : (
          <Plug className="w-3.5 h-3.5" />
        )}
        {st.label}
      </button>
      {error && status === 'error' && (
        <div className="flex items-center gap-1 text-[10px] text-red-400">
          <AlertCircle className="w-3 h-3" />
          <span className="max-w-40 truncate">{error}</span>
        </div>
      )}
    </div>
  );
}
