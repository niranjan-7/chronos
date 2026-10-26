'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { DateTime } from 'luxon';
import { useTenantStore } from '../../../stores/tenant-store';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../../components/ui/card';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  Calendar as CalendarIcon,
  Clock,
  Globe,
  Plus,
  Trash2,
  Calculator,
  Save,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import {
  WeeklySchedule,
  HolidayDefinition,
  DEFAULT_WEEKLY_SCHEDULE,
  DayOfWeek,
  isCurrentlyInBusinessHours,
  calculateBusinessDeadlines,
} from '../../../lib/calendar-calculator';
import { apiClient } from '../../../lib/api-client';

const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'America/New_York (EST/EDT, UTC-5)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST, UTC+5:30)' },
  { value: 'Europe/London', label: 'Europe/London (GMT/BST, UTC+0)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PST/PDT, UTC-8)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (CET/CEST, UTC+1)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST, UTC+9)' },
  { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
];

const SLA_PRIORITY_PRESETS = [
  { key: 'P1', label: 'P1 - Critical (1 Hour SLA)', ms: 60 * 60 * 1000, priority: 'URGENT' },
  { key: 'P2', label: 'P2 - High (4 Hours SLA)', ms: 4 * 60 * 60 * 1000, priority: 'HIGH' },
  { key: 'P3', label: 'P3 - Medium (8 Hours SLA)', ms: 8 * 60 * 60 * 1000, priority: 'MEDIUM' },
  { key: 'P4', label: 'P4 - Low (24 Hours SLA)', ms: 24 * 60 * 60 * 1000, priority: 'LOW' },
];

const DAYS: { key: DayOfWeek; label: string }[] = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
];

