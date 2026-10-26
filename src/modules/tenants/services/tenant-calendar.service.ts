import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/database/prisma.service';
import {
  CalendarDefinition,
  DEFAULT_WEEKLY_SCHEDULE,
  HolidayDefinition,
  WeeklySchedule,
} from '../../sla/services/sla-calendar-calculator.service';

export interface UpdateCalendarDto {
  name?: string;
  timezone?: string;
  weeklySchedule?: WeeklySchedule;
  is24x7?: boolean;
}

export interface CreateHolidayDto {
  name: string;
  date: string; // YYYY-MM-DD
  isFullDay?: boolean;
  startTime?: string;
  endTime?: string;
}

@Injectable()
export class TenantCalendarService {
  private readonly logger = new Logger(TenantCalendarService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the active business calendar and holidays for a tenant.
   * If none exists, provisions a default Mon-Fri 09:00-17:00 schedule.
   */
  async getTenantCalendarContext(tenantId: string): Promise<{
    calendar: CalendarDefinition;
    holidays: HolidayDefinition[];
  }> {
    let calendarRecord = await this.prisma.businessCalendar.findUnique({
      where: { tenantId },
    });

    if (!calendarRecord) {
      calendarRecord = await this.prisma.businessCalendar.create({
        data: {
          tenantId,
          name: 'Default Business Hours',
          timezone: 'America/New_York',
          weeklySchedule: DEFAULT_WEEKLY_SCHEDULE as any,
          is24x7: false,
        },
      });
    }

    const holidays = await this.prisma.tenantHoliday.findMany({
      where: { tenantId },
      orderBy: { date: 'asc' },
    });

    return {
      calendar: {
        timezone: calendarRecord.timezone,
        weeklySchedule: calendarRecord.weeklySchedule as unknown as WeeklySchedule,
        is24x7: calendarRecord.is24x7,
      },
      holidays: holidays.map((h) => ({
        date: h.date,
        isFullDay: h.isFullDay,
        startTime: h.startTime,
        endTime: h.endTime,
      })),
    };
  }

  async updateCalendar(tenantId: string, dto: UpdateCalendarDto) {
    return this.prisma.businessCalendar.upsert({
      where: { tenantId },
      create: {
        tenantId,
        name: dto.name ?? 'Default Business Hours',
        timezone: dto.timezone ?? 'America/New_York',
        weeklySchedule: (dto.weeklySchedule ?? DEFAULT_WEEKLY_SCHEDULE) as any,
        is24x7: dto.is24x7 ?? false,
      },
      update: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.timezone ? { timezone: dto.timezone } : {}),
        ...(dto.weeklySchedule ? { weeklySchedule: dto.weeklySchedule as any } : {}),
        ...(dto.is24x7 !== undefined ? { is24x7: dto.is24x7 } : {}),
      },
    });
  }

  async addHoliday(tenantId: string, dto: CreateHolidayDto) {
    return this.prisma.tenantHoliday.create({
      data: {
        tenantId,
        name: dto.name,
        date: dto.date,
        isFullDay: dto.isFullDay ?? true,
        startTime: dto.startTime,
        endTime: dto.endTime,
      },
    });
  }

  async listHolidays(tenantId: string) {
    return this.prisma.tenantHoliday.findMany({
      where: { tenantId },
      orderBy: { date: 'asc' },
    });
  }
}
