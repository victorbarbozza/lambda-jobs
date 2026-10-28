import {
  DEADLINE_TOLERANCE_SECONDS,
  MAX_RETRY_DELAY_SECONDS,
  MIN_RETRY_DELAY_SECONDS,
} from '../config.js'
import * as db from '../db/entities.js'
import type { Job } from '../types/job.js'
import { delayToMs, utcNow } from '../utils/date.js'
import { isRecurring } from '../utils/schedule.js'

/**
 * Default wait before the given attempt, in seconds.
 *
 * Grows exponentially from `MIN_RETRY_DELAY_SECONDS` and saturates at
 * `MAX_RETRY_DELAY_SECONDS`.
 */
export const defaultRetryDelay = (attempt: number): number =>
  Math.min(
    MIN_RETRY_DELAY_SECONDS * 2 ** Math.max(attempt - 2, 0),
    MAX_RETRY_DELAY_SECONDS
  )

/**
 * ISO instant by which a delivery is expected.
 *
 * It is the key of the relation the watchdog queries: a deadline in the past means the
 * occurrence did not resolve.
 */
export const deadlineFor = (
  expectedAt: number,
  toleranceSeconds = DEADLINE_TOLERANCE_SECONDS
): string => new Date(expectedAt + toleranceSeconds * 1000).toISOString()

/**
 * Total leeway before a delivery is considered late, in seconds.
 *
 * Adds the flexible window to the tolerance: with `FlexibleTimeWindow`, the Scheduler is
 * allowed to deliver up to `flexibleWindowMinutes` after the nominal time.
 */
export const deliveryTolerance = (
  toleranceSeconds?: number,
  flexibleWindowMinutes?: number
): number =>
  (toleranceSeconds ?? DEADLINE_TOLERANCE_SECONDS) +
  (flexibleWindowMinutes ?? 0) * 60

/**
 * Deadline of the next occurrence of a recurring job, or `undefined` for a one-off job.
 *
 * For `rate` the interval comes from the definition, without any query. For `cron` it is
 * inferred from the distance between the last two occurrences, which avoids parsing the
 * expression.
 */
export const nextOccurrenceDeadline = async (
  job: Job,
  toleranceSeconds?: number
): Promise<string | undefined> => {
  if (!isRecurring(job.schedule)) return undefined

  const interval =
    'rate' in job.schedule
      ? delayToMs(job.schedule.rate)
      : await inferCronInterval(job)

  if (!interval || interval <= 0) return undefined

  return deadlineFor(
    utcNow() + interval,
    deliveryTolerance(toleranceSeconds, job.flexibleWindowMinutes)
  )
}

/**
 * Distance between the last two occurrences of a `cron`.
 *
 * The query limit covers the worst case: the newest occurrence may take
 * `maxRetryAttempts + 1` records before the previous one shows up, because the key is
 * `scheduledTime#attempt`.
 */
const inferCronInterval = async (job: Job): Promise<number | undefined> => {
  const executions = await db.getLatestExecutions(
    job.id,
    (job.maxRetryAttempts + 1) * 2
  )

  const occurrences = [...new Set(executions.map((it) => it.scheduledTime))]
    .map((scheduledTime) => new Date(scheduledTime).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)

  if (occurrences.length < 2) return undefined

  return occurrences[0]! - occurrences[1]!
}
