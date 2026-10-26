import { Injectable, Logger } from '@nestjs/common';
import { DateTime } from 'luxon';

export interface TimeInterval {
  start: string; // HH:mm (24-hour format)
  end: string;   // HH:mm (24-hour format)
}

export type WeeklySchedule = Record<
  'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
  TimeInterval[]
>;

export interface CalendarDefinition {
  timezone: string;
  weeklySchedule: WeeklySchedule;
  is24x7?: boolean;
}

export interface HolidayDefinition {
  date: string; // YYYY-MM-DD in tenant local timezone
  isFullDay: boolean;
  startTime?: string | null; // HH:mm
  endTime?: string | null;   // HH:mm
}

export interface SlaDeadlines {
  warningDate: Date;
  breachDate: Date;
  warningDelayMs: number;
  breachDelayMs: number;
  businessDurationMs: number;
}

export const DEFAULT_WEEKLY_SCHEDULE: WeeklySchedule = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [],
  sunday: [],
};

@Injectable()
export class SlaCalendarCalculatorService {
  private readonly logger = new Logger(SlaCalendarCalculatorService.name);

  /**
   * Calculates the exact wall-clock UTC dates for 80% (Warning) and 100% (Breach) deadlines,
   * counting ONLY active business hours in the tenant's IANA timezone and skipping holidays/weekends.
   */
  calculateDeadlines(
    startTimestamp: Date,
    slaTargetMs: number,
    calendar: CalendarDefinition,
    holidays: HolidayDefinition[] = [],
  ): SlaDeadlines {
    if (slaTargetMs <= 0) {
      return {
        warningDate: startTimestamp,
        breachDate: startTimestamp,
        warningDelayMs: 0,
        breachDelayMs: 0,
        businessDurationMs: 0,
      };
    }

    // 24x7 bypass: calendar runs continuously without business-hour restrictions
    if (calendar.is24x7) {
      const now = Date.now();
      const breachTime = startTimestamp.getTime() + slaTargetMs;
      const warningTime = startTimestamp.getTime() + Math.round(slaTargetMs * 0.8);

      return {
        warningDate: new Date(warningTime),
        breachDate: new Date(breachTime),
        warningDelayMs: Math.max(0, warningTime - now),
        breachDelayMs: Math.max(0, breachTime - now),
        businessDurationMs: slaTargetMs,
      };
    }

    const warningTargetMs = Math.round(slaTargetMs * 0.8);

    const warningDateTime = this.addBusinessMilliseconds(
      startTimestamp,
      warningTargetMs,
      calendar,
      holidays,
    );

    const breachDateTime = this.addBusinessMilliseconds(
      startTimestamp,
      slaTargetMs,
      calendar,
      holidays,
    );

    const now = Date.now();
    const warningDate = warningDateTime.toJSDate();
    const breachDate = breachDateTime.toJSDate();

    return {
      warningDate,
      breachDate,
      warningDelayMs: Math.max(0, warningDate.getTime() - now),
      breachDelayMs: Math.max(0, breachDate.getTime() - now),
      businessDurationMs: slaTargetMs,
    };
  }

