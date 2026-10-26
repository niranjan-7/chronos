'use client';

import React from 'react';
import { Ticket, TicketStatus } from '../../types/telemetry';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { SlaCountdownTimer } from '../ui/sla-countdown-timer';
import { AuditLogTimeline } from './audit-log-timeline';
import {
  X,
  Play,
  Pause,
  CheckCircle,
  Archive,
  Layers,
} from 'lucide-react';

interface TicketDetailDrawerProps {
  ticket: Ticket | null;
  onClose: () => void;
  onTransition: (newStatus: TicketStatus, reason?: string) => void;
  isTransitioning?: boolean;
}

export function TicketDetailDrawer({
  ticket,
  onClose,
  onTransition,
  isTransitioning = false,
}: TicketDetailDrawerProps) {
  if (!ticket) return null;

  // State Machine Validity Logic
  const getTransitionRules = (current: TicketStatus) => {
    switch (current) {
      case 'OPEN':
        return {
          canAssign: true,
          canStart: false,
          canHold: false,
          canResume: false,
          canResolve: false,
          canClose: false,
          disabledReason: 'Ticket must be ASSIGNED before work can begin.',
        };
      case 'ASSIGNED':
        return {
          canAssign: false,
          canStart: true,
          canHold: false,
          canResume: false,
          canResolve: false,
          canClose: false,
          disabledReason: 'Ticket must transition to IN_PROGRESS before freezing or resolving.',
        };
      case 'IN_PROGRESS':
        return {
          canAssign: false,
          canStart: false,
          canHold: true,
          canResume: false,
          canResolve: true,
          canClose: false,
          disabledReason: 'Ticket must be RESOLVED before closing.',
        };
      case 'ON_HOLD':
        return {
          canAssign: false,
          canStart: false,
          canHold: false,
          canResume: true,
          canResolve: false,
          canClose: false,
          disabledReason: 'Ticket must resume to IN_PROGRESS before resolving.',
        };
      case 'RESOLVED':
        return {
          canAssign: false,
          canStart: false,
          canHold: false,
          canResume: false,
          canResolve: false,
          canClose: true,
          disabledReason: 'Ticket is already resolved. Proceed to archival closure.',
        };
      case 'CLOSED':
        return {
          canAssign: false,
          canStart: false,
          canHold: false,
          canResume: false,
          canResolve: false,
          canClose: false,
          disabledReason: 'Ticket is closed (immutable terminal state).',
        };
    }
  };

  const rules = getTransitionRules(ticket.status);

  // Generate fallback sample audit logs if not provided by backend
  const auditLogs = ticket.auditLogs || [
    {
      id: `log-sample-1`,
      ticketId: ticket.id,
      tenantId: ticket.tenantId,
      actorId: ticket.assignedAgentId || '00000000-0000-0000-0000-000000000001',
      previousStatus: ticket.status === 'ON_HOLD' ? 'IN_PROGRESS' : 'ASSIGNED',
      newStatus: ticket.status,
      reason:
        ticket.status === 'ON_HOLD'
          ? 'SLA Frozen: Awaiting customer reproduction packet trace'
          : ticket.status === 'IN_PROGRESS'
          ? 'Agent initiated active troubleshooting'
          : 'Ticket claimed via atomic SKIP LOCKED query',
      slaRemainingMs: ticket.remainingSlaMs ?? 1420000,
      createdAt: ticket.updatedAt || new Date().toISOString(),
    },
    {
      id: `log-sample-2`,
      ticketId: ticket.id,
      tenantId: ticket.tenantId,
      actorId: '00000000-0000-0000-0000-000000000002',
      previousStatus: 'OPEN',
      newStatus: 'ASSIGNED',
      reason: 'Auto push-routed to agent with matching skill proficiency (voice_webrtc)',
      createdAt: ticket.createdAt || new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: `log-sample-3`,
      ticketId: ticket.id,
      tenantId: ticket.tenantId,
      previousStatus: null,
      newStatus: 'OPEN',
      reason: 'Ticket created via transactional outbox dual-write transaction',
      createdAt: ticket.createdAt || new Date(Date.now() - 3600000).toISOString(),
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 backdrop-blur-sm animate-in fade-in-0 duration-200">
      <div className="w-full max-w-xl h-full bg-slate-950 border-l border-slate-800 p-6 flex flex-col shadow-2xl overflow-y-auto animate-in slide-in-from-right-8 duration-300">
        {/* Drawer Header */}
        <div className="flex items-start justify-between pb-4 border-b border-slate-800">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="font-mono text-xs font-bold text-slate-100 px-2 py-0.5 rounded bg-slate-800 border border-slate-700">
                {ticket.ticketNumber}
              </span>
              <Badge
                variant={
                  ticket.priority === 'URGENT'
                    ? 'urgent'
                    : ticket.priority === 'HIGH'
                    ? 'high'
                    : 'medium'
                }
                className="text-[10px] py-0 px-1.5"
              >
                {ticket.priority}
              </Badge>
              <Badge
                variant={
                  ticket.status === 'IN_PROGRESS'
                    ? 'healthy'
                    : ticket.status === 'ON_HOLD'
                    ? 'paused'
                    : ticket.status === 'RESOLVED'
                    ? 'healthy'
                    : 'warning'
                }
                className="text-[10px] py-0 px-1.5"
              >
                {ticket.status}
              </Badge>
            </div>
            <h3 className="text-base font-bold text-slate-100">{ticket.title}</h3>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="py-5 space-y-6 flex-1">
          {/* Live Millisecond SLA Countdown */}
          <div>
            <span className="text-xs font-mono uppercase tracking-wider text-slate-400 font-semibold mb-1.5 block">
              Active SLA Target Resolution
            </span>
            <SlaCountdownTimer
              ticketId={ticket.id}
              ticketNumber={ticket.ticketNumber}
              priority={ticket.priority}
              status={ticket.status}
              createdAt={ticket.createdAt}
              targetBreachAt={ticket.targetBreachAt}
              remainingSlaMs={ticket.remainingSlaMs}
              isBreached={ticket.isBreached}
            />
          </div>

          {/* Description */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
            <span className="text-[11px] font-mono uppercase text-slate-500 font-semibold mb-1 block">
              Ticket Description
            </span>
            <p className="text-xs text-slate-300 leading-relaxed font-sans">
              {ticket.description}
            </p>
          </div>

          {/* State Machine Transition Actions */}
          <div className="rounded-xl border border-indigo-500/30 bg-gradient-to-br from-indigo-950/20 to-slate-900/40 p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono uppercase tracking-wider text-indigo-300 font-semibold flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-indigo-400" />
                State Machine Lifecycle DAG
              </span>
              <span className="text-[10px] font-mono text-slate-400">Strict Enforcement</span>
            </div>

            <p className="text-[11px] text-slate-400 mb-4 font-mono">
              Current State: <span className="text-slate-100 font-bold">{ticket.status}</span> •
              Invalid transitions are locked to prevent state corruption.
            </p>

            <div className="grid grid-cols-2 gap-2">
              {/* Start Progress */}
              <Button
                size="sm"
                variant={rules.canStart ? 'primary' : 'outline'}
                disabled={!rules.canStart || isTransitioning}
                onClick={() => onTransition('IN_PROGRESS', 'Agent started active troubleshooting')}
                title={!rules.canStart ? rules.disabledReason : 'Transition to IN_PROGRESS'}
                className="text-xs font-mono"
              >
                <Play className="w-3 h-3 mr-1 text-emerald-400" />
                Start Progress
              </Button>

              {/* Freeze SLA (ON_HOLD) */}
              <Button
                size="sm"
                variant={rules.canHold ? 'secondary' : 'outline'}
                disabled={!rules.canHold || isTransitioning}
                onClick={() => onTransition('ON_HOLD', 'Waiting on customer response / external blocker')}
                title={!rules.canHold ? rules.disabledReason : 'Freeze SLA countdown'}
                className="text-xs font-mono"
              >
                <Pause className="w-3 h-3 mr-1 text-cyan-400" />
                Freeze (ON_HOLD)
              </Button>

              {/* Resume SLA */}
              <Button
                size="sm"
                variant={rules.canResume ? 'primary' : 'outline'}
                disabled={!rules.canResume || isTransitioning}
                onClick={() => onTransition('IN_PROGRESS', 'Resumed troubleshooting from hold')}
                title={!rules.canResume ? rules.disabledReason : 'Unfreeze SLA countdown'}
                className="text-xs font-mono"
              >
                <Play className="w-3 h-3 mr-1 text-emerald-400" />
                Resume Progress
              </Button>

              {/* Resolve */}
              <Button
                size="sm"
                variant={rules.canResolve ? 'primary' : 'outline'}
                disabled={!rules.canResolve || isTransitioning}
                onClick={() => onTransition('RESOLVED', 'Issue diagnosed and resolved successfully')}
                title={!rules.canResolve ? rules.disabledReason : 'Resolve ticket and cancel SLA timers'}
                className="text-xs font-mono"
              >
                <CheckCircle className="w-3 h-3 mr-1 text-emerald-400" />
                Resolve Ticket
              </Button>
            </div>

            {/* Terminal Close Action */}
            {ticket.status === 'RESOLVED' && (
              <Button
                size="sm"
                variant="secondary"
                disabled={!rules.canClose || isTransitioning}
                onClick={() => onTransition('CLOSED', 'Customer confirmed resolution')}
                className="w-full mt-2 text-xs font-mono"
              >
                <Archive className="w-3 h-3 mr-1" />
                Close Ticket Permanently
              </Button>
            )}
          </div>

          {/* Immutable Audit Log Timeline */}
          <div className="pt-2">
            <AuditLogTimeline logs={auditLogs} ticketNumber={ticket.ticketNumber} />
          </div>
        </div>
      </div>
    </div>
  );
}
