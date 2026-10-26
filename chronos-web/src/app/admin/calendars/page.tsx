'use client';

import React, { useState } from 'react';
import { useTenantStore } from '../../../stores/tenant-store';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Calendar as CalendarIcon,
  Clock,
  Globe,
  Plus,
  Calculator,
} from 'lucide-react';

export default function CalendarsPage() {
  const { activeTenant } = useTenantStore();

  const [timezone, setTimezone] = useState('America/New_York');

  const weeklySchedule = [
    { day: 'Monday', hours: '09:00 - 17:00', active: true, duration: '8.0h' },
    { day: 'Tuesday', hours: '09:00 - 17:00', active: true, duration: '8.0h' },
    { day: 'Wednesday', hours: '09:00 - 17:00', active: true, duration: '8.0h' },
    { day: 'Thursday', hours: '09:00 - 17:00', active: true, duration: '8.0h' },
    { day: 'Friday', hours: '09:00 - 17:00', active: true, duration: '8.0h' },
    { day: 'Saturday', hours: 'Weekend (Closed)', active: false, duration: '0.0h' },
    { day: 'Sunday', hours: 'Weekend (Closed)', active: false, duration: '0.0h' },
  ];

  const holidays = [
    { name: "New Year's Day", date: '2026-01-01', type: 'FULL_DAY' },
    { name: 'Memorial Day', date: '2026-05-25', type: 'FULL_DAY' },
    { name: 'Independence Day', date: '2026-07-04', type: 'FULL_DAY' },
    { name: 'Thanksgiving Day', date: '2026-11-26', type: 'FULL_DAY' },
    { name: 'Christmas Day', date: '2026-12-25', type: 'FULL_DAY' },
  ];

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <Card className="border-slate-800 bg-slate-900/40">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-950/80 border border-indigo-500/30 flex items-center justify-center">
              <Globe className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                Timezone-Aware SLA Business Schedule
                <Badge variant="healthy" className="text-[10px] py-0 px-1.5">
                  ACTIVE
                </Badge>
              </h2>
              <p className="text-xs text-slate-400 font-mono">
                Tenant: {activeTenant.name} • Timezone: <span className="text-indigo-300">{timezone}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="America/New_York">America/New_York (UTC-5)</option>
              <option value="Asia/Kolkata">Asia/Kolkata (UTC+5:30)</option>
              <option value="Europe/London">Europe/London (UTC+0)</option>
              <option value="America/Los_Angeles">America/Los_Angeles (UTC-8)</option>
            </select>
          </div>
        </div>
      </Card>

      {/* SLA Calendar Calculation Algorithm Visualizer */}
      <Card className="border-indigo-500/30 bg-gradient-to-r from-indigo-950/20 via-slate-900/40 to-slate-900/20">
        <CardHeader className="border-b border-slate-800/80 pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Calculator className="w-4 h-4 text-indigo-400" />
            Business-Time SLA Roll-Over Simulation
          </CardTitle>
          <CardDescription className="font-mono text-[11px]">
            Wall-clock timestamps count active business milliseconds only, skipping nights, weekends, and holidays.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
            <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/80">
              <span className="text-slate-400 uppercase text-[10px] font-bold">1. Ticket Arrives</span>
              <p className="text-slate-100 font-semibold mt-1">Friday @ 15:00 ({timezone})</p>
              <span className="text-slate-500 text-[11px]">2 hours remaining before close (17:00)</span>
            </div>

            <div className="p-3 rounded-lg border border-indigo-500/30 bg-indigo-950/20">
              <span className="text-indigo-400 uppercase text-[10px] font-bold">2. SLA Target</span>
              <p className="text-indigo-200 font-semibold mt-1">4.0 Hours (14,400,000ms)</p>
              <span className="text-indigo-400/70 text-[11px]">2h used Friday • 2h roll over</span>
            </div>

            <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-950/20">
              <span className="text-emerald-400 uppercase text-[10px] font-bold">3. Exact Breach Deadline</span>
              <p className="text-emerald-200 font-semibold mt-1">Monday @ 11:00 ({timezone})</p>
              <span className="text-emerald-400/70 text-[11px]">Weekend & night excluded</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Weekly Schedule & Holidays Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Weekly Hours */}
        <Card className="border-slate-800 bg-slate-900/40">
          <CardHeader className="border-b border-slate-800/80 pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Clock className="w-4 h-4 text-cyan-400" />
              Weekly Operating Schedule
            </CardTitle>
            <CardDescription className="font-mono text-[11px]">
              Active business milliseconds counted for SLA targets
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4 space-y-2">
            {weeklySchedule.map((item) => (
              <div
                key={item.day}
                className="flex items-center justify-between p-2.5 rounded-lg border border-slate-800/80 bg-slate-900/60 text-xs font-mono"
              >
                <span className="text-slate-200 font-medium">{item.day}</span>
                <div className="flex items-center gap-3">
                  <span className={item.active ? 'text-slate-300' : 'text-slate-500'}>
                    {item.hours}
                  </span>
                  <Badge variant={item.active ? 'healthy' : 'neutral'} className="text-[10px] py-0 px-1.5">
                    {item.duration}
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Holiday Exclusions */}
        <Card className="border-slate-800 bg-slate-900/40">
          <CardHeader className="border-b border-slate-800/80 pb-3 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <CalendarIcon className="w-4 h-4 text-amber-400" />
                Tenant Holiday Exclusions
              </CardTitle>
              <CardDescription className="font-mono text-[11px]">
                Full and partial day exclusions freezing SLA timers
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" className="text-xs font-mono">
              <Plus className="w-3.5 h-3.5 mr-1" />
              Add Holiday
            </Button>
          </CardHeader>
          <CardContent className="pt-4 space-y-2">
            {holidays.map((h) => (
              <div
                key={h.date}
                className="flex items-center justify-between p-2.5 rounded-lg border border-slate-800/80 bg-slate-900/60 text-xs font-mono"
              >
                <div className="flex flex-col">
                  <span className="text-slate-200 font-medium">{h.name}</span>
                  <span className="text-slate-500 text-[11px]">{h.date}</span>
                </div>
                <Badge variant="paused" className="text-[10px] py-0 px-1.5">
                  FROZEN (ALL DAY)
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
