/** Units accepted by delays and rates. */
export type TimeUnit = 'minutes' | 'hours' | 'days'

/** Duration used by `delay` and `rate` schedules. */
export interface DelayConfig {
  value: number
  unit: TimeUnit
}

/**
 * Supported scheduling strategies.
 *
 * Exactly ONE option must be used:
 * - `delay`: a single run relative to the creation time
 * - `at`: a single run at an absolute instant
 * - `cron`: recurring runs by cron expression
 * - `rate`: recurring runs at a fixed interval
 *
 * `cron` and `rate` schedules accept an `endDate` to stop the recurrence automatically
 * after a date.
 *
 * In recurring schedules, an occurrence does not wait for the previous one to finish: use
 * an interval longer than the Lambda timeout, or two occurrences may run together.
 */
export type ScheduleOptions =
  | { delay: DelayConfig }
  | { at: string }
  | { cron: string; endDate?: string }
  | { rate: DelayConfig; endDate?: string }
