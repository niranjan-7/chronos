'use client';

import React from 'react';
import { TicketAuditLog, TicketStatus } from '../../types/telemetry';
import { Badge } from '../ui/badge';
import {
  Clock,
  ArrowRight,
  UserCheck,
  Pause,
  Play,
  CheckCircle2,
  Archive,
  AlertCircle,
  FileText,
} from 'lucide-react';

interface AuditLogTimelineProps {
  logs: TicketAuditLog[];
  ticketNumber: string;
}

export function AuditLogTimeline({ logs, ticketNumber }: AuditLogTimelineProps) {
  if (!logs || logs.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-slate-500 font-mono">
        <FileText className="w-5 h-5 mx-auto mb-1.5 text-slate-600" />
        No immutable audit log entries recorded yet.
      </div>
    );
  }

  const getStatusIcon = (status: TicketStatus) => {
    switch (status) {
      case 'OPEN':
        return <AlertCircle className="w-3.5 h-3.5 text-slate-400" />;
      case 'ASSIGNED':
        return <UserCheck className="w-3.5 h-3.5 text-indigo-400" />;
      case 'IN_PROGRESS':
        return <Play className="w-3.5 h-3.5 text-emerald-400" />;
      case 'ON_HOLD':
        return <Pause className="w-3.5 h-3.5 text-cyan-400" />;
      case 'RESOLVED':
        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
      case 'CLOSED':
        return <Archive className="w-3.5 h-3.5 text-slate-500" />;
      default:
        return <Clock className="w-3.5 h-3.5 text-slate-400" />;
    }
  };

  const getBadgeVariant = (status: TicketStatus) => {
    switch (status) {
      case 'OPEN':
        return 'neutral' as const;
      case 'ASSIGNED':
        return 'neutral' as const;
      case 'IN_PROGRESS':
        return 'healthy' as const;
      case 'ON_HOLD':
        return 'paused' as const;
      case 'RESOLVED':
        return 'healthy' as const;
      case 'CLOSED':
        return 'neutral' as const;
      default:
        return 'neutral' as const;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between pb-2 border-b border-slate-800">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 font-mono">
          Immutable Audit Log History • {ticketNumber} ({logs.length})
        </h4>
        <span className="text-[10px] font-mono text-slate-500">
          PostgreSQL ACID Ledger
        </span>
      </div>

      <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-2 before:bottom-2 before:w-[2px] before:bg-slate-800">
        {logs.map((log, idx) => {
          const isLatest = idx === 0;
          return (
            <div key={log.id} className="relative group">
              {/* Timeline Node Bullet */}
              <div
                className={`absolute -left-6 top-0.5 w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${
                  isLatest
                    ? 'border-indigo-500 bg-indigo-950 text-indigo-400 shadow-[0_0_10px_rgba(99,102,241,0.3)]'
                    : 'border-slate-800 bg-slate-950 text-slate-500 group-hover:border-slate-700'
                }`}
              >
                {getStatusIcon(log.newStatus)}
              </div>

              {/* Log Entry Content */}
              <div className="rounded-lg border border-slate-800/80 bg-slate-950/60 p-3 hover:border-slate-700 transition-colors">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5">
                    {log.previousStatus && (
                      <>
                        <Badge
                          variant={getBadgeVariant(log.previousStatus)}
                          className="text-[10px] py-0 px-1.5"
                        >
                          {log.previousStatus}
                        </Badge>
                        <ArrowRight className="w-3 h-3 text-slate-600" />
                      </>
                    )}
                    <Badge
                      variant={getBadgeVariant(log.newStatus)}
                      className="text-[10px] py-0 px-1.5"
                    >
                      {log.newStatus}
                    </Badge>
                  </div>

                  <span className="text-[10px] font-mono text-slate-400">
                    {new Date(log.createdAt).toLocaleString()}
                  </span>
                </div>

                {log.reason && (
                  <p className="text-xs text-slate-300 font-sans mt-1">
                    {log.reason}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 mt-2 pt-2 border-t border-slate-900 text-[10px] font-mono text-slate-500">
                  <span>
                    Actor: <span className="text-slate-400">{log.actorId ? log.actorId.slice(0, 8) : 'System Worker'}</span>
                  </span>
                  {log.slaRemainingMs !== null && log.slaRemainingMs !== undefined && (
                    <span className="text-cyan-400/90 flex items-center gap-1">
                      <Pause className="w-3 h-3 text-cyan-400" />
                      Remaining: {Math.max(0, Math.floor(log.slaRemainingMs / 60000))}m
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
