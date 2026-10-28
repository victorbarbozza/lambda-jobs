import type { OnAlertFn } from './alert.js'
import type { JobsConfig } from './config.js'

/** Why an occurrence went past its deadline without resolving. */
export type OverdueReason =
  | 'never_delivered'
  | 'invocation_died'
  | 'retry_lost'
  | 'recurrence_stalled'

/**
 * What the watchdog did with the occurrence, besides alerting.
 *
 * - `rescheduled`: the occurrence was run again (`onMissed: 'run'`)
 * - `closed`: the job was closed as failed
 * - `deadline_pushed`: the job stays alive and the deadline now points to the next
 *   occurrence, which is the case of a stalled recurring job
 */
export type OverdueAction = 'rescheduled' | 'closed' | 'deadline_pushed'

/** Late occurrence found by the watchdog, already classified. */
export interface OverdueFinding {
  jobId: string
  name: string
  jobSource: string
  reason: OverdueReason
  /** Instant by which the delivery was expected. */
  deadline: string
  action: OverdueAction
}

export interface WatchdogResult {
  /** Overdue deadlines examined in this pass. */
  examined: number
  findings: OverdueFinding[]
  /** Whether there were more overdue deadlines than fit in the page. */
  truncated: boolean
}

/** Result of the diagnosis: the same findings, without the action applied. */
export interface DiagnoseResult {
  overdue: Omit<OverdueFinding, 'action'>[]
  truncated: boolean
}

/** Options of `jobWatchdog`. */
export interface JobWatchdogOptions {
  /** Same config given to `createJobScheduler` and `jobWrapper`. */
  config?: JobsConfig
  /** Receives the `overdue` alerts. Without it, they are only logged. */
  onAlert?: OnAlertFn
}
