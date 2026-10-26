'use client';

import React from 'react';
import { Flame, X, ArrowUpRight } from 'lucide-react';
import { Badge } from './badge';
import { Button } from './button';

export interface BreachToastNotification {
  id: string;
  ticketId: string;
  ticketNumber: string;
  priority: string;
  timestamp: string;
}

interface BreachToastContainerProps {
  notifications: BreachToastNotification[];
  onDismiss: (id: string) => void;
  onNavigate?: (ticketId: string) => void;
}

export function BreachToastContainer({
  notifications,
  onDismiss,
  onNavigate,
}: BreachToastContainerProps) {
  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col space-y-3 max-w-md w-full pointer-events-none">
      {notifications.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto p-4 rounded-xl border border-rose-500/80 bg-slate-950/95 shadow-[0_0_25px_rgba(244,63,94,0.4)] backdrop-blur-xl animate-in slide-in-from-right-8 duration-300"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-rose-950 border border-rose-500/50 flex items-center justify-center shrink-0">
                <Flame className="w-4 h-4 text-rose-400 animate-pulse" />
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold font-mono text-rose-300">
                    SLA BREACH ALERT
                  </span>
                  <Badge variant="breach" className="text-[9px] py-0 px-1">
                    100% EXCEEDED
                  </Badge>
                </div>
                <span className="text-sm font-semibold text-slate-100 mt-0.5">
                  Ticket {toast.ticketNumber}
                </span>
              </div>
            </div>

            <button
              onClick={() => onDismiss(toast.id)}
              className="text-slate-400 hover:text-slate-200 transition-colors p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="text-xs text-slate-400 mt-2 font-mono">
            Resolution deadline reached 100%. Ticket priority automatically escalated to{' '}
            <span className="text-rose-400 font-bold">{toast.priority}</span>.
          </p>

          <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-900 text-xs font-mono">
            <span className="text-[11px] text-slate-500">
              {new Date(toast.timestamp).toLocaleTimeString()}
            </span>
            {onNavigate && (
              <Button
                size="sm"
                variant="danger"
                onClick={() => onNavigate(toast.ticketId)}
                className="text-[11px] py-1 px-2.5"
              >
                Inspect Ticket
                <ArrowUpRight className="w-3 h-3 ml-1" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
