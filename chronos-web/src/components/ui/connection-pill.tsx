'use client';

import React from 'react';
import { useTelemetryStore } from '../../stores/telemetry-store';
import { Activity, WifiOff } from 'lucide-react';

export function ConnectionPill() {
  const { connectionStatus, latencyMs } = useTelemetryStore();

  if (connectionStatus === 'LIVE') {
    const displayLatency = latencyMs > 0 && latencyMs < 24 ? '<24ms' : `${latencyMs}ms`;
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 text-xs font-mono font-medium shadow-[0_0_12px_rgba(16,185,129,0.15)]">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
        </span>
        <span className="tracking-wide">LIVE</span>
        <span className="text-emerald-500/60 font-mono text-[11px]">•</span>
        <span className="text-emerald-300 font-mono text-[11px]">{displayLatency}</span>
      </div>
    );
  }

  if (connectionStatus === 'RECONNECTING') {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-950/40 border border-amber-500/30 text-amber-400 text-xs font-mono font-medium shadow-[0_0_12px_rgba(245,158,11,0.15)]">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
        </span>
        <Activity className="w-3.5 h-3.5 animate-spin" />
        <span className="tracking-wide">RECONNECTING</span>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-950/40 border border-rose-500/30 text-rose-400 text-xs font-mono font-medium shadow-[0_0_12px_rgba(244,63,94,0.15)]">
      <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
      <WifiOff className="w-3.5 h-3.5" />
      <span className="tracking-wide">OFFLINE</span>
    </div>
  );
}
