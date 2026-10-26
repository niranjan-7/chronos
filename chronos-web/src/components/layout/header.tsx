'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { ConnectionPill } from '../ui/connection-pill';
import { TenantSwitcher } from './tenant-switcher';
import { useTelemetryStore } from '../../stores/telemetry-store';
import { ShieldAlert } from 'lucide-react';
import { Badge } from '../ui/badge';

const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  '/war-room': {
    title: 'War-Room Telemetry',
    subtitle: 'Real-time multi-tenant SLA countdowns & breach mitigation stream',
  },
  '/workspace': {
    title: 'Agent Queue & Workspace',
    subtitle: 'Non-blocking atomic ticket claims (SKIP LOCKED) and lifecycle execution',
  },
  '/admin/calendars': {
    title: 'Business Calendars & Schedules',
    subtitle: 'Timezone-aware business hours, holidays, and active business-time SLA calculator',
  },
  '/admin/webhooks': {
    title: 'Enterprise Webhooks & Circuit Breakers',
    subtitle: 'HMAC-SHA256 signing, jittered exponential backoff, and DLQ replay inspection',
  },
};

export function Header() {
  const pathname = usePathname();
  const pageInfo = PAGE_TITLES[pathname] || {
    title: 'Mission Control',
    subtitle: 'Chronos Operational Command Center',
  };

  const { recentAlerts } = useTelemetryStore();
  const latestBreach = recentAlerts.find((a) => a.type === 'BREACH');

  return (
    <header className="h-16 border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md px-6 flex items-center justify-between z-20">
      {/* Route Title & Breadcrumb */}
      <div className="flex flex-col">
        <h1 className="text-sm font-semibold text-slate-100 tracking-tight flex items-center gap-2">
          {pageInfo.title}
          {latestBreach && (
            <Badge variant="breach" className="text-[10px] py-0 px-1.5 ml-2">
              <ShieldAlert className="w-3 h-3 mr-1" />
              BREACH DETECTED
            </Badge>
          )}
        </h1>
        <p className="text-[11px] text-slate-400 font-mono hidden md:block">
          {pageInfo.subtitle}
        </p>
      </div>

      {/* Right Actions: WebSocket Status & Persona Switcher */}
      <div className="flex items-center gap-4">
        {/* Live WebSocket Status Pill */}
        <ConnectionPill />

        {/* Tenant & Persona Switcher */}
        <TenantSwitcher />
      </div>
    </header>
  );
}
