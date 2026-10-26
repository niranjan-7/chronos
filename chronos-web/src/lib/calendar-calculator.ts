import { DateTime } from 'luxon';

export interface TimeInterval {
  start: string; // HH:mm (24-hour format)
  end: string;   // HH:mm (24-hour format)
}

export type DayOfWeek = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export type WeeklySchedule = Record<DayOfWeek, TimeInterval[]>;

export interface HolidayDefinition {
  name: string;
  date: string; // YYYY-MM-DD in tenant local timezone
  isFullDay: boolean;
  startTime?: string | null; // HH:mm
  endTime?: string | null;   // HH:mm
}

export interface CalculatedDeadlines {
  warningDate: Date;
  breachDate: Date;
  warningDateLocalFormatted: string;
  breachDateLocalFormatted: string;
  warningDateUtcFormatted: string;
  breachDateUtcFormatted: string;
  businessTargetMs: number;
  totalWallClockMs: number;
  explanation: string[];
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

const DAY_MAP: Record<number, DayOfWeek> = {
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday',
  7: 'sunday',
};

/**
 * Checks if a specific Luxon DateTime is inside active business operating hours.
 */
export function isCurrentlyInBusinessHours(
  dt: DateTime,
  weeklySchedule: WeeklySchedule,
  holidays: HolidayDefinition[] = [],
): { isInBusinessHours: boolean; reason: string } {
  const localDateStr = dt.toFormat('yyyy-MM-dd');

  // Check full-day holidays
  const fullDayHoliday = holidays.find(
    (h) => h.date === localDateStr && h.isFullDay,
  );
  if (fullDayHoliday) {
    return {
      isInBusinessHours: false,
      reason: `Tenant Holiday: ${fullDayHoliday.name}`,
    };
  }

  const dayOfWeek = DAY_MAP[dt.weekday];
  const intervals = weeklySchedule[dayOfWeek] || [];

  if (intervals.length === 0) {
    return {
      isInBusinessHours: false,
      reason: `Weekend / Closed (${dt.weekdayLong})`,
    };
  }

  const currentMinutes = dt.hour * 60 + dt.minute;

  for (const interval of intervals) {
    const [startH, startM] = interval.start.split(':').map(Number);
    const [endH, endM] = interval.end.split(':').map(Number);
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    if (currentMinutes >= startMin && currentMinutes < endMin) {
      // Check partial day holiday conflict
      const partialHoliday = holidays.find(
        (h) => h.date === localDateStr && !h.isFullDay,
      );
      if (partialHoliday && partialHoliday.startTime && partialHoliday.endTime) {
        const [pHStartH, pHStartM] = partialHoliday.startTime.split(':').map(Number);
        const [pHEndH, pHEndM] = partialHoliday.endTime.split(':').map(Number);
        const pHStartMin = pHStartH * 60 + pHStartM;
        const pHEndMin = pHEndH * 60 + pHEndM;

        if (currentMinutes >= pHStartMin && currentMinutes < pHEndMin) {
          return {
            isInBusinessHours: false,
            reason: `Partial Holiday: ${partialHoliday.name}`,
          };
        }
      }

      return {
        isInBusinessHours: true,
        reason: `Active Business Hours (${interval.start} - ${interval.end})`,
      };
    }
  }

  return {
    isInBusinessHours: false,
    reason: `Outside Daily Shift Hours (${intervals.map((i) => `${i.start}-${i.end}`).join(', ')})`,
  };
}

/**
 * Pure, deterministic algorithm computing warning and breach timestamps taking
 * working shifts, weekends, and holiday calendars into account.
 */
export function calculateBusinessDeadlines(
  startTimestamp: Date,
  slaTargetMs: number,
  weeklySchedule: WeeklySchedule,
  holidays: HolidayDefinition[],
  timezone: string,
): CalculatedDeadlines {
  const explanation: string[] = [];
  const startDt = DateTime.fromJSDate(startTimestamp, { zone: timezone });

  explanation.push(`Ticket arrives at ${startDt.toFormat('ccc, LLL dd, yyyy HH:mm:ss')} (${timezone})`);

  const warningTargetMs = Math.round(slaTargetMs * 0.8);

  const warningDt = addBusinessMilliseconds(
    startDt,
    warningTargetMs,
    weeklySchedule,
    holidays,
  );

  const breachDt = addBusinessMilliseconds(
    startDt,
    slaTargetMs,
    weeklySchedule,
    holidays,
  );

  const totalWallClockMs = breachDt.toMillis() - startDt.toMillis();
  const wallClockHours = (totalWallClockMs / 3600000).toFixed(1);
  const businessHours = (slaTargetMs / 3600000).toFixed(1);

  if (totalWallClockMs > slaTargetMs) {
    const frozenHours = ((totalWallClockMs - slaTargetMs) / 3600000).toFixed(1);
    explanation.push(
      `SLA spans across non-business intervals: ${businessHours}h business target expands to ${wallClockHours}h wall-clock time (${frozenHours}h frozen overnight/weekend/holiday).`,
    );
  } else {
    explanation.push(`Target completes entirely within active business shift (${businessHours}h).`);
  }

  return {
    warningDate: warningDt.toJSDate(),
    breachDate: breachDt.toJSDate(),
    warningDateLocalFormatted: warningDt.toFormat('ccc, LLL dd, yyyy HH:mm:ss'),
    breachDateLocalFormatted: breachDt.toFormat('ccc, LLL dd, yyyy HH:mm:ss'),
    warningDateUtcFormatted: warningDt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss') + ' UTC',
    breachDateUtcFormatted: breachDt.toUTC().toFormat('yyyy-MM-dd HH:mm:ss') + ' UTC',
    businessTargetMs: slaTargetMs,
    totalWallClockMs,
    explanation,
  };
}

function addBusinessMilliseconds(
  startDt: DateTime,
  targetMs: number,
  schedule: WeeklySchedule,
  holidays: HolidayDefinition[],
): DateTime {
  let remainingMs = targetMs;
  let cursor = startDt;
  let safetyLoops = 0;
  const MAX_LOOPS = 500; // prevent infinite loops on empty calendars

  while (remainingMs > 0 && safetyLoops++ < MAX_LOOPS) {
    const dayKey = DAY_MAP[cursor.weekday];
    const intervals = schedule[dayKey] || [];
    const dateStr = cursor.toFormat('yyyy-MM-dd');

    const isFullHoliday = holidays.some((h) => h.date === dateStr && h.isFullDay);

    if (intervals.length === 0 || isFullHoliday) {
      // Advance to next day at 00:00
      cursor = cursor.plus({ days: 1 }).startOf('day');
      continue;
    }

    // Process daily business intervals
    let advancedInDay = false;

    for (const interval of intervals) {
      const [startH, startM] = interval.start.split(':').map(Number);
      const [endH, endM] = interval.end.split(':').map(Number);

      const intervalStart = cursor.set({ hour: startH, minute: startM, second: 0, millisecond: 0 });
      const intervalEnd = cursor.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });

      if (cursor < intervalStart) {
        cursor = intervalStart;
      }

      if (cursor >= intervalEnd) {
        continue;
      }

      const availableMs = intervalEnd.toMillis() - cursor.toMillis();

      if (remainingMs <= availableMs) {
        cursor = cursor.plus({ milliseconds: remainingMs });
        remainingMs = 0;
        advancedInDay = true;
        break;
      } else {
        remainingMs -= availableMs;
        cursor = intervalEnd;
        advancedInDay = true;
      }
    }

    if (!advancedInDay || remainingMs > 0) {
      // Advance to next day at 00:00
      cursor = cursor.plus({ days: 1 }).startOf('day');
    }
  }

  return cursor;
}
