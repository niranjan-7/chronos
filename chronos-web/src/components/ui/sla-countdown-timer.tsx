'use client';

import React, { useEffect, useRef, useState } from 'react';
import { TicketPriority, TicketStatus } from '../../types/telemetry';
import { Badge } from './badge';
import { Clock, Flame, AlertTriangle, Pause } from 'lucide-react';

interface SlaCountdownTimerProps {
  ticketId: string;
  ticketNumber: string;
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: string;
  targetBreachAt?: string | null;
  remainingSlaMs?: number | null;
  isBreached?: boolean;
  onBreachTriggered?: (ticketId: string, ticketNumber: string, priority: TicketPriority) => void;
  className?: string;
}

type SlaPhase = 'HEALTHY' | 'WARNING' | 'BREACHED' | 'FROZEN' | 'COMPLETED';

const PRIORITY_DEFAULT_DURATIONS: Record<TicketPriority, number> = {
  URGENT: 60 * 60 * 1000, // 1 hour
  HIGH: 4 * 60 * 60 * 1000, // 4 hours
  MEDIUM: 12 * 60 * 60 * 1000, // 12 hours
  LOW: 24 * 60 * 60 * 1000, // 24 hours
};

export function SlaCountdownTimer({
  ticketId,
  ticketNumber,
  priority,
  status,
  createdAt,
  targetBreachAt,
  remainingSlaMs,
  isBreached = false,
  onBreachTriggered,
  className,
}: SlaCountdownTimerProps) {
  const [phase, setPhase] = useState<SlaPhase>(() => {
    if (status === 'RESOLVED' || status === 'CLOSED') return 'COMPLETED';
    if (status === 'ON_HOLD') return 'FROZEN';
    if (isBreached) return 'BREACHED';
    return 'HEALTHY';
  });

  const timeDisplayRef = useRef<HTMLSpanElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const hasTriggeredBreachRef = useRef<boolean>(isBreached);

  // Compute base duration for calculation
  const createdTime = new Date(createdAt).getTime();
  const breachTime = targetBreachAt
    ? new Date(targetBreachAt).getTime()
    : createdTime + (PRIORITY_DEFAULT_DURATIONS[priority] || 3600000);
  const totalDurationMs = Math.max(1000, breachTime - createdTime);

  function formatCountdown(ms: number): string {
    if (ms <= 0) return '00h 00m 00s';
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;

    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  }

  useEffect(() => {
    // If ticket is completed (RESOLVED or CLOSED)
    if (status === 'RESOLVED' || status === 'CLOSED') {
      setPhase('COMPLETED');
      if (timeDisplayRef.current) timeDisplayRef.current.textContent = 'RESOLVED';
      if (progressBarRef.current) progressBarRef.current.style.width = '100%';
      return;
    }

    // If ticket is ON_HOLD: SLA is paused, freeze countdown in place
    if (status === 'ON_HOLD') {
      setPhase('FROZEN');
      const frozenMs = remainingSlaMs ?? Math.max(0, breachTime - Date.now());
      if (timeDisplayRef.current) {
        timeDisplayRef.current.textContent = `${formatCountdown(frozenMs)} (LOCKED)`;
      }
      if (progressBarRef.current) {
        const elapsed = totalDurationMs - frozenMs;
        const pct = Math.min(100, Math.max(0, (elapsed / totalDurationMs) * 100));
        progressBarRef.current.style.width = `${pct.toFixed(1)}%`;
      }
      return;
    }

    // High performance 60fps requestAnimationFrame loop
    let animationFrameId: number;
    let lastRenderTime = 0;

    const updateTimer = (timestamp: number) => {
      // Throttle DOM text updates to ~10 times per second for CPU efficiency
      if (timestamp - lastRenderTime >= 100) {
        lastRenderTime = timestamp;
        const now = Date.now();
        const remaining = breachTime - now;
        const elapsed = totalDurationMs - remaining;
        const elapsedPercent = Math.min(100, Math.max(0, (elapsed / totalDurationMs) * 100));

        // 1. Update text display
        if (timeDisplayRef.current) {
          if (remaining <= 0) {
            const overtimeMs = Math.abs(remaining);
            timeDisplayRef.current.textContent = `-${formatCountdown(overtimeMs)} OVERDUE`;
          } else {
            timeDisplayRef.current.textContent = formatCountdown(remaining);
          }
        }

        // 2. Update progress bar width
        if (progressBarRef.current) {
          progressBarRef.current.style.width = `${elapsedPercent.toFixed(1)}%`;
        }

        // 3. Update Visual Phase transitions
        if (remaining <= 0 || isBreached) {
          setPhase((prev) => (prev !== 'BREACHED' ? 'BREACHED' : prev));
          if (!hasTriggeredBreachRef.current) {
            hasTriggeredBreachRef.current = true;
            onBreachTriggered?.(ticketId, ticketNumber, priority);
          }
        } else if (elapsedPercent >= 80) {
          setPhase((prev) => (prev !== 'WARNING' ? 'WARNING' : prev));
        } else {
          setPhase((prev) => (prev !== 'HEALTHY' ? 'HEALTHY' : prev));
        }
      }

      animationFrameId = requestAnimationFrame(updateTimer);
    };

    animationFrameId = requestAnimationFrame(updateTimer);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [
    status,
    isBreached,
    breachTime,
    totalDurationMs,
    remainingSlaMs,
    ticketId,
    ticketNumber,
    priority,
    onBreachTriggered,
  ]);

  // Phase color mappings
  const phaseStyles: Record<SlaPhase, { bar: string; badge: React.ReactNode; border: string }> = {
    HEALTHY: {
      bar: 'bg-emerald-500',
      badge: (
        <Badge variant="healthy" className="text-[10px] py-0 px-1.5">
          <Clock className="w-3 h-3 mr-1" />
          ON TRACK
        </Badge>
      ),
      border: 'border-slate-800',
    },
    WARNING: {
      bar: 'bg-amber-400',
      badge: (
        <Badge variant="warning" className="text-[10px] py-0 px-1.5">
          <AlertTriangle className="w-3 h-3 mr-1" />
          ≥80% WARNING
        </Badge>
      ),
      border: 'border-amber-500/40 shadow-[0_0_12px_rgba(245,158,11,0.15)]',
    },
    BREACHED: {
      bar: 'bg-rose-500',
      badge: (
        <Badge variant="breach" className="text-[10px] py-0 px-1.5">
          <Flame className="w-3 h-3 mr-1 animate-pulse" />
          100% BREACHED
        </Badge>
      ),
      border: 'border-rose-500/60 animate-pulse-glow shadow-[0_0_15px_rgba(244,63,94,0.3)]',
    },
    FROZEN: {
      bar: 'bg-cyan-400',
      badge: (
        <Badge variant="paused" className="text-[10px] py-0 px-1.5">
          <Pause className="w-3 h-3 mr-1" />
          FROZEN (ON_HOLD)
        </Badge>
      ),
      border: 'border-cyan-500/30',
    },
    COMPLETED: {
      bar: 'bg-slate-700',
      badge: (
        <Badge variant="neutral" className="text-[10px] py-0 px-1.5">
          RESOLVED
        </Badge>
      ),
      border: 'border-slate-800 opacity-60',
    },
  };

  const currentStyle = phaseStyles[phase];

  return (
    <div
      className={`rounded-lg border p-3 bg-slate-950/80 transition-all duration-200 ${currentStyle.border} ${className || ''}`}
    >
      <div className="flex items-center justify-between mb-2">
        <span
          ref={timeDisplayRef}
          className={`font-mono text-xs font-bold tracking-tight ${
            phase === 'BREACHED'
              ? 'text-rose-400'
              : phase === 'WARNING'
              ? 'text-amber-400'
              : phase === 'FROZEN'
              ? 'text-cyan-400'
              : 'text-slate-200'
          }`}
        >
          {formatCountdown(Math.max(0, breachTime - Date.now()))}
        </span>
        {currentStyle.badge}
      </div>

      {/* Progress Bar Gauge */}
      <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden border border-slate-800">
        <div
          ref={progressBarRef}
          className={`h-full rounded-full transition-all duration-150 ${currentStyle.bar}`}
          style={{ width: '0%' }}
        />
      </div>
    </div>
  );
}
