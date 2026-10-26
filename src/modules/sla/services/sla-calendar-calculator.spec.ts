import { DateTime } from 'luxon';
import {
  CalendarDefinition,
  DEFAULT_WEEKLY_SCHEDULE,
  HolidayDefinition,
  SlaCalendarCalculatorService,
} from './sla-calendar-calculator.service';

describe('SlaCalendarCalculatorService (Phase 5 Business Calendar & Holidays)', () => {
  let calculator: SlaCalendarCalculatorService;

  const nyCalendar: CalendarDefinition = {
    timezone: 'America/New_York',
    weeklySchedule: DEFAULT_WEEKLY_SCHEDULE, // Mon-Fri 09:00 to 17:00
    is24x7: false,
  };

  beforeEach(() => {
    calculator = new SlaCalendarCalculatorService();
  });

  describe('Core Business Hours & Weekend Rollover', () => {
    it('Friday 15:00 with 4-hour SLA resumes Monday at 09:00 and breaches at Monday 11:00', () => {
      // Friday Oct 23, 2026 at 15:00 EDT (19:00 UTC)
      const friday1500 = DateTime.fromISO('2026-10-23T15:00:00', {
        zone: 'America/New_York',
      }).toJSDate();

      const fourHoursMs = 4 * 3600 * 1000; // 14,400,000 ms

      const deadlines = calculator.calculateDeadlines(friday1500, fourHoursMs, nyCalendar, []);

      // Convert breach date back to New York local time
      const breachNY = DateTime.fromJSDate(deadlines.breachDate, {
        zone: 'America/New_York',
      });
      const warningNY = DateTime.fromJSDate(deadlines.warningDate, {
        zone: 'America/New_York',
      });

      // Assert Breach is Monday at 11:00 AM local time
      expect(breachNY.toFormat('cccc')).toBe('Monday');
      expect(breachNY.toFormat('yyyy-MM-dd')).toBe('2026-10-26');
      expect(breachNY.toFormat('HH:mm')).toBe('11:00');

      // Assert Warning (80% of 4h = 3.2h = 3h 12m).
      // 2h elapse Friday (15:00-17:00), remaining 1h 12m resume Monday 09:00 -> Monday 10:12 AM
      expect(warningNY.toFormat('cccc')).toBe('Monday');
      expect(warningNY.toFormat('yyyy-MM-dd')).toBe('2026-10-26');
      expect(warningNY.toFormat('HH:mm')).toBe('10:12');
    });

    it('handles tickets created outside business hours (e.g. Sunday afternoon)', () => {
      // Sunday Oct 25, 2026 at 14:00 EDT (closed weekend)
      const sunday1400 = DateTime.fromISO('2026-10-25T14:00:00', {
        zone: 'America/New_York',
      }).toJSDate();

      const twoHoursMs = 2 * 3600 * 1000; // 7,200,000 ms

      const deadlines = calculator.calculateDeadlines(sunday1400, twoHoursMs, nyCalendar, []);

      const breachNY = DateTime.fromJSDate(deadlines.breachDate, {
        zone: 'America/New_York',
      });

      // Active business hours start Monday at 09:00 AM, so 2h SLA breaches at Monday 11:00 AM
      expect(breachNY.toFormat('cccc')).toBe('Monday');
      expect(breachNY.toFormat('yyyy-MM-dd')).toBe('2026-10-26');
      expect(breachNY.toFormat('HH:mm')).toBe('11:00');
    });

    it('handles tickets created on weekday evening after business hours', () => {
      // Tuesday Oct 20, 2026 at 20:30 EDT (after 17:00 close)
      const tuesdayNight = DateTime.fromISO('2026-10-20T20:30:00', {
        zone: 'America/New_York',
      }).toJSDate();

      const oneHourMs = 1 * 3600 * 1000;

      const deadlines = calculator.calculateDeadlines(tuesdayNight, oneHourMs, nyCalendar, []);
      const breachNY = DateTime.fromJSDate(deadlines.breachDate, {
        zone: 'America/New_York',
      });

      // Starts Wednesday 09:00 AM -> breaches Wednesday 10:00 AM
      expect(breachNY.toFormat('cccc')).toBe('Wednesday');
      expect(breachNY.toFormat('yyyy-MM-dd')).toBe('2026-10-21');
      expect(breachNY.toFormat('HH:mm')).toBe('10:00');
    });
  });

  describe('Multi-Day Holiday Spans', () => {
    it('skips multi-day consecutive holidays and weekends', () => {
      // Wednesday Nov 25, 2026 at 16:00 EDT (1 hour left on Wednesday)
      const wednesday1600 = DateTime.fromISO('2026-11-25T16:00:00', {
        zone: 'America/New_York',
      }).toJSDate();

      const holidays: HolidayDefinition[] = [
        { date: '2026-11-26', isFullDay: true }, // Thanksgiving Thursday
        { date: '2026-11-27', isFullDay: true }, // Black Friday
      ];

      const fourHoursMs = 4 * 3600 * 1000;

      const deadlines = calculator.calculateDeadlines(
        wednesday1600,
        fourHoursMs,
        nyCalendar,
        holidays,
      );

      const breachNY = DateTime.fromJSDate(deadlines.breachDate, {
        zone: 'America/New_York',
      });

      // 1h elapses Wednesday (16:00-17:00).
      // Thursday (Holiday), Friday (Holiday), Saturday (Weekend), Sunday (Weekend) are skipped.
      // Remaining 3h resume Monday Nov 30 at 09:00 -> breaches Monday Nov 30 at 12:00 PM!
      expect(breachNY.toFormat('cccc')).toBe('Monday');
      expect(breachNY.toFormat('yyyy-MM-dd')).toBe('2026-11-30');
      expect(breachNY.toFormat('HH:mm')).toBe('12:00');
    });
  });

  describe('Daylight Saving Time (DST) Transitions', () => {
    it('correctly handles Fall Back DST transition in America/New_York', () => {
      // US DST ends Sunday, Nov 1, 2026 (clocks fall back from EDT UTC-4 to EST UTC-5)
      // Ticket created Friday Oct 30, 2026 at 16:00 EDT (UTC-4)
      const fridayBeforeDst = DateTime.fromISO('2026-10-30T16:00:00', {
        zone: 'America/New_York',
      }).toJSDate();

      const threeHoursMs = 3 * 3600 * 1000; // 1h Friday + 2h Monday

      const deadlines = calculator.calculateDeadlines(
        fridayBeforeDst,
        threeHoursMs,
        nyCalendar,
        [],
      );

      const breachNY = DateTime.fromJSDate(deadlines.breachDate, {
        zone: 'America/New_York',
      });

      // On Monday Nov 2, 2026, timezone has shifted to EST (UTC-5).
      // Active hours 09:00 + 2h -> 11:00 AM EST!
      expect(breachNY.toFormat('cccc')).toBe('Monday');
      expect(breachNY.toFormat('yyyy-MM-dd')).toBe('2026-11-02');
      expect(breachNY.toFormat('HH:mm')).toBe('11:00');
      expect(breachNY.offsetNameShort).toBe('EST');
    });
  });

  describe('Elapsed Business Hours Calculation', () => {
    it('computes exact active business milliseconds elapsed across a weekend', () => {
      // Friday 15:00 to Monday 10:30 in America/New_York
      const fromDate = DateTime.fromISO('2026-10-23T15:00:00', {
        zone: 'America/New_York',
      }).toJSDate();

      const toDate = DateTime.fromISO('2026-10-26T10:30:00', {
        zone: 'America/New_York',
      }).toJSDate();

      const elapsedMs = calculator.calculateElapsedBusinessMs(fromDate, toDate, nyCalendar, []);

      // Friday 15:00-17:00 (2h = 7,200,000ms) + Weekend (0) + Monday 09:00-10:30 (1.5h = 5,400,000ms)
      // Total = 3.5h = 12,600,000 ms
      const expectedMs = 3.5 * 3600 * 1000;
      expect(elapsedMs).toBe(expectedMs);
    });

    it('returns 0 elapsed business ms when window falls entirely on a weekend or closed hours', () => {
      // Saturday 10:00 to Sunday 18:00
      const fromDate = DateTime.fromISO('2026-10-24T10:00:00', {
        zone: 'America/New_York',
      }).toJSDate();

      const toDate = DateTime.fromISO('2026-10-25T18:00:00', {
        zone: 'America/New_York',
      }).toJSDate();

      const elapsedMs = calculator.calculateElapsedBusinessMs(fromDate, toDate, nyCalendar, []);
      expect(elapsedMs).toBe(0);
    });
  });

  describe('24x7 Schedule Bypass', () => {
    it('runs continuously in wall-clock time when is24x7 is true', () => {
      const continuousCalendar: CalendarDefinition = {
        timezone: 'UTC',
        weeklySchedule: DEFAULT_WEEKLY_SCHEDULE,
        is24x7: true,
      };

      const start = new Date('2026-10-24T10:00:00.000Z'); // Saturday
      const fourHoursMs = 4 * 3600 * 1000;

      const deadlines = calculator.calculateDeadlines(start, fourHoursMs, continuousCalendar, []);

      // Advances 4 hours continuously regardless of Saturday
      expect(deadlines.breachDate.toISOString()).toBe('2026-10-24T14:00:00.000Z');
      expect(deadlines.warningDate.toISOString()).toBe('2026-10-24T13:12:00.000Z');
    });
  });
});
