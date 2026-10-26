'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Layers,
  Calendar,
  Webhook,
  Zap,
  Clock,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTenantStore } from '../../stores/tenant-store';
import { Badge } from '../ui/badge';

const NAVIGATION_ROUTES = [
  {
    name: 'War-Room Telemetry',
    href: '/war-room',
    icon: Activity,
    badge: 'LIVE',
    badgeVariant: 'healthy' as const,
    description: 'Operational SLA count & alert stream',
  },
  {
    name: 'Agent Workspace',
    href: '/workspace',
    icon: Layers,
    description: 'SKIP LOCKED claiming & ticket lifecycle',
  },
  {
    name: 'Business Calendars',
    href: '/admin/calendars',
    icon: Calendar,
    description: 'Timezone schedules & holiday exclusions',
  },
  {
    name: 'Enterprise Webhooks',
    href: '/admin/webhooks',
    icon: Webhook,
    description: 'Circuit breakers, HMAC & DLQ replay',
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { activePersona } = useTenantStore();

  return (
    <aside className="w-64 border-r border-slate-800/80 bg-slate-950 flex flex-col shrink-0 select-none">
      {/* Brand & Chronos v2.0 Indicator */}
      <div className="h-16 border-b border-slate-800/80 px-5 flex items-center justify-between">
        <Link href="/war-room" className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-cyan-400 p-[1px] shadow-[0_0_15px_rgba(99,102,241,0.3)]">
            <div className="w-full h-full bg-slate-950 rounded-[7px] flex items-center justify-center">
              <Clock className="w-4 h-4 text-cyan-400 group-hover:scale-110 transition-transform duration-200" />
            </div>
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-bold tracking-wider text-slate-100 flex items-center gap-1.5 font-mono">
              CHRONOS
              <span className="text-[10px] text-cyan-400 bg-cyan-950/60 border border-cyan-800/50 px-1 py-0.2 rounded font-mono">
                v2.0
              </span>
            </span>
            <span className="text-[10px] text-slate-400 font-mono tracking-tight">
              SLA Orchestration Engine
            </span>
          </div>
        </Link>
      </div>

      {/* Navigation Routes */}
      <div className="flex-1 py-4 px-3 space-y-1">
        <div className="px-3 pb-2 text-[10px] font-mono uppercase tracking-widest text-slate-500 font-semibold">
          Mission Control
        </div>

        {NAVIGATION_ROUTES.map((route) => {
          const isActive = pathname === route.href || (route.href !== '/' && pathname.startsWith(route.href));
          const Icon = route.icon;

          return (
            <Link
              key={route.href}
              href={route.href}
              className={cn(
                'group relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-all duration-150',
                isActive
                  ? 'bg-slate-900/90 text-white border border-slate-800/90 shadow-sm'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/40 border border-transparent',
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-r bg-gradient-to-b from-indigo-400 to-cyan-400" />
              )}
              <Icon
                className={cn(
                  'w-4 h-4 transition-colors',
                  isActive ? 'text-cyan-400' : 'text-slate-500 group-hover:text-slate-300',
                )}
              />
              <div className="flex flex-col flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="truncate">{route.name}</span>
                  {route.badge && (
                    <Badge variant={route.badgeVariant} className="text-[9px] py-0 px-1.5 ml-1">
                      {route.badge}
                    </Badge>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Engine Status / Architecture Indicator */}
      <div className="p-3 mx-3 mb-3 rounded-lg border border-slate-800/80 bg-slate-900/40">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            Engine Core
          </span>
          <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Healthy
          </span>
        </div>
        <p className="text-[10px] text-slate-400 leading-relaxed font-mono">
          Outbox Relay • Lua Claims • Redis 250ms Telemetry
        </p>
      </div>

      {/* Active Persona Footer */}
      <div className="border-t border-slate-800/80 p-3 bg-slate-950/60 flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-slate-700 to-slate-800 border border-slate-700 flex items-center justify-center text-xs font-semibold text-slate-200 font-mono">
          {activePersona.avatar || activePersona.name.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-xs font-medium text-slate-200 truncate">
            {activePersona.name}
          </span>
          <span className="text-[10px] text-slate-400 font-mono truncate">
            {activePersona.role}
          </span>
        </div>
      </div>
    </aside>
  );
}
