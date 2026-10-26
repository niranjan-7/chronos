'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTenantStore } from '../../stores/tenant-store';
import { useTelemetryStore } from '../../stores/telemetry-store';
import { fetchLiveDashboardMetrics } from '../../lib/api-client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Activity,
  AlertTriangle,
  Flame,
  CheckCircle2,
  Clock,
  ShieldAlert,
  Users,
  RefreshCw,
  Radio,
} from 'lucide-react';
import { formatTimeAgo } from '../../lib/utils';
import { LiveDashboardMetrics } from '../../types/telemetry';

export default function WarRoomPage() {
  const activeTenant = useTenantStore((s) => s.activeTenant);
  const { recentAlerts } = useTelemetryStore();

  const {
    data: metrics,
    isFetching,
    refetch,
  } = useQuery<LiveDashboardMetrics>({
    queryKey: ['liveDashboardMetrics', activeTenant.id],
    queryFn: fetchLiveDashboardMetrics,
    // Provide instant initial fallback metrics while loading or when backend is offline
    initialData: {
      tenantId: activeTenant.id,
      source: 'REDIS_PRE_AGGREGATED',
      cachedAt: new Date().toISOString(),
      summary: {
        totalTickets: 24,
        openCount: 14,
        assignedCount: 4,
        inProgressCount: 6,
        onHoldCount: 2,
        resolvedCount: 38,
        closedCount: 120,
        breachedCount: 1,
        atRiskCount: 3,
      },
      priorities: {
        urgent: 2,
        high: 7,
        medium: 11,
        low: 4,
      },
    },
    refetchInterval: 30000,
  });

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

  const priorities = metrics?.priorities || {
    urgent: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  return (
    <div className="space-y-6">
      {/* Top Banner / Pulse Summary */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-slate-800 bg-slate-900/30 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-cyan-950/80 border border-cyan-500/30 flex items-center justify-center">
            <Radio className="w-5 h-5 text-cyan-400 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-slate-100">
                Live SLA Monitoring Feed
              </h2>
              <Badge variant="healthy" className="text-[10px] py-0 px-1.5">
                SUB-MILLI DISPATCH
              </Badge>
            </div>
            <p className="text-xs text-slate-400 font-mono">
              Tenant: <span className="text-cyan-300">{activeTenant.name}</span> • Room:{' '}
              <span className="text-slate-300">tenant:{activeTenant.id.slice(0, 8)}:war-room</span>
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
            Sync CQRS Hash
          </Button>
        </div>
      </div>

      {/* Primary KPI Status Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. Open Active Queue */}
        <Card className="border-slate-800 bg-slate-900/40 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 rounded-full blur-2xl" />
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider font-mono">
              Open Queue
            </span>
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-3xl font-extrabold text-slate-100 font-mono tracking-tight">
              {summary.openCount}
            </div>
            <Badge variant="neutral" className="text-[10px]">
              {summary.totalTickets} total
            </Badge>
          </div>
          <p className="text-[11px] text-slate-500 font-mono mt-2">
            {summary.inProgressCount} in progress • {summary.assignedCount} assigned
          </p>
        </Card>

        {/* 2. SLA Warning (>=80% Duration) */}
        <Card className="border-amber-500/30 bg-amber-950/10 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/10 rounded-full blur-2xl" />
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-amber-400 uppercase tracking-wider font-mono">
              At-Risk Warning (≥80%)
            </span>
            <AlertTriangle className="w-4 h-4 text-amber-400 animate-bounce" />
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-3xl font-extrabold text-amber-300 font-mono tracking-tight">
              {summary.atRiskCount}
            </div>
            <Badge variant="warning" className="text-[10px]">
              AT RISK
            </Badge>
          </div>
          <p className="text-[11px] text-amber-500/80 font-mono mt-2">
            Approaching deadline limit
          </p>
        </Card>

        {/* 3. SLA Breached (100% Limit) */}
        <Card
          className={`relative overflow-hidden transition-all ${
            summary.breachedCount > 0
              ? 'border-rose-500/50 bg-rose-950/20 shadow-[0_0_20px_rgba(244,63,94,0.15)] animate-pulse-glow'
              : 'border-slate-800 bg-slate-900/40'
          }`}
        >
          <div className="absolute top-0 right-0 w-24 h-24 bg-rose-500/15 rounded-full blur-2xl" />
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-rose-400 uppercase tracking-wider font-mono">
              SLA Breached (100%)
            </span>
            <Flame className="w-4 h-4 text-rose-400 animate-pulse" />
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-3xl font-extrabold text-rose-300 font-mono tracking-tight">
              {summary.breachedCount}
            </div>
            <Badge variant="breach" className="text-[10px]">
              CRITICAL
            </Badge>
          </div>
          <p className="text-[11px] text-rose-400/80 font-mono mt-2">
            Auto-escalated in BullMQ
          </p>
        </Card>

        {/* 4. On-Hold / Paused Tickets */}
        <Card className="border-cyan-500/30 bg-cyan-950/10 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/10 rounded-full blur-2xl" />
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider font-mono">
              Paused SLA (ON_HOLD)
            </span>
            <Clock className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="flex items-baseline justify-between">
            <div className="text-3xl font-extrabold text-cyan-300 font-mono tracking-tight">
              {summary.onHoldCount}
            </div>
            <Badge variant="paused" className="text-[10px]">
              FROZEN
            </Badge>
          </div>
          <p className="text-[11px] text-cyan-400/80 font-mono mt-2">
            Timer paused until IN_PROGRESS
          </p>
        </Card>
      </div>

      {/* Priority Breakdown & Real-Time Alert Stream */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Real-Time SLA Alert Stream */}
        <div className="lg:col-span-2 space-y-4">
          <Card className="border-slate-800 bg-slate-900/40">
            <CardHeader className="flex flex-row items-center justify-between border-b border-slate-800/80 pb-3">
              <div>
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-rose-400" />
                  Real-Time SLA Warning & Breach Telemetry
                </CardTitle>
                <CardDescription className="font-mono text-[11px]">
                  Sub-millisecond domain events pushed over Redis Pub/Sub WebSocket adapter
                </CardDescription>
              </div>
              <Badge variant="healthy" className="text-[10px]">
                LIVE STREAM
              </Badge>
            </CardHeader>

            <CardContent className="pt-4">
              {recentAlerts.length === 0 ? (
                <div className="py-12 text-center space-y-2">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto opacity-80" />
                  <p className="text-sm font-medium text-slate-300">
                    No Active SLA Breaches or Warnings
                  </p>
                  <p className="text-xs text-slate-500 font-mono max-w-sm mx-auto">
                    All tenant tickets are currently tracking within their 80% resolution targets.
                    Incoming WebSocket alerts will populate here in real time.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5 max-h-[420px] overflow-y-auto pr-1">
                  {recentAlerts.map((alert, idx) => {
                    const isBreach = alert.type === 'BREACH';
                    return (
                      <div
                        key={`${alert.ticketId}-${idx}`}
                        className={`p-3 rounded-lg border flex items-center justify-between transition-all ${
                          isBreach
                            ? 'border-rose-500/30 bg-rose-950/20'
                            : 'border-amber-500/30 bg-amber-950/20'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          {isBreach ? (
                            <Flame className="w-5 h-5 text-rose-400 shrink-0 animate-pulse" />
                          ) : (
                            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
                          )}

                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-bold text-slate-100">
                                {alert.ticketNumber}
                              </span>
                              <Badge
                                variant={isBreach ? 'breach' : 'warning'}
                                className="text-[10px] py-0 px-1.5"
                              >
                                {isBreach ? '100% BREACH' : '80% WARNING'}
                              </Badge>
                              <Badge variant="urgent" className="text-[10px] py-0 px-1.5">
                                {alert.priority}
                              </Badge>
                            </div>
                            <span className="text-[11px] text-slate-400 font-mono mt-0.5">
                              Status: <span className="text-slate-300">{alert.status}</span>
                              {alert.assignedAgentId && (
                                <> • Agent: {alert.assignedAgentId.slice(0, 8)}</>
                              )}
                            </span>
                          </div>
                        </div>

                        <div className="flex flex-col items-end text-right">
                          <span className="text-[10px] font-mono text-slate-400">
                            {formatTimeAgo(alert.timestamp)}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500">
                            {new Date(alert.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Workload Distribution by Priority */}
        <div className="space-y-4">
          <Card className="border-slate-800 bg-slate-900/40">
            <CardHeader className="border-b border-slate-800/80 pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Users className="w-4 h-4 text-cyan-400" />
                Priority Breakdown
              </CardTitle>
              <CardDescription className="font-mono text-[11px]">
                Pre-aggregated Redis live counters
              </CardDescription>
            </CardHeader>

            <CardContent className="pt-4 space-y-4">
              {/* Urgent */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-rose-400 font-semibold flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-rose-500" />
                    URGENT
                  </span>
                  <span className="text-slate-200 font-bold">{priorities.urgent}</span>
                </div>
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-rose-500 rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        (priorities.urgent / Math.max(1, summary.openCount)) * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {/* High */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-orange-400 font-semibold flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-orange-500" />
                    HIGH
                  </span>
                  <span className="text-slate-200 font-bold">{priorities.high}</span>
                </div>
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-orange-500 rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        (priorities.high / Math.max(1, summary.openCount)) * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {/* Medium */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-yellow-400 font-semibold flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    MEDIUM
                  </span>
                  <span className="text-slate-200 font-bold">{priorities.medium}</span>
                </div>
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-yellow-500 rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        (priorities.medium / Math.max(1, summary.openCount)) * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {/* Low */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="text-blue-400 font-semibold flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-blue-500" />
                    LOW
                  </span>
                  <span className="text-slate-200 font-bold">{priorities.low}</span>
                </div>
                <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.min(
                        100,
                        (priorities.low / Math.max(1, summary.openCount)) * 100,
                      )}%`,
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
