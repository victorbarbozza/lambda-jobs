import type { JobErrorRecord, JobExecution, JobStatus } from '../types/job.js'

/** States in which the job no longer runs. */
export const isTerminal = (status: JobStatus): boolean =>
  status === 'completed' || status === 'cancelled' || status === 'failed'

/** Error recorded when the invocation dies without recording the attempt's outcome. */
export const ABANDONED_ATTEMPT_ERROR = {
  message: 'Invocation interrupted before recording the outcome',
  code: 'ERR_JOB_ABANDONED',
} as const

/** Projects the failed executions into the format exposed by the error queries. */
export const toErrorRecords = (
  jobId: string,
  executions: JobExecution[]
): JobErrorRecord[] =>
  executions
    .filter((execution) => execution.error != null)
    .map((execution) => ({
      jobId,
      attempt: execution.attempt,
      scheduledTime: execution.scheduledTime,
      message: execution.error!.message,
      code: execution.error!.code,
      stack: execution.error!.stack,
    }))

/** Number of the next attempt of an occurrence, given what was already recorded. */
export const nextAttempt = (executions: JobExecution[]): number =>
  (executions[executions.length - 1]?.attempt ?? 0) + 1
