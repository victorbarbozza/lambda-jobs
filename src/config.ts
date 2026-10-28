import type { JobDefinition } from './types/job.js'

/** Defaults applied when a `JobDefinition` leaves the field out. */
export const defaultJobDefinition: Required<
  Omit<
    JobDefinition,
    'retryDelay' | 'deadlineToleranceSeconds' | 'executionRetentionDays'
  >
> = {
  maxRetryAttempts: 0,
  retryMaxAgeMinutes: 60,
  flexibleWindowMinutes: 0,
  failureStrategy: { action: 'continue', alert: false },
  schedule: { delay: { value: 5, unit: 'minutes' } },
  onMissed: 'alert',
}

// ---------------------------------------------------------------------------
// Limits accepted in a job definition
// ---------------------------------------------------------------------------

/** Maximum number of retries a job definition may ask for. */
export const MAX_RETRY_ATTEMPTS = 100

/** Maximum window in which an occurrence can still be retried, in minutes. */
export const MAX_RETRY_AGE_MINUTES = 1440

/** EventBridge Scheduler limit for `MaximumWindowInMinutes`. */
export const MAX_FLEXIBLE_WINDOW_MINUTES = 1440

/**
 * Fields of an EventBridge Scheduler cron expression:
 * `minutes hours day-of-month month day-of-week year`.
 */
export const CRON_FIELDS = 6

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

/**
 * Minimum wait between attempts, in seconds.
 *
 * Smaller values are not useful because Scheduler delivery has leeway in the order of a
 * minute.
 */
export const MIN_RETRY_DELAY_SECONDS = 30

/** Maximum wait between attempts, in seconds. */
export const MAX_RETRY_DELAY_SECONDS = 3600

// ---------------------------------------------------------------------------
// Deadlines and watchdog
// ---------------------------------------------------------------------------

/** Leeway added to the expected instant before the watchdog considers a delivery late. */
export const DEADLINE_TOLERANCE_SECONDS = 300

/** Deadline of the first occurrence of a recurring job, before there is any history. */
export const RECURRING_FIRST_DEADLINE_MS = 60 * 60 * 1000

/**
 * Maximum overdue deadlines handled in one watchdog pass.
 *
 * Each deadline costs two queries and an alert, so the cap keeps the pass within the
 * Lambda timeout. Sized to drain a large incident in a few passes: with
 * `rate(5 minutes)`, a thousand overdue deadlines are gone in two cycles. When not
 * everything fits, `WatchdogResult.truncated` says so.
 */
export const WATCHDOG_PAGE_SIZE = 500

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** How many attempts `getLatestExecutions` returns when no limit is given. */
export const DEFAULT_EXECUTION_PAGE_SIZE = 20
