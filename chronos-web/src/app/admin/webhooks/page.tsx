'use client';

import React, { useState } from 'react';
import { useTenantStore } from '../../../stores/tenant-store';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Webhook,
  ShieldCheck,
  ShieldAlert,
  RotateCcw,
  Plus,
  CheckCircle2,
} from 'lucide-react';
import { formatTimeAgo } from '../../../lib/utils';

interface WebhookEndpointUi {
  id: string;
  url: string;
  subscribedEvents: string[];
  isActive: boolean;
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastFailureReason?: string;
  cooldownRemainingSec?: number;
}

export default function WebhooksPage() {
  const { activeTenant } = useTenantStore();

  const [mockEndpoints, setMockEndpoints] = useState<WebhookEndpointUi[]>([
    {
      id: 'ep-slack-ops',
      url: 'https://hooks.slack.com/services/T00/B00/operations-war-room',
      subscribedEvents: ['sla.warning', 'sla.breach', 'ticket.escalated'],
      isActive: true,
      circuitState: 'CLOSED' as const,
      consecutiveFailures: 0,
      lastSuccessAt: new Date().toISOString(),
    },
    {
      id: 'ep-pagerduty-p1',
      url: 'https://events.pagerduty.com/v2/enqueue',
      subscribedEvents: ['sla.breach'],
      isActive: true,
      circuitState: 'CLOSED' as const,
      consecutiveFailures: 0,
      lastSuccessAt: new Date(Date.now() - 120000).toISOString(),
    },
    {
      id: 'ep-crm-unreachable',
      url: 'https://crm-unreachable-internal.acme.corp/webhook',
      subscribedEvents: ['sla.warning', 'sla.breach'],
      isActive: true,
      circuitState: 'OPEN' as const,
      consecutiveFailures: 10,
      lastFailureReason: '10 consecutive HTTP 503 Service Unavailable errors',
      cooldownRemainingSec: 42,
    },
  ]);

  const [mockDlq, setMockDlq] = useState([
    {
      id: 'dlq-del-101',
      endpointId: 'ep-crm-unreachable',
      url: 'https://crm-unreachable-internal.acme.corp/webhook',
      event: 'sla.breach',
      attempt: 5,
      httpStatus: 503,
      latencyMs: 5002,
      error: 'AbortError: Operation timed out after 5000ms',
      createdAt: new Date(Date.now() - 600000).toISOString(),
      replaying: false,
    },
    {
      id: 'dlq-del-102',
      endpointId: 'ep-crm-unreachable',
      url: 'https://crm-unreachable-internal.acme.corp/webhook',
      event: 'sla.warning',
      attempt: 5,
      httpStatus: 500,
      latencyMs: 142,
      error: 'Internal Server Error (Database Connection Pool Exhausted)',
      createdAt: new Date(Date.now() - 300000).toISOString(),
      replaying: false,
    },
  ]);

  const handleResetCircuit = (endpointId: string) => {
    setMockEndpoints((prev) =>
      prev.map((ep) =>
        ep.id === endpointId
          ? { ...ep, circuitState: 'CLOSED', consecutiveFailures: 0 }
          : ep,
      ),
    );
  };

  const handleReplayItem = (id: string) => {
    setMockDlq((prev) => prev.filter((d) => d.id !== id));
  };

  const handleReplayAll = () => {
    setMockDlq([]);
  };

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <Card className="border-slate-800 bg-slate-900/40">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-purple-950/80 border border-purple-500/30 flex items-center justify-center">
              <Webhook className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                Enterprise Outbound Webhook Subscriptions
                <Badge variant="healthy" className="text-[10px] py-0 px-1.5">
                  HMAC-SHA256 SIGNED
                </Badge>
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                Tenant: {activeTenant.name} • AES-256-GCM encrypted secrets at rest
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" className="text-xs font-mono">
              <Plus className="w-3.5 h-3.5 mr-1" />
              Register Endpoint
            </Button>
          </div>
        </div>
      </Card>

      {/* Endpoints & Live Circuit Breakers Table */}
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="border-b border-slate-800/80 pb-3 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              Registered Endpoints & Redis Sliding-Window Circuit Breakers
            </CardTitle>
            <CardDescription className="font-mono text-[11px]">
              Fast-fails immediately when consecutive failures reach 10 within 5 minutes
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="pt-4">
          <div className="space-y-3">
            {mockEndpoints.map((ep) => {
              const isClosed = ep.circuitState === 'CLOSED';
              const isOpen = ep.circuitState === 'OPEN';
              return (
                <div
                  key={ep.id}
                  className={`p-4 rounded-xl border transition-all ${
                    isOpen
                      ? 'border-rose-500/40 bg-rose-950/20 shadow-[0_0_15px_rgba(244,63,94,0.1)]'
                      : 'border-slate-800 bg-slate-900/60'
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-xs font-bold text-slate-100">
                        {ep.url}
                      </span>
                      <Badge
                        variant={isClosed ? 'healthy' : 'breach'}
                        className="text-[10px] py-0 px-1.5"
                      >
                        CIRCUIT {ep.circuitState}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-2">
                      {isOpen && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => handleResetCircuit(ep.id)}
                          className="text-xs font-mono"
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Override & Reset to CLOSED
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-xs font-mono text-slate-400">
                    <div className="flex items-center gap-2">
                      <span>Subscribed:</span>
                      {ep.subscribedEvents.map((ev) => (
                        <span
                          key={ev}
                          className="px-1.5 py-0.2 rounded text-[10px] bg-slate-950 border border-slate-800 text-purple-300"
                        >
                          {ev}
                        </span>
                      ))}
                    </div>

                    <div>
                      {isOpen ? (
                        <span className="text-rose-400 font-semibold">
                          Tripped for 60s cooldown ({ep.consecutiveFailures}/10 consecutive 5xx errors)
                        </span>
                      ) : (
                        <span className="text-emerald-400">
                          Active • 0 failures • 5s hard timeout
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Dead Letter Queue (DLQ) & Manual Replay */}
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="border-b border-slate-800/80 pb-3 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              Dead Letter Queue (DLQ) Deliveries
            </CardTitle>
            <CardDescription className="font-mono text-[11px]">
              Exhausted deliveries after 5 exponential backoff attempts with jitter
            </CardDescription>
          </div>

          {mockDlq.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleReplayAll}
              className="text-xs font-mono"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1" />
              Replay All DLQ Deliveries
            </Button>
          )}
        </CardHeader>

        <CardContent className="pt-4">
          {mockDlq.length === 0 ? (
            <div className="py-10 text-center space-y-1.5">
              <CheckCircle2 className="w-7 h-7 text-emerald-400 mx-auto" />
              <p className="text-sm font-medium text-slate-300">DLQ is Empty</p>
              <p className="text-xs text-slate-500 font-mono">
                Zero dead letter failures recorded. All webhook notifications successfully acknowledged.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {mockDlq.map((del) => (
                <div
                  key={del.id}
                  className="p-3.5 rounded-lg border border-slate-800 bg-slate-950/60 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs font-mono"
                >
                  <div className="flex flex-col space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-200">{del.id}</span>
                      <Badge variant="breach" className="text-[10px] py-0 px-1.5">
                        HTTP {del.httpStatus}
                      </Badge>
                      <Badge variant="warning" className="text-[10px] py-0 px-1.5">
                        Attempt {del.attempt}/5
                      </Badge>
                    </div>
                    <span className="text-slate-400">{del.url}</span>
                    <span className="text-rose-400/90 text-[11px]">{del.error}</span>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-slate-500">
                      {formatTimeAgo(del.createdAt)}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleReplayItem(del.id)}
                      className="text-xs font-mono"
                    >
                      <RotateCcw className="w-3 h-3 mr-1" />
                      Re-Drive
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
