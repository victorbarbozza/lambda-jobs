import { WATCHDOG_PAGE_SIZE } from '../config.js'
import { sendNotification } from '../connectors/notification.js'
import * as db from '../db/entities.js'
import type { Job, JobDefinitions, JobExecution, MissedAction } from '../types/job.js'
import type {
  DiagnoseResult,
  OverdueAction,
  OverdueFinding,
  OverdueReason,
  WatchdogResult,
} from '../types/watchdog.js'
import { isTerminal } from '../utils/job.js'
import { retryNow } from './commands.js'
import { nextOccurrenceDeadline } from './deadline.js'
import { closeJob, markAttemptAbandoned } from './lifecycle/index.js'

/** State needed to classify a late occurrence. */
interface OverdueInspection {
  job: Job
  executions: JobExecution[]
  reason: OverdueReason
}

/**
 * Examines the occurrences whose deadline has passed and handles each one according to
 * its actual state.
 *
 * Finds what the library cannot observe from inside the execution: a delivery that never
 * arrived, an invocation that died without recording the outcome, a lost retry and a
 * recurring job that stopped firing.
 */
export const runWatchdog = async (
  jobDefinitions: JobDefinitions = {},
  pageSize = WATCHDOG_PAGE_SIZE
): Promise<WatchdogResult> => {
  const page = await db.getOverdueJobs(new Date().toISOString(), pageSize)

  const findings = await Promise.all(
    page.items.map(({ jobId, deadline }) =>
      settle(jobId, deadline, jobDefinitions)
    )
  )

  return {
    examined: page.items.length,
    findings: findings.filter((finding) => finding != null),
    truncated: page.nextPageToken != null,
  }
}

/**
 * Side-effect free diagnosis, with the overdue deadlines and the reason of each.
 *
 * Meant for on-demand inspection, behind an internal route or a script.
 */
export const diagnose = async (
  pageSize = WATCHDOG_PAGE_SIZE
): Promise<DiagnoseResult> => {
  const page = await db.getOverdueJobs(new Date().toISOString(), pageSize)

  const overdue = await Promise.all(
    page.items.map(async ({ jobId, deadline }) => {
      const inspection = await inspect(jobId)
      if (!inspection) return null

      const { job, reason } = inspection

      return { jobId, name: job.name, jobSource: job.jobSource, deadline, reason }
    })
  )

  return {
    overdue: overdue.filter((item) => item != null),
    truncated: page.nextPageToken != null,
  }
}

/**
 * Loads the job state and classifies the delay.
 *
 * Returns `null` for a deadline without owner or of a job already terminal: it is a
 * leftover of a process that died between moving the deadline and writing the job, not
 * an incident.
 */
const inspect = async (jobId: string): Promise<OverdueInspection | null> => {
  const job = await db.getJobById(jobId)
  if (!job || isTerminal(job.status)) return null

  const executions = await db.getOccurrenceExecutions(
    jobId,
    job.lastScheduledTime ?? ''
  )

  return { job, executions, reason: classify(job, executions) }
}

const settle = async (
  jobId: string,
  deadline: string,
  jobDefinitions: JobDefinitions
): Promise<OverdueFinding | null> => {
  const inspection = await inspect(jobId)

  if (!inspection) {
    await db.clearDeadline(jobId, deadline)
    return null
  }

  const { job, executions, reason } = inspection
  const runningAttempt = executions.find((attempt) => attempt.status === 'running')

  if (runningAttempt) await markAttemptAbandoned(jobId, runningAttempt)

  const onMissed = jobDefinitions[job.name]?.onMissed ?? 'alert'
  const action = await applyOutcome(job, reason, deadline, onMissed)

  await sendNotification({ type: 'overdue', job, reason, deadline, action })

  return {
    jobId,
    name: job.name,
    jobSource: job.jobSource,
    reason,
    deadline,
    action,
  }
}

const classify = (job: Job, executions: JobExecution[]): OverdueReason => {
  if (executions.some((attempt) => attempt.status === 'running')) return 'invocation_died'
  if (job.nextRetryAt) return 'retry_lost'
  if (job.status === 'active') return 'recurrence_stalled'
  return 'never_delivered'
}

/** Applies the outcome and returns what was done. */
const applyOutcome = async (
  job: Job,
  reason: OverdueReason,
  deadline: string,
  onMissed: MissedAction
): Promise<OverdueAction> => {
  // A missed occurrence does not invalidate the next ones, and clearing the deadline
  // would leave the job unobserved from here on.
  if (reason === 'recurrence_stalled') {
    await db.moveDeadline(job.id, deadline, await nextOccurrenceDeadline(job), {})
    return 'deadline_pushed'
  }

  if (onMissed === 'run' && (await retryNow(job.id))) {
    return 'rescheduled'
  }

  await closeJob(job.id, 'failed', deadline)
  return 'closed'
}
