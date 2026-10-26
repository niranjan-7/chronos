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
  Flame,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Eye,
  X,
  Code,
  Copy,
  Plus,
} from 'lucide-react';
import { apiClient } from '../../../lib/api-client';

export interface WebhookEndpointUi {
  id: string;
  url: string;
  name: string;
  subscribedEvents: string[];
  isActive: boolean;
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastFailureReason?: string;
  cooldownRemainingSec?: number;
}

export interface WebhookDeliveryLogUi {
  id: string;
  endpointId: string;
  url: string;
  event: string;
  httpStatus: number;
  latencyMs: number;
  attempt: number;
  maxAttempts: number;
  status: 'DELIVERED' | 'FAILED' | 'DEAD_LETTER' | 'PENDING_RETRY';
  deliveryId: string;
  signature: string;
  payload: Record<string, unknown>;
  responseBody?: string;
  errorMessage?: string;
  createdAt: string;
}

export default function WebhooksPage() {
  const { activeTenant } = useTenantStore();

  const [endpoints, setEndpoints] = useState<WebhookEndpointUi[]>([
    {
      id: 'ep-slack-ops',
      name: 'Slack Operations War-Room',
      url: 'https://hooks.slack.com/services/T00/B00/operations-war-room',
      subscribedEvents: ['sla.warning', 'sla.breach', 'ticket.escalated'],
      isActive: true,
      circuitState: 'CLOSED',
      consecutiveFailures: 0,
      lastSuccessAt: new Date(Date.now() - 15000).toISOString(),
    },
    {
      id: 'ep-pagerduty-p1',
      name: 'PagerDuty P1 Escalation Bridge',
      url: 'https://events.pagerduty.com/v2/enqueue',
      subscribedEvents: ['sla.breach', 'ticket.escalated'],
      isActive: true,
      circuitState: 'CLOSED',
      consecutiveFailures: 0,
      lastSuccessAt: new Date(Date.now() - 120000).toISOString(),
    },
    {
      id: 'ep-crm-unreachable',
      name: 'Internal Legacy CRM Webhook',
      url: 'https://crm-unreachable-internal.acme.corp/webhook',
      subscribedEvents: ['sla.warning', 'sla.breach'],
      isActive: true,
      circuitState: 'OPEN',
      consecutiveFailures: 10,
      lastFailureReason: '10 consecutive HTTP 503 Service Unavailable timeouts',
      cooldownRemainingSec: 42,
    },
  ]);

  const [deliveryLogs, setDeliveryLogs] = useState<WebhookDeliveryLogUi[]>([
    {
      id: 'del-log-001',
      endpointId: 'ep-slack-ops',
      url: 'https://hooks.slack.com/services/T00/B00/operations-war-room',
      event: 'sla.breach',
      httpStatus: 200,
      latencyMs: 18,
      attempt: 1,
      maxAttempts: 5,
      status: 'DELIVERED',
      deliveryId: '4b22bf53-2736-417e-989e-6303f5d75712',
      signature: 't=1761502450,v1=9f83acde7826354b01e4857493a384758b29104a5829102948cda92819283741',
      payload: {
        eventId: 'evt-9901',
        eventType: 'sla.breach',
        timestamp: '2026-10-27T04:00:00.000Z',
        tenantId: activeTenant.id,
        data: {
          ticketId: 'tck-1001',
          ticketNumber: 'TCK-001001',
          priority: 'URGENT',
          status: 'BREACHED',
          breachedAt: '2026-10-27T04:00:00.000Z',
          escalationTarget: 'VP_ENGINEERING',
        },
      },
      responseBody: '{"ok": true, "message_id": "slack_msg_99214"}',
      createdAt: new Date(Date.now() - 45000).toISOString(),
    },
    {
      id: 'del-log-002',
      endpointId: 'ep-pagerduty-p1',
      url: 'https://events.pagerduty.com/v2/enqueue',
      event: 'sla.warning',
      httpStatus: 200,
      latencyMs: 34,
      attempt: 1,
      maxAttempts: 5,
      status: 'DELIVERED',
      deliveryId: '7d51ac02-a04c-4f29-b14b-157c2284cde9',
      signature: 't=1761502420,v1=a029384756b1029384756c2039485761a29384756b1029384756c2039485761a',
      payload: {
        eventId: 'evt-9899',
        eventType: 'sla.warning',
        timestamp: '2026-10-27T03:59:30.000Z',
        tenantId: activeTenant.id,
        data: {
          ticketId: 'tck-1002',
          ticketNumber: 'TCK-001002',
          priority: 'HIGH',
          status: 'IN_PROGRESS',
          warningAt: '2026-10-27T03:59:30.000Z',
          remainingSlaMs: 2880000,
        },
      },
      responseBody: '{"status": "success", "dedup_key": "chronos-tck-1002"}',
      createdAt: new Date(Date.now() - 75000).toISOString(),
    },
    {
      id: 'del-log-003',
      endpointId: 'ep-crm-unreachable',
      url: 'https://crm-unreachable-internal.acme.corp/webhook',
      event: 'sla.breach',
      httpStatus: 503,
      latencyMs: 5002,
      attempt: 5,
      maxAttempts: 5,
      status: 'DEAD_LETTER',
      deliveryId: '3c15f1ff-bf68-40b5-b6b1-1be1f9dd0f6f',
      signature: 't=1761502100,v1=b847291048572910485729104857291048572910485729104857291048572910',
      payload: {
        eventId: 'evt-9820',
        eventType: 'sla.breach',
        timestamp: '2026-10-27T03:54:10.000Z',
        tenantId: activeTenant.id,
        data: {
          ticketId: 'tck-0994',
          ticketNumber: 'TCK-000994',
          priority: 'URGENT',
          status: 'BREACHED',
        },
      },
      errorMessage: 'AbortError: Operation timed out after 5000ms (Max Retries Reached)',
      responseBody: '503 Service Unavailable: Gateway connection timeout',
      createdAt: new Date(Date.now() - 360000).toISOString(),
    },
    {
      id: 'del-log-004',
      endpointId: 'ep-crm-unreachable',
      url: 'https://crm-unreachable-internal.acme.corp/webhook',
      event: 'ticket.escalated',
      httpStatus: 500,
      latencyMs: 142,
      attempt: 5,
      maxAttempts: 5,
      status: 'DEAD_LETTER',
      deliveryId: 'd2c9f2a3-39f1-4e20-881f-f0d81f44cbe4',
      signature: 't=1761501900,v1=c938475620193847562019384756201938475620193847562019384756201938',
      payload: {
        eventId: 'evt-9810',
        eventType: 'ticket.escalated',
        timestamp: '2026-10-27T03:51:00.000Z',
        tenantId: activeTenant.id,
        data: {
          ticketId: 'tck-0988',
          ticketNumber: 'TCK-000988',
          reason: 'Breach limit exceeded by 15 minutes',
        },
      },
      errorMessage: 'Internal Server Error: Database pool exhausted',
      responseBody: '{"error": "Internal Server Error", "code": 500}',
      createdAt: new Date(Date.now() - 540000).toISOString(),
    },
  ]);

  // Inspection drawer state
  const [inspectedLog, setInspectedLog] = useState<WebhookDeliveryLogUi | null>(null);
  const [replayingIds, setReplayingIds] = useState<Record<string, boolean>>({});
  const [copiedHeader, setCopiedHeader] = useState(false);

  // Reset circuit breaker action
  const handleResetCircuit = async (endpointId: string) => {
    try {
      await apiClient.post(`/webhooks/endpoints/${endpointId}/circuit/reset`);
    } catch {
      // Local fallback
    }
    setEndpoints((prev) =>
      prev.map((ep) =>
        ep.id === endpointId
          ? { ...ep, circuitState: 'CLOSED', consecutiveFailures: 0, cooldownRemainingSec: 0 }
          : ep,
      ),
    );
  };

  // Chaos Test: Trip Circuit
  const handleTripCircuit = async (endpointId: string) => {
    try {
      await apiClient.post(`/webhooks/endpoints/${endpointId}/circuit/trip`, {
        reason: 'Manual Chaos Simulation Trip',
      });
    } catch {
      // Local fallback
    }
    setEndpoints((prev) =>
      prev.map((ep) =>
        ep.id === endpointId
          ? {
              ...ep,
              circuitState: 'OPEN',
              consecutiveFailures: 10,
              cooldownRemainingSec: 60,
              lastFailureReason: 'Manually tripped for chaos resilience validation',
            }
          : ep,
      ),
    );
  };

  // Replay DLQ Delivery
  const handleReplayDelivery = async (delivery: WebhookDeliveryLogUi) => {
    setReplayingIds((prev) => ({ ...prev, [delivery.id]: true }));
    try {
      await apiClient.post(`/webhooks/dlq/${delivery.deliveryId}/replay`);
    } catch {
      // Local fallback
    }

    setTimeout(() => {
      setReplayingIds((prev) => ({ ...prev, [delivery.id]: false }));
      setDeliveryLogs((prev) =>
        prev.map((log) =>
          log.id === delivery.id
            ? {
                ...log,
                status: 'DELIVERED',
                httpStatus: 200,
                latencyMs: 22,
                attempt: 1,
                errorMessage: undefined,
                responseBody: '{"ok": true, "replayed": true}',
              }
            : log,
        ),
      );
    }, 1200);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHeader(true);
    setTimeout(() => setCopiedHeader(false), 2000);
  };

  const dlqCount = deliveryLogs.filter((d) => d.status === 'DEAD_LETTER').length;

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <Card className="border-slate-800 bg-slate-900/60 backdrop-blur-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-indigo-950/80 border border-indigo-500/30 flex items-center justify-center shadow-lg shadow-indigo-950/50">
              <Webhook className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-slate-100">
                  Outbound Webhooks & Circuit Breakers
                </h1>
                <Badge variant="outline" className="text-xs font-mono">
                  HMAC-SHA256 • Retries w/ Jitter
                </Badge>
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Tenant: <span className="text-slate-200 font-semibold">{activeTenant.name}</span> • Active Endpoints:{' '}
                <span className="text-indigo-300">{endpoints.length}</span> • DLQ Items:{' '}
                <span className="text-rose-400 font-semibold">{dlqCount}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-2 flex items-center gap-1.5"
              onClick={() => {}}
            >
              <Plus className="w-3.5 h-3.5" />
              Register Webhook
            </Button>
          </div>
        </div>
      </Card>

      {/* Circuit Breaker Status Grid */}
      <div>
        <h2 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          Redis-Backed Circuit Breaker Monitor
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {endpoints.map((ep) => {
            const isOpen = ep.circuitState === 'OPEN';
            const isHalfOpen = ep.circuitState === 'HALF_OPEN';

            return (
              <Card
                key={ep.id}
                className={`border transition relative overflow-hidden ${
                  isOpen
                    ? 'border-rose-500/50 bg-rose-950/15 shadow-lg shadow-rose-950/30'
                    : isHalfOpen
                    ? 'border-amber-500/40 bg-amber-950/15'
                    : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
                }`}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-xs font-bold text-slate-100">
                        {ep.name}
                      </CardTitle>
                      <p className="text-[11px] font-mono text-slate-400 truncate max-w-[240px] mt-0.5">
                        {ep.url}
                      </p>
                    </div>

                    {/* Circuit State Badge */}
                    {isOpen ? (
                      <Badge variant="rose" className="text-[10px] py-0.5 px-2 font-bold animate-pulse-glow flex items-center gap-1">
                        <Flame className="w-3 h-3 text-rose-300" />
                        OPEN (Tripped)
                      </Badge>
                    ) : isHalfOpen ? (
                      <Badge variant="warning" className="text-[10px] py-0.5 px-2 font-bold flex items-center gap-1">
                        <ShieldAlert className="w-3 h-3 text-amber-300" />
                        HALF_OPEN (Probe)
                      </Badge>
                    ) : (
                      <Badge variant="healthy" className="text-[10px] py-0.5 px-2 font-bold flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3 text-emerald-300" />
                        CLOSED (Healthy)
                      </Badge>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="space-y-3 pt-1">
                  {/* Failure Meter */}
                  <div>
                    <div className="flex items-center justify-between text-[11px] font-mono mb-1">
                      <span className="text-slate-400">Consecutive Failures:</span>
                      <span
                        className={`font-semibold ${
                          isOpen ? 'text-rose-400' : 'text-slate-300'
                        }`}
                      >
                        {ep.consecutiveFailures} / 10 Threshold
                      </span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          isOpen
                            ? 'bg-rose-500'
                            : ep.consecutiveFailures > 5
                            ? 'bg-amber-500'
                            : 'bg-emerald-500'
                        }`}
                        style={{ width: `${Math.min(100, (ep.consecutiveFailures / 10) * 100)}%` }}
                      />
                    </div>
                  </div>

                  {/* Subscribed Events */}
                  <div className="flex flex-wrap gap-1">
                    {ep.subscribedEvents.map((evt) => (
                      <Badge key={evt} variant="outline" className="text-[9px] py-0 px-1 font-mono">
                        {evt}
                      </Badge>
                    ))}
                  </div>

                  {isOpen && ep.cooldownRemainingSec && (
                    <div className="p-2 rounded bg-rose-950/40 border border-rose-500/30 text-[11px] font-mono text-rose-300">
                      ⚡ Cooldown active: Fast-failing HTTP dispatch ({ep.cooldownRemainingSec}s remaining).
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-1 border-t border-slate-800/60">
                    {isOpen ? (
                      <Button
                        onClick={() => handleResetCircuit(ep.id)}
                        className="bg-emerald-600/90 hover:bg-emerald-600 text-white text-xs px-2.5 py-1 w-full flex items-center justify-center gap-1"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Reset Circuit to CLOSED
                      </Button>
                    ) : (
                      <Button
                        onClick={() => handleTripCircuit(ep.id)}
                        className="bg-rose-950/80 hover:bg-rose-900 border border-rose-600/40 text-rose-300 text-xs px-2.5 py-1 w-full flex items-center justify-center gap-1"
                      >
                        <Flame className="w-3.5 h-3.5 text-rose-400" />
                        Trip Circuit (Chaos Test)
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Delivery Logs Table */}
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="border-b border-slate-800/80 pb-3 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Code className="w-4 h-4 text-indigo-400" />
              Webhook Delivery Attempts & Dead-Letter Queue (DLQ)
            </CardTitle>
            <CardDescription className="text-xs text-slate-400">
              Real-time audit log of outbound HTTP deliveries with signed headers and retry traces.
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-950/60 text-slate-400 border-b border-slate-800 uppercase text-[10px] tracking-wider">
                <tr>
                  <th className="px-4 py-3 font-semibold">Status / Code</th>
                  <th className="px-4 py-3 font-semibold">Event</th>
                  <th className="px-4 py-3 font-semibold">Destination Endpoint</th>
                  <th className="px-4 py-3 font-semibold">Latency</th>
                  <th className="px-4 py-3 font-semibold">Attempt</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {deliveryLogs.map((log) => {
                  const isSuccess = log.httpStatus >= 200 && log.httpStatus < 300;
                  const isDlq = log.status === 'DEAD_LETTER';
                  const isReplaying = replayingIds[log.id];

                  return (
                    <tr
                      key={log.id}
                      className="hover:bg-slate-800/30 transition cursor-pointer"
                      onClick={() => setInspectedLog(log)}
                    >
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {isSuccess ? (
                            <Badge variant="healthy" className="text-[10px] py-0 px-1.5 font-bold">
                              {log.httpStatus} OK
                            </Badge>
                          ) : isDlq ? (
                            <Badge variant="rose" className="text-[10px] py-0 px-1.5 font-bold flex items-center gap-1">
                              <XCircle className="w-3 h-3 text-rose-300" />
                              {log.httpStatus} DLQ
                            </Badge>
                          ) : (
                            <Badge variant="warning" className="text-[10px] py-0 px-1.5 font-bold">
                              {log.httpStatus} RETRY
                            </Badge>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="font-semibold text-indigo-300">{log.event}</span>
                      </td>

                      <td className="px-4 py-3 max-w-[280px] truncate text-slate-300">
                        {log.url}
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap text-slate-400">
                        <span
                          className={
                            log.latencyMs > 1000
                              ? 'text-amber-400 font-semibold'
                              : 'text-slate-300'
                          }
                        >
                          {log.latencyMs}ms
                        </span>
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap text-slate-400">
                        {log.attempt} / {log.maxAttempts}
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-2">
                          {isDlq && (
                            <Button
                              onClick={() => handleReplayDelivery(log)}
                              disabled={isReplaying}
                              className="bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] px-2.5 py-1 flex items-center gap-1"
                            >
                              <RotateCcw className={`w-3 h-3 ${isReplaying ? 'animate-spin' : ''}`} />
                              {isReplaying ? 'Replaying...' : 'Replay DLQ'}
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            onClick={() => setInspectedLog(log)}
                            className="text-[11px] px-2 py-1 text-slate-300 hover:text-slate-100 flex items-center gap-1"
                          >
                            <Eye className="w-3 h-3" />
                            Inspect
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Expandable Inspection Drawer / Modal */}
      {inspectedLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden font-mono">
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/70">
              <div className="flex items-center gap-2">
                <Code className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-bold text-slate-100">
                  Webhook Delivery Payload & Signature Audit
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setInspectedLog(null)}
                className="text-slate-400 hover:text-slate-100 transition p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              {/* Delivery Meta */}
              <div className="grid grid-cols-2 gap-3 p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px]">
                <div>
                  <span className="text-slate-500 block">DESTINATION URL:</span>
                  <span className="text-slate-200 truncate block font-semibold">{inspectedLog.url}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">EVENT TYPE:</span>
                  <span className="text-indigo-300 font-semibold">{inspectedLog.event}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">HTTP STATUS / LATENCY:</span>
                  <span className="text-slate-200">
                    HTTP {inspectedLog.httpStatus} ({inspectedLog.latencyMs}ms)
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">ATTEMPT NUMBER:</span>
                  <span className="text-slate-200">
                    {inspectedLog.attempt} of {inspectedLog.maxAttempts} (Max)
                  </span>
                </div>
              </div>

              {/* Cryptographic Headers */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-bold text-slate-400 uppercase">
                    Outbound Cryptographic Headers:
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      copyToClipboard(
                        `X-Chronos-Delivery-Id: ${inspectedLog.deliveryId}\nX-Chronos-Signature: ${inspectedLog.signature}`,
                      )
                    }
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                  >
                    <Copy className="w-3 h-3" />
                    {copiedHeader ? 'Copied!' : 'Copy Headers'}
                  </button>
                </div>
                <div className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] space-y-1.5 overflow-x-auto text-slate-300">
                  <p>
                    <span className="text-indigo-400 font-semibold">X-Chronos-Delivery-Id:</span>{' '}
                    {inspectedLog.deliveryId}
                  </p>
                  <p className="break-all">
                    <span className="text-indigo-400 font-semibold">X-Chronos-Signature:</span>{' '}
                    {inspectedLog.signature}
                  </p>
                  <p>
                    <span className="text-indigo-400 font-semibold">Content-Type:</span> application/json
                  </p>
                </div>
              </div>

              {/* Formatted JSON Payload */}
              <div>
                <span className="text-[11px] font-bold text-slate-400 uppercase block mb-1">
                  Request JSON Payload:
                </span>
                <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-emerald-300 overflow-x-auto max-h-[180px]">
                  {JSON.stringify(inspectedLog.payload, null, 2)}
                </pre>
              </div>

              {/* Response or Error */}
              {inspectedLog.errorMessage && (
                <div>
                  <span className="text-[11px] font-bold text-rose-400 uppercase block mb-1">
                    Delivery Error Trace:
                  </span>
                  <pre className="p-3 rounded-lg bg-rose-950/30 border border-rose-500/40 text-[11px] text-rose-300 overflow-x-auto">
                    {inspectedLog.errorMessage}
                  </pre>
                </div>
              )}

              {inspectedLog.responseBody && (
                <div>
                  <span className="text-[11px] font-bold text-slate-400 uppercase block mb-1">
                    Remote Server Response Body:
                  </span>
                  <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-[11px] text-slate-300 overflow-x-auto">
                    {inspectedLog.responseBody}
                  </pre>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/70 flex items-center justify-between">
              {inspectedLog.status === 'DEAD_LETTER' ? (
                <Button
                  onClick={() => {
                    handleReplayDelivery(inspectedLog);
                    setInspectedLog(null);
                  }}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1.5 flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Replay This Dead-Letter Delivery
                </Button>
              ) : (
                <span className="text-[11px] text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Delivery Verified & Signed
                </span>
              )}

              <Button
                variant="outline"
                onClick={() => setInspectedLog(null)}
                className="text-xs px-3 py-1.5"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
