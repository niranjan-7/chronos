'use client';

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTenantStore } from '../../stores/tenant-store';
import { claimNextTicket, fetchTickets, transitionTicket } from '../../lib/api-client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { SlaCountdownTimer } from '../../components/ui/sla-countdown-timer';
import { TicketDetailDrawer } from '../../components/workspace/ticket-detail-drawer';
import {
  Layers,
  Zap,
  UserCheck,
  Star,
  ArrowRight,
} from 'lucide-react';
import { Ticket, TicketStatus } from '../../types/telemetry';
import { AgentStatus } from '../../types/tenant';

export default function WorkspacePage() {
  const queryClient = useQueryClient();
  const { activeTenant, activePersona, setAgentStatus } = useTenantStore();
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);

  // Initial mock tickets with rich lifecycle details
  const initialTickets: Ticket[] = [
    {
      id: 'tck-sample-1',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001042',
      title: 'WebRTC Audio Stream Packet Loss Under Heavy Load',
      description: 'Customer reporting intermittent packet loss on European signaling servers during conference bridges.',
      priority: 'URGENT',
      status: 'IN_PROGRESS',
      assignedAgentId: activePersona.id,
      assignedAgent: {
        id: activePersona.id,
        name: activePersona.name,
        email: activePersona.email,
      },
      requiredSkills: ['voice_webrtc', 'messaging_a2p'],
      isBreached: false,
      isWarningSent: true,
      targetBreachAt: new Date(Date.now() + 18 * 60 * 1000).toISOString(),
      remainingSlaMs: 1080000,
      createdAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      auditLogs: [
        {
          id: 'log-1',
          ticketId: 'tck-sample-1',
          tenantId: activeTenant.id,
          actorId: activePersona.id,
          previousStatus: 'ASSIGNED',
          newStatus: 'IN_PROGRESS',
          reason: 'Agent Sarah Chen initiated debugging on signaling relay node',
          createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        },
        {
          id: 'log-2',
          ticketId: 'tck-sample-1',
          tenantId: activeTenant.id,
          actorId: 'system-router',
          previousStatus: 'OPEN',
          newStatus: 'ASSIGNED',
          reason: 'Auto push-routed to Sarah Chen based on voice_webrtc proficiency level 5',
          createdAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
        },
        {
          id: 'log-3',
          ticketId: 'tck-sample-1',
          tenantId: activeTenant.id,
          actorId: 'customer-api',
          previousStatus: null,
          newStatus: 'OPEN',
          reason: 'Ticket created via transactional outbox dual-write transaction',
          createdAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
        },
      ],
    },
    {
      id: 'tck-sample-2',
      tenantId: activeTenant.id,
      ticketNumber: 'TCK-001043',
      title: 'A2P SMS Delivery Delay via Tier-1 Aggregator',
      description: 'Outbound OTP messages queued for >45s during morning spike in NA region.',
      priority: 'HIGH',
      status: 'OPEN',
      assignedAgentId: null,
      requiredSkills: ['messaging_a2p'],
      isBreached: false,
      isWarningSent: false,
      targetBreachAt: new Date(Date.now() + 120 * 60 * 1000).toISOString(),
      remainingSlaMs: 7200000,
      createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      auditLogs: [
        {
          id: 'log-4',
          ticketId: 'tck-sample-2',
          tenantId: activeTenant.id,
          actorId: 'customer-api',
          previousStatus: null,
          newStatus: 'OPEN',
          reason: 'Ticket ingested into pull queue pool',
          createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        },
      ],
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
      auditLogs: [
        {
          id: 'log-5',
          ticketId: 'tck-sample-3',
          tenantId: activeTenant.id,
          actorId: activePersona.id,
          previousStatus: 'IN_PROGRESS',
          newStatus: 'ON_HOLD',
          reason: 'SLA Paused: Awaiting customer merchant account webhook secrets',
          slaRemainingMs: 12000000,
          createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        },
      ],
    },
  ];

  const { data: tickets = initialTickets } = useQuery<Ticket[]>({
    queryKey: ['tickets', activeTenant.id],
    queryFn: () => fetchTickets(),
    initialData: initialTickets,
  });

  // Atomic Claim Mutation
  const claimMutation = useMutation({
    mutationFn: () =>
      claimNextTicket({
        agentId: activePersona.id,
        requiredSkills: activePersona.skills,
      }),
    onSuccess: (newTicket) => {
      setClaimError(null);
      queryClient.setQueryData<Ticket[]>(['tickets', activeTenant.id], (old = []) => [
        newTicket,
        ...old.filter((t) => t.id !== newTicket.id),
      ]);
      setSelectedTicket(newTicket);
    },
    onError: (err: unknown) => {
      const message =
        typeof err === 'object' && err !== null && 'response' in err
          ? (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message
          : undefined;
      const formattedMessage = Array.isArray(message) ? message.join(', ') : message;
      setClaimError(
        formattedMessage || 'No available unassigned tickets found matching your skills in the pool.',
      );
    },
  });

  // State Transition Mutation
  const transitionMutation = useMutation({
    mutationFn: ({
      id,
      newStatus,
      reason,
      assignedAgentId,
    }: {
      id: string;
      newStatus: TicketStatus;
      reason?: string;
      assignedAgentId?: string;
    }) => transitionTicket(id, newStatus, reason, assignedAgentId),
    onSuccess: (updated) => {
      queryClient.setQueryData<Ticket[]>(['tickets', activeTenant.id], (old = []) =>
        old.map((t) => (t.id === updated.id ? updated : t)),
      );
      if (selectedTicket?.id === updated.id) {
        setSelectedTicket(updated);
      }
    },
    onError: (err: unknown) => {
      const message =
        typeof err === 'object' && err !== null && 'response' in err
          ? (err as { response?: { data?: { message?: string | string[] } } }).response?.data?.message
          : 'Invalid ticket state transition!';
      const formattedMessage = Array.isArray(message) ? message.join(', ') : message;
      alert(formattedMessage);
    },
  });

  // Specific ticket direct claim
  const handleClaimSpecific = (ticket: Ticket) => {
    transitionMutation.mutate({
      id: ticket.id,
      newStatus: 'ASSIGNED',
      reason: `Claimed directly by agent ${activePersona.name}`,
      assignedAgentId: activePersona.id,
    });
  };

  const myTickets = tickets.filter(
    (t) => t.assignedAgentId === activePersona.id && t.status !== 'CLOSED',
  );
  const unassignedTickets = tickets.filter((t) => !t.assignedAgentId && t.status === 'OPEN');

  const activeLoad = myTickets.filter((t) =>
    ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(t.status),
  ).length;

  const maxCapacity = activePersona.maxCapacity || 5;
  const agentStatus = activePersona.status || 'ONLINE';

  return (
    <div className="space-y-6">
      {/* Ticket Detail Drawer Modal */}
      <TicketDetailDrawer
        ticket={selectedTicket}
        onClose={() => setSelectedTicket(null)}
        onTransition={(newStatus, reason) => {
          if (selectedTicket) {
            transitionMutation.mutate({ id: selectedTicket.id, newStatus, reason });
          }
        }}
        isTransitioning={transitionMutation.isPending}
      />

      {/* Agent Status Bar & Capacity Gauge Card */}
      <Card className="border-slate-800 bg-slate-900/40 p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          {/* Left: Agent Info, Toggle Status & Skills with Stars */}
          <div className="flex items-start sm:items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-indigo-500/20 to-cyan-500/20 border border-indigo-500/30 flex items-center justify-center shrink-0">
              <UserCheck className="w-6 h-6 text-indigo-400" />
            </div>

            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-base font-bold text-slate-100">{activePersona.name}</h2>
                <Badge variant="neutral" className="text-[10px] py-0 px-1.5 font-mono">
                  {activePersona.role}
                </Badge>

                {/* Status Toggle Controls */}
                <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-0.5 ml-1">
                  {(['ONLINE', 'BUSY', 'OFFLINE'] as AgentStatus[]).map((status) => {
                    const isCurrent = agentStatus === status;
                    return (
                      <button
                        key={status}
                        onClick={() => setAgentStatus(status)}
                        className={`px-2 py-0.5 text-[10px] font-mono font-medium rounded-md transition-colors cursor-pointer ${
                          isCurrent
                            ? status === 'ONLINE'
                              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold'
                              : status === 'BUSY'
                              ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold'
                              : 'bg-slate-800 text-slate-400 font-bold'
                            : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        {status}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Skills with Proficiency Stars */}
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <span className="text-[11px] text-slate-400 font-mono">Specializations:</span>
                {(
                  activePersona.skillsDetailed || [
                    { name: 'voice_webrtc', proficiency: 5 },
                    { name: 'messaging_a2p', proficiency: 4 },
                  ]
                ).map((skill) => (
                  <div
                    key={skill.name}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-950 border border-slate-800 text-[10px] font-mono text-slate-300"
                  >
                    <span>{skill.name}</span>
                    <div className="flex items-center text-amber-400">
                      {Array.from({ length: skill.proficiency }).map((_, i) => (
                        <Star key={i} className="w-2.5 h-2.5 fill-amber-400" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: Live Concurrency Load & Atomic Claim CTA */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 lg:border-l lg:border-slate-800 lg:pl-6">
            {/* Concurrency Meter */}
            <div className="flex flex-col min-w-[150px]">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-slate-400">Capacity Meter:</span>
                <span className="font-bold text-slate-100">
                  {activeLoad} / {maxCapacity} Slots
                </span>
              </div>
              <div className="h-2 w-full bg-slate-950 rounded-full mt-1.5 overflow-hidden border border-slate-800">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    activeLoad >= maxCapacity ? 'bg-rose-500' : 'bg-emerald-400'
                  }`}
                  style={{ width: `${Math.min(100, (activeLoad / maxCapacity) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-slate-500 mt-1">
                {activeLoad >= maxCapacity ? 'Capacity Maxed' : `${maxCapacity - activeLoad} available slots`}
              </span>
            </div>

            {/* Atomic Claim Next Button */}
            <div className="flex flex-col">
              <Button
                variant="primary"
                size="md"
                loading={claimMutation.isPending}
                disabled={activeLoad >= maxCapacity || agentStatus === 'OFFLINE'}
                onClick={() => claimMutation.mutate()}
                className="font-mono text-xs whitespace-nowrap shadow-lg shadow-indigo-500/10"
              >
                <Zap className="w-4 h-4 mr-1.5 text-indigo-600 fill-indigo-600" />
                Claim Next High-Priority Ticket
              </Button>

              {claimError && (
                <span className="text-[10px] text-amber-400 font-mono mt-1 max-w-xs">
                  {claimError}
                </span>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Two Column Layout: Assigned Active Tickets vs Unassigned Incoming Queue */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: My Assigned Tickets */}
        <div className="space-y-4">
          <Card className="border-slate-800 bg-slate-900/40">
            <CardHeader className="border-b border-slate-800/80 pb-3 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-emerald-400" />
                  My Active Ticket Queue ({myTickets.length})
                </CardTitle>
                <CardDescription className="font-mono text-[11px]">
                  Click ticket to open lifecycle drawer & audit trail
                </CardDescription>
              </div>
              <Badge variant="healthy" className="text-[10px]">
                {activeLoad} / {maxCapacity} ACTIVE
              </Badge>
            </CardHeader>

            <CardContent className="pt-4">
              {myTickets.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-500 font-mono">
                  No tickets currently assigned. Click &quot;Claim Next High-Priority Ticket&quot; above.
                </div>
              ) : (
                <div className="space-y-3">
                  {myTickets.map((ticket) => (
                    <div
                      key={ticket.id}
                      onClick={() => setSelectedTicket(ticket)}
                      className="p-3.5 rounded-xl border border-slate-800 bg-slate-950/60 hover:border-indigo-500/50 hover:bg-slate-900/60 transition-all cursor-pointer group"
                    >
                      <div className="flex items-center justify-between gap-2 mb-2">
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
                          <Badge
                            variant={
                              ticket.status === 'IN_PROGRESS'
                                ? 'healthy'
                                : ticket.status === 'ON_HOLD'
                                ? 'paused'
                                : 'neutral'
                            }
                            className="text-[10px] py-0 px-1.5"
                          >
                            {ticket.status}
                          </Badge>
                        </div>

                        <span className="text-xs text-indigo-400 group-hover:translate-x-0.5 transition-transform font-mono flex items-center gap-1">
                          Inspect <ArrowRight className="w-3.5 h-3.5" />
                        </span>
                      </div>

                      <h4 className="text-xs font-semibold text-slate-100 group-hover:text-indigo-300 transition-colors mb-1 line-clamp-1">
                        {ticket.title}
                      </h4>
                      <p className="text-[11px] text-slate-400 line-clamp-2 mb-3 font-sans">
                        {ticket.description}
                      </p>

                      {/* SLA Timer */}
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
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Unassigned Incoming Queue Pool */}
        <div className="space-y-4">
          <Card className="border-slate-800 bg-slate-900/40">
            <CardHeader className="border-b border-slate-800/80 pb-3 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Layers className="w-4 h-4 text-cyan-400" />
                  Incoming Queue (SKIP LOCKED Pool)
                </CardTitle>
                <CardDescription className="font-mono text-[11px]">
                  Unassigned tickets waiting for skill-based push or manual agent claim
                </CardDescription>
              </div>
              <Badge variant="neutral" className="text-[10px]">
                {unassignedTickets.length} AVAILABLE
              </Badge>
            </CardHeader>

            <CardContent className="pt-4">
              {unassignedTickets.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-500 font-mono">
                  No unassigned tickets in queue pool.
                </div>
              ) : (
                <div className="space-y-3">
                  {unassignedTickets.map((ticket) => (
                    <div
                      key={ticket.id}
                      className="p-3.5 rounded-xl border border-slate-800 bg-slate-950/60 flex flex-col justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-1.5">
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
                            <Badge variant="warning" className="text-[10px] py-0 px-1.5">
                              OPEN
                            </Badge>
                          </div>

                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={activeLoad >= maxCapacity}
                            onClick={() => handleClaimSpecific(ticket)}
                            className="text-xs font-mono"
                          >
                            Claim
                          </Button>
                        </div>

                        <h4 className="text-xs font-semibold text-slate-100 mb-1">
                          {ticket.title}
                        </h4>
                        <p className="text-[11px] text-slate-400 line-clamp-2">
                          {ticket.description}
                        </p>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-900 text-[10px] font-mono text-slate-500">
                        <div className="flex items-center gap-1">
                          <span>Skills:</span>
                          {ticket.requiredSkills.map((s) => (
                            <span
                              key={s}
                              className="px-1.5 py-0.2 rounded bg-slate-900 text-slate-300 border border-slate-800"
                            >
                              {s}
                            </span>
                          ))}
                        </div>

                        <span>Created {new Date(ticket.createdAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
