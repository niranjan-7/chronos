'use client';

import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTenantStore } from '../../stores/tenant-store';
import { fetchLiveDashboardMetrics, fetchTickets } from '../../lib/api-client';
import { Card } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { SlaCountdownTimer } from '../../components/ui/sla-countdown-timer';
import { BreachToastContainer, BreachToastNotification } from '../../components/ui/breach-toast';
import {
  Activity,
  AlertTriangle,
  Flame,
  Users,
  RefreshCw,
  Radio,
  Pause,
  Filter,
} from 'lucide-react';
import { LiveDashboardMetrics, Ticket, TicketPriority } from '../../types/telemetry';

export default function WarRoomPage() {
  const activeTenant = useTenantStore((s) => s.activeTenant);
  const [breachToasts, setBreachToasts] = useState<BreachToastNotification[]>([]);
  const [filterPriority, setFilterPriority] = useState<string>('ALL');

  // 1. Live CQRS Dashboard Metrics
  const {
    data: metrics,
    isFetching,
    refetch,
  } = useQuery<LiveDashboardMetrics>({
    queryKey: ['liveDashboardMetrics', activeTenant.id],
    queryFn: fetchLiveDashboardMetrics,
    initialData: {
      tenantId: activeTenant.id,
      source: 'REDIS_PRE_AGGREGATED',
      cachedAt: new Date().toISOString(),
      summary: {
        totalTickets: 28,
        openCount: 16,
        assignedCount: 6,
        inProgressCount: 7,
        onHoldCount: 3,
        resolvedCount: 42,
        closedCount: 120,
        breachedCount: 1,
        atRiskCount: 4,
      },
      priorities: {
        urgent: 3,
        high: 8,
        medium: 12,
        low: 5,
      },
    },
    refetchInterval: 30000,
  });

  // 2. Active Tickets Grid for Millisecond Countdown Matrix
  const initialActiveTickets: Ticket[] = [
    {
      id: 'tck-urg-1',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001099',
      title: 'WebRTC Signaling Socket Timeout Under Spike Load',
      description: 'Signaling server dropped 12% of inbound WebRTC ICE handshake requests.',
      priority: 'URGENT',
      status: 'IN_PROGRESS',
      assignedAgentId: '00000000-0000-0000-0000-000000000002',
      assignedAgent: {
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Sarah Chen',
        email: 'sarah.chen@acme.corp',
      },
      requiredSkills: ['voice_webrtc', 'messaging_a2p'],
      isBreached: false,
      isWarningSent: true,
      targetBreachAt: new Date(Date.now() + 14 * 60 * 1000 + 22 * 1000).toISOString(), // 14m 22s remaining (>=80% warning)
      createdAt: new Date(Date.now() - 48 * 60 * 1000).toISOString(), // 48m ago out of 60m
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'tck-brc-1',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001088',
      title: 'A2P SMS Gateway Carrier Queue Backlog (Exceeded SLA)',
      description: 'Carrier network congestion caused OTP delivery latency to exceed 100% threshold.',
      priority: 'URGENT',
      status: 'IN_PROGRESS',
      assignedAgentId: '00000000-0000-0000-0000-000000000003',
      assignedAgent: {
        id: '00000000-0000-0000-0000-000000000003',
        name: 'David Kim',
        email: 'david.kim@acme.corp',
      },
      requiredSkills: ['messaging_a2p'],
      isBreached: true,
      isWarningSent: true,
      targetBreachAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // Overdue by 5m
      createdAt: new Date(Date.now() - 65 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'tck-hld-1',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001077',
      title: 'Stripe Webhook Signature Verification Discrepancy',
      description: 'Frozen while waiting for tenant security team to rotate HMAC signing secret.',
      priority: 'HIGH',
      status: 'ON_HOLD',
      assignedAgentId: '00000000-0000-0000-0000-000000000002',
      assignedAgent: {
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Sarah Chen',
        email: 'sarah.chen@acme.corp',
      },
      requiredSkills: ['rest_api', 'billing'],
      isBreached: false,
      isWarningSent: false,
      remainingSlaMs: 7820000, // Frozen at ~2h 10m
      createdAt: new Date(Date.now() - 110 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'tck-on-track-1',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001066',
      title: 'REST API Rate Limit Headers Missing on Batch Ingestion',
      description: 'Customers requesting X-RateLimit-Reset headers on high-throughput bulk endpoints.',
      priority: 'MEDIUM',
      status: 'IN_PROGRESS',
      assignedAgentId: '00000000-0000-0000-0000-000000000003',
      assignedAgent: {
        id: '00000000-0000-0000-0000-000000000003',
        name: 'David Kim',
        email: 'david.kim@acme.corp',
      },
      requiredSkills: ['rest_api'],
      isBreached: false,
      isWarningSent: false,
      targetBreachAt: new Date(Date.now() + 8 * 3600 * 1000).toISOString(), // 8 hours remaining
      createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'tck-open-queue-1',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001055',
      title: 'Inbound Call Routing Audio Transcoding Delay',
      description: 'Audio packets delayed when converting Opus codecs to G.711u.',
      priority: 'HIGH',
      status: 'OPEN',
      assignedAgentId: null,
      requiredSkills: ['voice_webrtc'],
      isBreached: false,
      isWarningSent: false,
      targetBreachAt: new Date(Date.now() + 2 * 3600 * 1000 + 40 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const { data: tickets = initialActiveTickets } = useQuery<Ticket[]>({
    queryKey: ['tickets', activeTenant.id],
    queryFn: () => fetchTickets(),
    initialData: initialActiveTickets,
  });

  // Handle SLA Breach callback from <SlaCountdownTimer />
  const handleBreachTriggered = (
    ticketId: string,
    ticketNumber: string,
    priority: TicketPriority,
  ) => {
    setBreachToasts((prev) => [
      {
        id: `toast-${Date.now()}-${ticketId}`,
        ticketId,
        ticketNumber,
        priority: priority === 'HIGH' ? 'URGENT' : priority,
        timestamp: new Date().toISOString(),
      },
      ...prev,
    ]);
  };

  const handleDismissToast = (id: string) => {
    setBreachToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const summary = metrics?.summary || {
    totalTickets: 0,
    openCount: 0,
    assignedCount: 0,
    inProgressCount: 0,
    onHoldCount: 0,
    resolvedCount: 0,
    closedCount: 0,
    breachedCount: 0,
    atRiskCount: 0,
  };

  // Filter and sort tickets by urgency: breached first, then shortest remaining time
  const sortedTickets = useMemo(() => {
    const list = tickets.filter((t) => {
      if (filterPriority === 'ALL') return true;
      return t.priority === filterPriority;
    });

    return [...list].sort((a, b) => {
      if (a.isBreached && !b.isBreached) return -1;
      if (!a.isBreached && b.isBreached) return 1;
      const timeA = a.targetBreachAt ? new Date(a.targetBreachAt).getTime() : Infinity;
      const timeB = b.targetBreachAt ? new Date(b.targetBreachAt).getTime() : Infinity;
      return timeA - timeB;
    });
  }, [tickets, filterPriority]);

  return (
    <div className="space-y-6">
      {/* Breach Toast Container in Bottom-Right */}
      <BreachToastContainer
        notifications={breachToasts}
        onDismiss={handleDismissToast}
        onNavigate={(id) => {
          window.location.href = `/workspace#${id}`;
        }}
      />

      {/* Top Banner / Pulse Summary */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-slate-800 bg-slate-900/30 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-cyan-950/80 border border-cyan-500/30 flex items-center justify-center">
            <Radio className="w-5 h-5 text-cyan-400 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-slate-100">
                War-Room Telemetry & Countdown Matrix
              </h2>
              <Badge variant="healthy" className="text-[10px] py-0 px-1.5">
                CQRS SUB-50MS READS
              </Badge>
            </div>
            <p className="text-xs text-slate-400 font-mono">
              Tenant: <span className="text-cyan-300">{activeTenant.name}</span> • 60 FPS requestAnimationFrame Countdown Engine
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            loading={isFetching}
            className="text-xs font-mono"
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Sync Redis Live Hashes
          </Button>
        </div>
      </div>

      {/* 5 Top High-Contrast KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* 1. Active Open Tickets */}
        <Card className="border-slate-800 bg-slate-900/40 relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider font-mono">
              Active Open
            </span>
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="text-3xl font-extrabold text-slate-100 font-mono tracking-tight">
            {summary.openCount}
          </div>
          <p className="text-[11px] text-slate-500 font-mono mt-2">
            {summary.inProgressCount} in progress • {summary.assignedCount} assigned
          </p>
        </Card>

        {/* 2. At-Risk (80% SLA Warning) */}
        <Card className="border-amber-500/40 bg-amber-950/15 relative overflow-hidden shadow-[0_0_15px_rgba(245,158,11,0.1)]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider font-mono">
              At-Risk (≥80%)
            </span>
            <AlertTriangle className="w-4 h-4 text-amber-400 animate-bounce" />
          </div>
          <div className="text-3xl font-extrabold text-amber-300 font-mono tracking-tight">
            {summary.atRiskCount}
          </div>
          <p className="text-[11px] text-amber-500/80 font-mono mt-2">
            Approaching breach limit
          </p>
        </Card>

        {/* 3. Breached (100% SLA) */}
        <Card
          className={`relative overflow-hidden transition-all ${
            summary.breachedCount > 0
              ? 'border-rose-500/60 bg-rose-950/25 shadow-[0_0_20px_rgba(244,63,94,0.2)] animate-pulse-glow'
              : 'border-slate-800 bg-slate-900/40'
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-rose-400 uppercase tracking-wider font-mono">
              Breached (100%)
            </span>
            <Flame className="w-4 h-4 text-rose-400 animate-pulse" />
          </div>
          <div className="text-3xl font-extrabold text-rose-300 font-mono tracking-tight">
            {summary.breachedCount}
          </div>
          <p className="text-[11px] text-rose-400/80 font-mono mt-2">
            Escalated in BullMQ queue
          </p>
        </Card>

        {/* 4. Paused (On-Hold) */}
        <Card className="border-cyan-500/40 bg-cyan-950/15 relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider font-mono">
              Paused (On-Hold)
            </span>
            <Pause className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-3xl font-extrabold text-cyan-300 font-mono tracking-tight">
            {summary.onHoldCount}
          </div>
          <p className="text-[11px] text-cyan-400/80 font-mono mt-2">
            SLA timers frozen
          </p>
        </Card>

        {/* 5. Online Agent Capacity */}
        <Card className="border-emerald-500/30 bg-emerald-950/15 relative overflow-hidden">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider font-mono">
              Agent Capacity
            </span>
            <Users className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-3xl font-extrabold text-emerald-300 font-mono tracking-tight">
            {summary.assignedCount + summary.inProgressCount} / 25
          </div>
          <p className="text-[11px] text-emerald-400/80 font-mono mt-2">
            Live concurrency load slots
          </p>
        </Card>
      </div>

      {/* Filter and Priority Tabs Bar */}
      <div className="flex items-center justify-between p-3 rounded-xl border border-slate-800 bg-slate-900/40">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-400" />
          <span className="text-xs font-mono text-slate-300">Filter Urgency:</span>
          {['ALL', 'URGENT', 'HIGH', 'MEDIUM', 'LOW'].map((p) => (
            <button
              key={p}
              onClick={() => setFilterPriority(p)}
              className={`px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors cursor-pointer ${
                filterPriority === p
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        <span className="text-xs font-mono text-slate-500">
          Showing {sortedTickets.length} active countdown timers
        </span>
      </div>

      {/* Live SLA Millisecond Countdown Matrix */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {sortedTickets.map((ticket) => (
          <Card
            key={ticket.id}
            className={`border transition-all hover:border-slate-700 ${
              ticket.isBreached
                ? 'border-rose-500/60 bg-rose-950/10 shadow-[0_0_15px_rgba(244,63,94,0.15)]'
                : ticket.isWarningSent
                ? 'border-amber-500/40 bg-amber-950/10'
                : ticket.status === 'ON_HOLD'
                ? 'border-cyan-500/30 bg-cyan-950/10'
                : 'border-slate-800 bg-slate-900/40'
            }`}
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
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
              </div>

              <Badge
                variant={
                  ticket.status === 'IN_PROGRESS'
                    ? 'healthy'
                    : ticket.status === 'ON_HOLD'
                    ? 'paused'
                    : ticket.status === 'RESOLVED'
                    ? 'neutral'
                    : 'warning'
                }
                className="text-[10px] py-0 px-1.5"
              >
                {ticket.status}
              </Badge>
            </div>

            <h4 className="text-sm font-semibold text-slate-100 line-clamp-1 mb-1">
              {ticket.title}
            </h4>
            <p className="text-xs text-slate-400 line-clamp-2 mb-3">
              {ticket.description}
            </p>

            {/* Live Countdown Timer Component */}
            <SlaCountdownTimer
              ticketId={ticket.id}
              ticketNumber={ticket.ticketNumber}
              priority={ticket.priority}
              status={ticket.status}
              createdAt={ticket.createdAt}
              targetBreachAt={ticket.targetBreachAt}
              remainingSlaMs={ticket.remainingSlaMs}
              isBreached={ticket.isBreached}
              onBreachTriggered={handleBreachTriggered}
              className="mb-3"
            />

            {/* Footer with Agent and Skill Tags */}
            <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-[11px] font-mono text-slate-400">
              <span className="truncate">
                {ticket.assignedAgent ? (
                  <span className="text-slate-300">Agent: {ticket.assignedAgent.name}</span>
                ) : (
                  <span className="text-slate-500 italic">Unassigned (Pool)</span>
                )}
              </span>

              <div className="flex items-center gap-1">
                {ticket.requiredSkills.map((skill) => (
                  <span
                    key={skill}
                    className="px-1.5 py-0.2 rounded text-[9px] bg-slate-950 border border-slate-800 text-slate-400"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
