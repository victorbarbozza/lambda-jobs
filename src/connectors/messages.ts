import type { JobAlert } from '../types/alert.js'
import type { JobEvent } from '../types/event.js'
import type { Job, JobErrorRecord } from '../types/job.js'
import type { OverdueAction, OverdueReason } from '../types/watchdog.js'

const REASON_LABELS: Record<OverdueReason, string> = {
  never_delivered: 'the delivery never reached the job Lambda',
  invocation_died: 'the invocation died without recording the outcome',
  retry_lost: 'the scheduled retry never arrived',
  recurrence_stalled: 'the recurring job stopped firing',
}

const ACTION_LABELS: Record<OverdueAction, string> = {
  rescheduled: 'run again now',
  closed: 'closed as failed',
  deadline_pushed: 'job kept, deadline moved to the next occurrence',
}

/** Watchdog alert for an occurrence past its deadline. */
export const overdueJobMessage = (
  job: Job,
  reason: OverdueReason,
  deadline: string,
  action: OverdueAction
): string =>
  `Job past its deadline\n` +
  `Job: ${job.name} (${job.id})\n` +
  `Source: ${job.jobSource}\n` +
  `Expected by: ${deadline}\n` +
  `Reason: ${REASON_LABELS[reason]}\n` +
  `Action: ${ACTION_LABELS[action]}`

/** Alert raised when the job exhausts all attempts of an occurrence. */
export const jobFailureMessage = (
  job: JobEvent,
  errors: JobErrorRecord[]
): string =>
  `Job failed after exhausting all attempts\n` +
  `Job: ${job.name} (${job.id})\n` +
  `Source: ${job.jobSource}\n` +
  `Attempts: ${errors.length}/${job.maxRetryAttempts + 1}\n` +
  `Last error: ${errors.at(-1)?.message ?? 'unknown'}`

/** Alert of an internal failure of the wrapper or the lifecycle. */
export const internalErrorMessage = (stage: string, error: Error): string =>
  `${stage}\n${error.message}`

/** Any alert in plain text, for whoever only wants to forward the text. */
export const formatAlert = (alert: JobAlert): string => {
  switch (alert.type) {
    case 'job_failed':
      return jobFailureMessage(alert.job, alert.errors)
    case 'internal_error':
      return internalErrorMessage(alert.stage, alert.error)
    case 'overdue':
      return overdueJobMessage(alert.job, alert.reason, alert.deadline, alert.action)
    case 'custom':
      return alert.message
  }
}
