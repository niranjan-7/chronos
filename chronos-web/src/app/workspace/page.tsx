'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTenantStore } from '../../stores/tenant-store';
import { claimNextTicket, fetchTickets, transitionTicket } from '../../lib/api-client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Layers,
  Zap,
  Play,
  Pause,
  CheckCircle,
  Archive,
  AlertCircle,
  UserCheck,
  Clock,
} from 'lucide-react';
import { Ticket, TicketStatus } from '../../types/telemetry';

export default function WorkspacePage() {
  const queryClient = useQueryClient();
  const { activeTenant, activePersona } = useTenantStore();
  const [claimError, setClaimError] = useState<string | null>(null);

  // Initial mock tickets so the UI displays a rich workspace immediately
  const initialTickets: Ticket[] = [
    {
      id: 'tck-sample-1',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001042',
      title: 'WebRTC Audio Stream Packet Loss Under Heavy Load',
      description: 'Customer reporting intermittent packet loss on European signaling servers.',
      priority: 'URGENT',
      status: 'IN_PROGRESS',
      assignedAgentId: activePersona.id,
      assignedAgent: {
        id: activePersona.id,
        name: activePersona.name,
        email: activePersona.email,
      },
      requiredSkills: ['voice_webrtc'],
      isBreached: false,
      isWarningSent: true,
      remainingSlaMs: 1420000,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'tck-sample-2',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001043',
      title: 'A2P SMS Delivery Delay via Tier-1 Aggregator',
      description: 'Outbound OTP messages queued for >45s during morning spike.',
      priority: 'HIGH',
      status: 'OPEN',
      assignedAgentId: null,
      requiredSkills: ['messaging_a2p'],
      isBreached: false,
      isWarningSent: false,
      remainingSlaMs: 7200000,
      createdAt: new Date(Date.now() - 1800000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: 'tck-sample-3',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001044',
      title: 'Billing Webhook Duplicate Invoicing Webhook Trigger',
      description: 'Stripe webhook receiver processing duplicate events on retry.',
      priority: 'MEDIUM',
      status: 'ON_HOLD',
      assignedAgentId: activePersona.id,
      assignedAgent: {
        id: activePersona.id,
        name: activePersona.name,
        email: activePersona.email,
      },
      requiredSkills: ['billing', 'rest_api'],
      isBreached: false,
      isWarningSent: false,
      remainingSlaMs: 12000000,
      createdAt: new Date(Date.now() - 7200000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const { data: tickets = initialTickets } = useQuery<Ticket[]>({
    queryKey: ['tickets', activeTenant.id],
    queryFn: () => fetchTickets(),
    initialData: initialTickets,
  });

  // Atomic Claim Mutation
  const claimMutation = useMutation({
    mutationFn: () => claimNextTicket({ requiredSkills: activePersona.skills }),
    onSuccess: (newTicket) => {
      setClaimError(null);
      queryClient.setQueryData<Ticket[]>(['tickets', activeTenant.id], (old = []) => [
        newTicket,
        ...old.filter((t) => t.id !== newTicket.id),
      ]);
    },
    onError: (err: unknown) => {
      const message =
        typeof err === 'object' && err !== null && 'response' in err
          ? (err as { response?: { data?: { message?: string } } }).response?.data?.message
          : undefined;
      setClaimError(
        message || 'No available unassigned tickets found matching your skills in the pool.',
      );
    },
  });

  // State Transition Mutation
  const transitionMutation = useMutation({
    mutationFn: ({ id, newStatus }: { id: string; newStatus: TicketStatus }) =>
      transitionTicket(id, newStatus),
    onSuccess: (updated) => {
      queryClient.setQueryData<Ticket[]>(['tickets', activeTenant.id], (old = []) =>
        old.map((t) => (t.id === updated.id ? updated : t)),
      );
    },
    onError: (err: unknown) => {
      const message =
        typeof err === 'object' && err !== null && 'response' in err
          ? (err as { response?: { data?: { message?: string } } }).response?.data?.message
          : 'Invalid ticket state transition!';
      alert(message);
    },
  });

  const activeLoad = tickets.filter(
    (t) =>
      t.assignedAgentId === activePersona.id &&
      ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(t.status),
  ).length;

  const maxCapacity = activePersona.maxCapacity || 5;

  return (
    <div className="space-y-6">
      {/* Top Agent Capacity & Claim Action Header */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Agent Profile & Capacity Gauge */}
        <Card className="border-slate-800 bg-slate-900/40 md:col-span-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-950/80 border border-emerald-500/30 flex items-center justify-center">
                <UserCheck className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  {activePersona.name}
                  <Badge variant="healthy" className="text-[10px] py-0 px-1.5">
                    ONLINE
                  </Badge>
                </h3>
                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                  <span className="text-[11px] text-slate-400 font-mono">Skills:</span>
                  {(activePersona.skills || ['voice_webrtc', 'messaging_a2p']).map((skill) => (
                    <span
                      key={skill}
                      className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-800 border border-slate-700 text-slate-300"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Capacity Progress Bar */}
            <div className="flex flex-col sm:items-end min-w-[140px]">
              <span className="text-xs font-mono text-slate-400">
                Concurrency Load:{' '}
                <span className="font-bold text-slate-100">
                  {activeLoad} / {maxCapacity}
                </span>
              </span>
              <div className="h-2 w-full sm:w-36 bg-slate-800 rounded-full mt-1.5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    activeLoad >= maxCapacity ? 'bg-rose-500' : 'bg-emerald-400'
                  }`}
                  style={{ width: `${Math.min(100, (activeLoad / maxCapacity) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        </Card>

        {/* Atomic Claim Next Ticket CTA */}
        <Card className="border-indigo-500/30 bg-gradient-to-br from-indigo-950/20 to-slate-900/40 flex flex-col justify-center">
          <Button
            variant="primary"
            size="lg"
            loading={claimMutation.isPending}
            disabled={activeLoad >= maxCapacity}
            onClick={() => claimMutation.mutate()}
            className="w-full font-mono text-xs shadow-lg shadow-indigo-500/10"
          >
            <Zap className="w-4 h-4 mr-1.5 text-indigo-600 fill-indigo-600" />
            Claim Next (SKIP LOCKED)
          </Button>

          {claimError && (
            <p className="text-[11px] text-amber-400 font-mono mt-2 flex items-center gap-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {claimError}
            </p>
          )}
        </Card>
      </div>

      {/* Ticket Lifecycle DAG Table */}
      <Card className="border-slate-800 bg-slate-900/40">
        <CardHeader className="border-b border-slate-800/80 pb-3 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400" />
              Assigned Tickets & State Machine DAG
            </CardTitle>
            <CardDescription className="font-mono text-[11px]">
              Enforces strict transitions: OPEN → ASSIGNED → IN_PROGRESS → ON_HOLD → RESOLVED → CLOSED
            </CardDescription>
          </div>
          <Badge variant="neutral" className="text-[10px]">
            {tickets.length} TICKETS
          </Badge>
        </CardHeader>

        <CardContent className="pt-4">
          <div className="space-y-3">
            {tickets.map((ticket) => {
              const isAssignedToMe = ticket.assignedAgentId === activePersona.id;
              return (
                <div
                  key={ticket.id}
                  className={`p-4 rounded-xl border transition-all ${
                    isAssignedToMe
                      ? 'border-indigo-500/30 bg-slate-900/60'
                      : 'border-slate-800 bg-slate-900/20 opacity-80'
                  }`}
                >
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-3">
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
                            ? 'neutral'
                            : 'warning'
                        }
                        className="text-[10px] py-0 px-1.5"
                      >
                        {ticket.status}
                      </Badge>
                      {ticket.isWarningSent && (
                        <Badge variant="warning" className="text-[10px] py-0 px-1.5">
                          ≥80% SLA WARN
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-slate-400 flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 text-slate-500" />
                        Remaining SLA: {Math.max(0, Math.floor((ticket.remainingSlaMs || 0) / 60000))}m
                      </span>
                    </div>
                  </div>

                  <h4 className="text-sm font-semibold text-slate-100 mb-1">{ticket.title}</h4>
                  <p className="text-xs text-slate-400 mb-3">{ticket.description}</p>

                  {/* State Machine Transition Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-mono text-slate-500">Skills required:</span>
                      {ticket.requiredSkills.map((s) => (
                        <span
                          key={s}
                          className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-950 border border-slate-800 text-slate-400"
                        >
                          {s}
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center gap-2">
                      {ticket.status === 'OPEN' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            transitionMutation.mutate({ id: ticket.id, newStatus: 'ASSIGNED' })
                          }
                        >
                          Claim Ticket
                        </Button>
                      )}

                      {ticket.status === 'ASSIGNED' && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            transitionMutation.mutate({ id: ticket.id, newStatus: 'IN_PROGRESS' })
                          }
                        >
                          <Play className="w-3 h-3 mr-1" />
                          Start Working
                        </Button>
                      )}

                      {ticket.status === 'IN_PROGRESS' && (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              transitionMutation.mutate({ id: ticket.id, newStatus: 'ON_HOLD' })
                            }
                          >
                            <Pause className="w-3 h-3 mr-1 text-cyan-400" />
                            Freeze (ON_HOLD)
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() =>
                              transitionMutation.mutate({ id: ticket.id, newStatus: 'RESOLVED' })
                            }
                          >
                            <CheckCircle className="w-3 h-3 mr-1 text-emerald-400" />
                            Resolve
                          </Button>
                        </>
                      )}

                      {ticket.status === 'ON_HOLD' && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() =>
                            transitionMutation.mutate({ id: ticket.id, newStatus: 'IN_PROGRESS' })
                          }
                        >
                          <Play className="w-3 h-3 mr-1 text-emerald-400" />
                          Resume SLA
                        </Button>
                      )}

                      {ticket.status === 'RESOLVED' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            transitionMutation.mutate({ id: ticket.id, newStatus: 'CLOSED' })
                          }
                        >
                          <Archive className="w-3 h-3 mr-1" />
                          Close Ticket
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
