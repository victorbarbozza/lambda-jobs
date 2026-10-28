import type { JobEvent } from './event.js'
import type { Job, JobErrorRecord } from './job.js'
import type { OverdueAction, OverdueReason } from './watchdog.js'

/**
 * Alert raised by the package and delivered to `onAlert`.
 *
 * - `job_failed`: the job exhausted all attempts and has `failureStrategy.alert`
 * - `internal_error`: infrastructure failure in the wrapper or the lifecycle
 * - `overdue`: occurrence found by the watchdog past its deadline
 * - `custom`: message sent by the `alert` argument of `onJobFailure` or
 *   `onInternalError`
 *
 * `formatAlert` turns any of them into plain text.
 */
export type JobAlert =
  | { type: 'job_failed'; job: JobEvent; errors: JobErrorRecord[] }
  | { type: 'internal_error'; stage: string; error: Error }
  | {
      type: 'overdue'
      job: Job
      reason: OverdueReason
      deadline: string
      action: OverdueAction
    }
  | { type: 'custom'; message: string }

/**
 * Receives the alerts of the package.
 *
 * Without it, the alert is only logged. A failure inside it is logged and never changes
 * the result of the job.
 */
export type OnAlertFn = (alert: JobAlert) => Promise<void> | void