  /**
   * Pure deterministic algorithm advancing through local calendar days and intervals,
   * returning the exact Luxon DateTime when `businessMsToAdd` active milliseconds elapse.
   */
  addBusinessMilliseconds(
    start: Date,
    businessMsToAdd: number,
    calendar: CalendarDefinition,
    holidays: HolidayDefinition[] = [],
  ): DateTime {
    const tz = calendar.timezone || 'UTC';
    let current = DateTime.fromJSDate(start, { zone: tz });
    let remainingMs = businessMsToAdd;

    const holidayMap = new Map<string, HolidayDefinition[]>();
    for (const h of holidays) {
      const list = holidayMap.get(h.date) || [];
      list.push(h);
      holidayMap.set(h.date, list);
    }

    let loopGuard = 0;
    const maxDays = 365 * 2; // Guard against infinite loop

    while (remainingMs > 0 && loopGuard++ < maxDays) {
      const dateStr = current.toISODate();
      const dayHolidays = dateStr ? holidayMap.get(dateStr) : undefined;
      const isFullDayHoliday = dayHolidays?.some((h) => h.isFullDay);

      if (isFullDayHoliday) {
        // Skip full-day holiday
        current = current.plus({ days: 1 }).startOf('day');
        continue;
      }

      const weekdayName = current.toFormat('cccc').toLowerCase() as keyof WeeklySchedule;
      const intervals = calendar.weeklySchedule[weekdayName] || [];

      if (intervals.length === 0) {
        // Closed weekend or non-working day
        current = current.plus({ days: 1 }).startOf('day');
        continue;
      }

      for (const interval of intervals) {
        if (remainingMs <= 0) break;

        const [startH, startM] = interval.start.split(':').map(Number);
        const [endH, endM] = interval.end.split(':').map(Number);

        const intervalStart = current.set({
          hour: startH,
          minute: startM,
          second: 0,
          millisecond: 0,
        });

        const intervalEnd = current.set({
          hour: endH,
          minute: endM,
          second: 0,
          millisecond: 0,
        });

        // Skip if window has already closed today
        if (current >= intervalEnd) {
          continue;
        }

        // Active start for this segment is max(current, intervalStart)
        const effectiveStart = current > intervalStart ? current : intervalStart;

        // Check for partial-day holiday clipping
        let effectiveEnd = intervalEnd;
        if (dayHolidays && dayHolidays.length > 0) {
          for (const ph of dayHolidays) {
            if (!ph.isFullDay && ph.startTime && ph.endTime) {
              const [pHolStartH, pHolStartM] = ph.startTime.split(':').map(Number);
              const holidayStart = current.set({
                hour: pHolStartH,
                minute: pHolStartM,
                second: 0,
                millisecond: 0,
              });
              if (effectiveStart < holidayStart && holidayStart < effectiveEnd) {
                effectiveEnd = holidayStart;
              }
            }
          }
        }

        if (effectiveStart >= effectiveEnd) {
          continue;
        }

        const availableMsInWindow = effectiveEnd.diff(effectiveStart).as('milliseconds');

        if (remainingMs <= availableMsInWindow) {
          current = effectiveStart.plus({ milliseconds: remainingMs });
          remainingMs = 0;
          break;
        } else {
          remainingMs -= availableMsInWindow;
          current = effectiveEnd;
        }
      }

      if (remainingMs > 0) {
        current = current.plus({ days: 1 }).startOf('day');
      }
    }

    return current;
  }

  /**
   * Computes the exact active business milliseconds that elapsed between fromDate and toDate.
   * Excludes closed hours, weekends, and holidays.
   */
  calculateElapsedBusinessMs(
    fromDate: Date,
    toDate: Date,
    calendar: CalendarDefinition,
    holidays: HolidayDefinition[] = [],
  ): number {
    if (!fromDate || !toDate || toDate <= fromDate) return 0;

    if (calendar.is24x7) {
      return toDate.getTime() - fromDate.getTime();
    }

    const tz = calendar.timezone || 'UTC';
    let current = DateTime.fromJSDate(fromDate, { zone: tz });
    const targetEnd = DateTime.fromJSDate(toDate, { zone: tz });

    const holidayMap = new Map<string, HolidayDefinition[]>();
    for (const h of holidays) {
      const list = holidayMap.get(h.date) || [];
      list.push(h);
      holidayMap.set(h.date, list);
    }

    let elapsedMs = 0;
    let loopGuard = 0;
    const maxDays = 365 * 2;

    while (current < targetEnd && loopGuard++ < maxDays) {
      const dateStr = current.toISODate();
      const dayHolidays = dateStr ? holidayMap.get(dateStr) : undefined;
      const isFullDayHoliday = dayHolidays?.some((h) => h.isFullDay);

      if (isFullDayHoliday) {
        current = current.plus({ days: 1 }).startOf('day');
        continue;
      }

      const weekdayName = current.toFormat('cccc').toLowerCase() as keyof WeeklySchedule;
      const intervals = calendar.weeklySchedule[weekdayName] || [];

      if (intervals.length === 0) {
        current = current.plus({ days: 1 }).startOf('day');
        continue;
      }

      for (const interval of intervals) {
        if (current >= targetEnd) break;

        const [startH, startM] = interval.start.split(':').map(Number);
        const [endH, endM] = interval.end.split(':').map(Number);

        const intervalStart = current.set({
          hour: startH,
          minute: startM,
          second: 0,
          millisecond: 0,
        });

        const intervalEnd = current.set({
          hour: endH,
          minute: endM,
          second: 0,
          millisecond: 0,
        });

        if (current >= intervalEnd) continue;

        const segStart = current > intervalStart ? current : intervalStart;
        const segEnd = targetEnd < intervalEnd ? targetEnd : intervalEnd;

        if (segStart < segEnd) {
          elapsedMs += segEnd.diff(segStart).as('milliseconds');
          current = segEnd;
        }
      }

      if (current < targetEnd) {
        current = current.plus({ days: 1 }).startOf('day');
      }
    }

    return Math.round(elapsedMs);
  }
}