export default function CalendarsPage() {
  const { activeTenant } = useTenantStore();

  const [timezone, setTimezone] = useState<string>('America/New_York');
  const [currentTimeLocal, setCurrentTimeLocal] = useState<string>('');
  const [schedule, setSchedule] = useState<WeeklySchedule>(DEFAULT_WEEKLY_SCHEDULE);
  const [holidays, setHolidays] = useState<HolidayDefinition[]>([
    { name: "New Year's Day", date: '2026-01-01', isFullDay: true },
    { name: 'Memorial Day', date: '2026-05-25', isFullDay: true },
    { name: 'Independence Day', date: '2026-07-04', isFullDay: true },
    { name: 'Labor Day', date: '2026-09-07', isFullDay: true },
    { name: 'Thanksgiving Day', date: '2026-11-26', isFullDay: true },
    { name: 'Christmas Day', date: '2026-12-25', isFullDay: true },
  ]);

  // Form states for adding a holiday
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayFullDay, setNewHolidayFullDay] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  // SLA Deadline Simulator States
  const [selectedPriority, setSelectedPriority] = useState<string>('P2');
  const [simulatedStartInput, setSimulatedStartInput] = useState<string>(() => {
    // Default to this Friday at 16:00 local time for interesting roll-over demo
    const now = DateTime.now().setZone('America/New_York');
    const friday = now.set({ weekday: 5, hour: 16, minute: 0, second: 0, millisecond: 0 });
    return friday.toFormat("yyyy-MM-dd'T'HH:mm");
  });

  // Ticking live clock in the selected timezone
  useEffect(() => {
    const updateTime = () => {
      const now = DateTime.now().setZone(timezone);
      setCurrentTimeLocal(now.toFormat('ccc, LLL dd, yyyy • HH:mm:ss'));
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, [timezone]);

  // Evaluate whether now is currently in business hours
  const businessStatus = useMemo(() => {
    const now = DateTime.now().setZone(timezone);
    return isCurrentlyInBusinessHours(now, schedule, holidays);
  }, [timezone, schedule, holidays]);

  // Handle schedule changes
  const handleToggleDay = (day: DayOfWeek) => {
    setSchedule((prev) => {
      const current = prev[day] || [];
      if (current.length > 0) {
        return { ...prev, [day]: [] };
      } else {
        return { ...prev, [day]: [{ start: '09:00', end: '17:00' }] };
      }
    });
  };

  const handleTimeChange = (day: DayOfWeek, field: 'start' | 'end', val: string) => {
    setSchedule((prev) => {
      const current = prev[day]?.[0] || { start: '09:00', end: '17:00' };
      const updated = { ...current, [field]: val };
      return { ...prev, [day]: [updated] };
    });
  };

  const applyPreset = (type: 'STANDARD' | '24X7' | 'EXTENDED') => {
    if (type === 'STANDARD') {
      setSchedule(DEFAULT_WEEKLY_SCHEDULE);
    } else if (type === '24X7') {
      setSchedule({
        monday: [{ start: '00:00', end: '24:00' }],
        tuesday: [{ start: '00:00', end: '24:00' }],
        wednesday: [{ start: '00:00', end: '24:00' }],
        thursday: [{ start: '00:00', end: '24:00' }],
        friday: [{ start: '00:00', end: '24:00' }],
        saturday: [{ start: '00:00', end: '24:00' }],
        sunday: [{ start: '00:00', end: '24:00' }],
      });
    } else if (type === 'EXTENDED') {
      setSchedule({
        monday: [{ start: '08:00', end: '20:00' }],
        tuesday: [{ start: '08:00', end: '20:00' }],
        wednesday: [{ start: '08:00', end: '20:00' }],
        thursday: [{ start: '08:00', end: '20:00' }],
        friday: [{ start: '08:00', end: '20:00' }],
        saturday: [{ start: '09:00', end: '18:00' }],
        sunday: [],
      });
    }
  };

  const handleAddHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newHolidayName || !newHolidayDate) return;

    const newH: HolidayDefinition = {
      name: newHolidayName,
      date: newHolidayDate,
      isFullDay: newHolidayFullDay,
    };

    setHolidays((prev) => [...prev, newH].sort((a, b) => a.date.localeCompare(b.date)));
    setNewHolidayName('');
    setNewHolidayDate('');

    // Persist to backend if tenant is active
    try {
      await apiClient.post(`/tenants/${activeTenant.id}/holidays`, {
        name: newH.name,
        date: newH.date,
        isFullDay: newH.isFullDay,
      });
    } catch {
      // Local state preserved
    }
  };

  const handleRemoveHoliday = (date: string) => {
    setHolidays((prev) => prev.filter((h) => h.date !== date));
  };

  const handleSaveCalendar = async () => {
    setIsSaving(true);
    setSaveFeedback(null);
    try {
      await apiClient.put(`/tenants/${activeTenant.id}/calendar`, {
        timezone,
        weeklySchedule: schedule,
      });
      setSaveFeedback('Calendar & timezone policy successfully saved to database!');
    } catch {
      setSaveFeedback('Calendar configuration saved locally.');
    } finally {
      setIsSaving(false);
      setTimeout(() => setSaveFeedback(null), 4000);
    }
  };

  // SLA Calculation Preview
  const deadlineCalculation = useMemo(() => {
    const priorityConfig =
      SLA_PRIORITY_PRESETS.find((p) => p.key === selectedPriority) || SLA_PRIORITY_PRESETS[1];
    const dt = DateTime.fromISO(simulatedStartInput, { zone: timezone });
    const startDate = dt.isValid ? dt.toJSDate() : new Date();

    return calculateBusinessDeadlines(
      startDate,
      priorityConfig.ms,
      schedule,
      holidays,
      timezone,
    );
  }, [selectedPriority, simulatedStartInput, schedule, holidays, timezone]);

  const setRollOverPreset = (scenario: 'FRIDAY_CLOSE' | 'MID_WEEK' | 'HOLIDAY_EVE') => {
    const now = DateTime.now().setZone(timezone);
    if (scenario === 'FRIDAY_CLOSE') {
      const friday = now.set({ weekday: 5, hour: 16, minute: 30, second: 0 });
      setSimulatedStartInput(friday.toFormat("yyyy-MM-dd'T'HH:mm"));
    } else if (scenario === 'MID_WEEK') {
      const wednesday = now.set({ weekday: 3, hour: 10, minute: 0, second: 0 });
      setSimulatedStartInput(wednesday.toFormat("yyyy-MM-dd'T'HH:mm"));
    } else if (scenario === 'HOLIDAY_EVE') {
      setSimulatedStartInput('2026-12-24T15:30');
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header Card: Timezone & Live Status */}
      <Card className="border-slate-800 bg-slate-900/60 backdrop-blur-md">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-indigo-950/80 border border-indigo-500/30 flex items-center justify-center shadow-lg shadow-indigo-950/50">
              <Globe className="w-6 h-6 text-indigo-400" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-bold text-slate-100">
                  Business Calendars & SLA Schedules
                </h1>
                {businessStatus.isInBusinessHours ? (
                  <Badge variant="healthy" className="px-2 py-0.5 text-xs font-semibold animate-pulse-glow">
                    ● IN BUSINESS HOURS
                  </Badge>
                ) : (
                  <Badge variant="cyan" className="px-2 py-0.5 text-xs font-semibold">
                    ❄ OUTSIDE BUSINESS HOURS (SLA FROZEN)
                  </Badge>
                )}
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Tenant: <span className="text-slate-200 font-semibold">{activeTenant.name}</span> • Status:{' '}
                <span className="text-slate-300">{businessStatus.reason}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            {/* Live Clock Display */}
            <div className="px-3.5 py-1.5 rounded-lg border border-slate-800 bg-slate-950/90 font-mono text-xs flex items-center gap-2 text-slate-200 shadow-inner">
              <Clock className="w-4 h-4 text-indigo-400 animate-spin-slow" />
              <span>{currentTimeLocal || 'Loading local clock...'}</span>
            </div>

            {/* IANA Timezone Select */}
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-900 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500 shadow-sm"
            >
              {TIMEZONE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <Button
              onClick={handleSaveCalendar}
              disabled={isSaving}
              className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-2 flex items-center gap-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              {isSaving ? 'Saving...' : 'Save Policy'}
            </Button>
          </div>
        </div>

        {saveFeedback && (
          <div className="mt-3 p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{saveFeedback}</span>
          </div>
        )}
      </Card>

      {/* Main Grid: Weekly Schedule + Holiday Calendar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column (2 Cols): 7-Day Visual Weekly Matrix */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-slate-800 bg-slate-900/40">
            <CardHeader className="border-b border-slate-800/80 pb-3 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-sm font-semibold flex items-center gap-2 text-slate-100">
                  <CalendarIcon className="w-4 h-4 text-indigo-400" />
                  7-Day Weekly Operating Schedule
                </CardTitle>
                <CardDescription className="text-xs text-slate-400">
                  Define daily shift hours. SLAs freeze automatically when outside active shift windows.
                </CardDescription>
              </div>

              {/* Schedule Presets */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => applyPreset('STANDARD')}
                  className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-mono border border-slate-700 transition"
                >
                  Standard 9-5
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset('EXTENDED')}
                  className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-mono border border-slate-700 transition"
                >
                  Extended 8-8
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset('24X7')}
                  className="px-2 py-1 rounded bg-indigo-950 hover:bg-indigo-900 text-indigo-300 text-[10px] font-mono border border-indigo-700/50 transition"
                >
                  24/7 Always-On
                </button>
              </div>
            </CardHeader>

            <CardContent className="pt-4 space-y-2.5">
              {DAYS.map(({ key, label }) => {
                const interval = schedule[key]?.[0];
                const isActive = Boolean(interval);

                // Compute day hours
                let dailyHours = '0.0h';
                if (isActive && interval) {
                  const [sH, sM] = interval.start.split(':').map(Number);
                  const [eH, eM] = interval.end.split(':').map(Number);
                  const total = (eH * 60 + eM - (sH * 60 + sM)) / 60;
                  dailyHours = `${Math.max(0, total).toFixed(1)}h`;
                }

                return (
                  <div
                    key={key}
                    className={`p-3 rounded-lg border transition flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                      isActive
                        ? 'border-slate-800 bg-slate-950/60'
                        : 'border-slate-800/40 bg-slate-950/20 opacity-60'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={isActive}
                        onChange={() => handleToggleDay(key)}
                        id={`toggle-${key}`}
                        className="w-4 h-4 rounded border-slate-700 bg-slate-900 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                      />
                      <label htmlFor={`toggle-${key}`} className="text-xs font-semibold text-slate-200 cursor-pointer">
                        {label}
                      </label>
                      <Badge
                        variant={isActive ? 'healthy' : 'outline'}
                        className="text-[10px] py-0 px-1.5"
                      >
                        {isActive ? 'OPEN' : 'CLOSED'}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-2">
                      {isActive && interval ? (
                        <div className="flex items-center gap-2 font-mono text-xs">
                          <input
                            type="time"
                            value={interval.start}
                            onChange={(e) => handleTimeChange(key, 'start', e.target.value)}
                            className="px-2 py-1 rounded border border-slate-700 bg-slate-900 text-slate-100 text-xs focus:outline-none focus:border-indigo-500"
                          />
                          <span className="text-slate-500">to</span>
                          <input
                            type="time"
                            value={interval.end}
                            onChange={(e) => handleTimeChange(key, 'end', e.target.value)}
                            className="px-2 py-1 rounded border border-slate-700 bg-slate-900 text-slate-100 text-xs focus:outline-none focus:border-indigo-500"
                          />
                          <span className="text-indigo-400 font-semibold ml-2 w-10 text-right">
                            {dailyHours}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs font-mono text-slate-500 italic">
                          Weekend / Frozen Schedule (0.0h)
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Tenant Holiday Calendar */}
        <div className="space-y-6">
          <Card className="border-slate-800 bg-slate-900/40">
            <CardHeader className="border-b border-slate-800/80 pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2 text-slate-100">
                <CalendarIcon className="w-4 h-4 text-rose-400" />
                Tenant Holiday Calendar
              </CardTitle>
              <CardDescription className="text-xs text-slate-400">
                Dates when active SLA countdown timers are completely frozen.
              </CardDescription>
            </CardHeader>

            <CardContent className="pt-4 space-y-4">
              {/* Add Holiday Form */}
              <form onSubmit={handleAddHoliday} className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-2.5">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                  Add Holiday Date
                </span>
                <input
                  type="text"
                  placeholder="Holiday Name (e.g., Labor Day)"
                  value={newHolidayName}
                  onChange={(e) => setNewHolidayName(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded border border-slate-800 bg-slate-900 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                />
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={newHolidayDate}
                    onChange={(e) => setNewHolidayDate(e.target.value)}
                    className="flex-1 px-2.5 py-1.5 rounded border border-slate-800 bg-slate-900 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                  <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newHolidayFullDay}
                      onChange={(e) => setNewHolidayFullDay(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-900 text-rose-500"
                    />
                    Full Day
                  </label>
                  <Button
                    type="submit"
                    className="bg-rose-600/80 hover:bg-rose-600 text-white text-xs px-2.5 py-1.5 flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add
                  </Button>
                </div>
              </form>

              {/* Holiday List */}
              <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                {holidays.map((holiday) => (
                  <div
                    key={holiday.date}
                    className="p-2.5 rounded-lg border border-slate-800/80 bg-slate-950/60 flex items-center justify-between text-xs font-mono"
                  >
                    <div>
                      <p className="font-semibold text-slate-200">{holiday.name}</p>
                      <p className="text-[11px] text-slate-400">{holiday.date}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="rose" className="text-[10px] py-0 px-1.5">
                        {holiday.isFullDay ? 'FULL DAY' : 'PARTIAL'}
                      </Badge>
                      <button
                        type="button"
                        onClick={() => handleRemoveHoliday(holiday.date)}
                        className="text-slate-500 hover:text-rose-400 transition p-1"
                        title="Remove holiday"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* SLA Deadline Calculator Preview Card */}
      <Card className="border-indigo-500/30 bg-gradient-to-r from-indigo-950/20 via-slate-900/50 to-slate-900/30">
        <CardHeader className="border-b border-slate-800/80 pb-3 flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-indigo-300">
              <Calculator className="w-4 h-4 text-indigo-400" />
              SLA Deadline Calculator Preview
            </CardTitle>
            <CardDescription className="text-xs text-slate-400">
              Interactive deterministic calculation simulator showing exact Warning (80%) and Breach (100%) timestamps across weekends & holidays.
            </CardDescription>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-slate-400 uppercase">Preset Scenarios:</span>
            <button
              type="button"
              onClick={() => setRollOverPreset('FRIDAY_CLOSE')}
              className="px-2 py-0.5 rounded bg-indigo-950 border border-indigo-700/60 text-indigo-300 text-[11px] font-mono hover:bg-indigo-900"
            >
              Friday 16:30 Roll-Over
            </button>
            <button
              type="button"
              onClick={() => setRollOverPreset('HOLIDAY_EVE')}
              className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-[11px] font-mono hover:bg-slate-700"
            >
              Christmas Eve
            </button>
            <button
              type="button"
              onClick={() => setRollOverPreset('MID_WEEK')}
              className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-[11px] font-mono hover:bg-slate-700"
            >
              Normal Wed 10:00
            </button>
          </div>
        </CardHeader>

        <CardContent className="pt-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Input 1: Priority Selection */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                SLA Priority Policy:
              </label>
              <div className="grid grid-cols-2 gap-2">
                {SLA_PRIORITY_PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setSelectedPriority(p.key)}
                    className={`p-2.5 rounded-lg border text-left transition ${
                      selectedPriority === p.key
                        ? 'border-indigo-500 bg-indigo-950/60 text-slate-100 font-semibold'
                        : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span className="text-xs font-bold block">{p.key}</span>
                    <span className="text-[10px] text-slate-400 font-mono">{p.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Input 2: Ticket Creation Timestamp */}
            <div>
              <label className="text-xs font-semibold text-slate-300 block mb-1.5">
                Simulated Ticket Arrival Timestamp ({timezone}):
              </label>
              <input
                type="datetime-local"
                value={simulatedStartInput}
                onChange={(e) => setSimulatedStartInput(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-800 bg-slate-950 text-xs font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] font-mono text-slate-500 mt-1">
                Selected: {DateTime.fromISO(simulatedStartInput).toFormat('cccc, LLLL dd, yyyy HH:mm')}
              </p>
            </div>
          </div>

          {/* Output: Warning & Breach Visual Timeline Matrix */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 font-mono text-xs pt-2">
            {/* Card 1: Ticket Arrival */}
            <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/80 space-y-1">
              <span className="text-slate-400 uppercase text-[10px] font-bold block">1. Arrival Time</span>
              <p className="text-slate-100 font-semibold">
                {DateTime.fromISO(simulatedStartInput).toFormat('ccc, LLL dd HH:mm')}
              </p>
              <span className="text-slate-500 text-[11px] block">
                Timezone: {timezone}
              </span>
            </div>

            {/* Card 2: 80% SLA Warning Target */}
            <div className="p-3 rounded-lg border border-amber-500/40 bg-amber-950/20 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-amber-400 uppercase text-[10px] font-bold">2. Warning (80% SLA)</span>
                <Badge variant="warning" className="text-[10px] py-0 px-1">
                  80% TARGET
                </Badge>
              </div>
              <p className="text-amber-200 font-semibold">
                {deadlineCalculation.warningDateLocalFormatted}
              </p>
              <span className="text-amber-400/70 text-[11px] block">
                {deadlineCalculation.warningDateUtcFormatted}
              </span>
            </div>

            {/* Card 3: 100% SLA Breach Deadline */}
            <div className="p-3 rounded-lg border border-rose-500/40 bg-rose-950/20 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-rose-400 uppercase text-[10px] font-bold">3. Breach (100% Limit)</span>
                <Badge variant="rose" className="text-[10px] py-0 px-1">
                  100% LIMIT
                </Badge>
              </div>
              <p className="text-rose-200 font-semibold">
                {deadlineCalculation.breachDateLocalFormatted}
              </p>
              <span className="text-rose-400/70 text-[11px] block">
                {deadlineCalculation.breachDateUtcFormatted}
              </span>
            </div>
          </div>

          {/* Explanation Banner */}
          <div className="p-3 rounded-lg border border-indigo-500/20 bg-indigo-950/30 text-xs font-mono text-indigo-300 space-y-1">
            <span className="text-[10px] uppercase font-bold text-indigo-400 tracking-wider flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-indigo-400" />
              SLA Roll-Over Arithmetic Trace:
            </span>
            {deadlineCalculation.explanation.map((item, idx) => (
              <p key={idx} className="text-slate-300 text-[11px]">
                • {item}
              </p>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
