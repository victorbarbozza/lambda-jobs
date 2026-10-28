import type { ScheduleOptions } from '../types/schedule.js'
import { dayjs } from './date.js'

/** Whether the schedule has an `endDate` in the past. */
export const isExpired = (schedule: ScheduleOptions): boolean =>
  'endDate' in schedule &&
  schedule.endDate != null &&
  dayjs.utc(schedule.endDate).isBefore(dayjs.utc())

/** Whether the schedule fires more than once (`cron` or `rate`). */
export const isRecurring = (schedule: ScheduleOptions): boolean =>
  'cron' in schedule || 'rate' in schedule

/** Whether the schedule fires a single time (`delay` or `at`). */
export const isOnce = (schedule: ScheduleOptions): boolean =>
  !isRecurring(schedule)
