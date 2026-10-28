import { DEFAULT_EXECUTION_PAGE_SIZE } from './config.js'
import {
  getExecutions,
  getJobById,
  getJobErrors,
  getJobIdsBySource,
  getLatestExecutions,
  getOccurrenceExecutions,
} from './db/entities.js'
import { cancelJob, createJob, retryNow } from './service/commands.js'
import { diagnose } from './service/watchdog.js'
import type { JobsConfig } from './types/config.js'
import type {
  JobDefinitions,
  JobErrorRecord,
  JobExecution,
  JobName,
} from './types/job.js'
import type { ScheduleOptions } from './types/schedule.js'
import { runInScope } from './utils/scope.js'

export type { ScheduleOptions, DelayConfig, TimeUnit } from './types/schedule.js'
export type {
  JobDefinition,
  JobDefinitions,
  JobName,
  JobStatus,
  ExecutionStatus,
  FailureStrategy,
  MissedAction,
  ExecutionPolicy,
  ExecutionError,
  JobExecution,
  JobErrorRecord,
  Job,
} from './types/job.js'
export type {
  JobEvent,
  AlertFn,
  JobContext,
  JobWrapperOptions,
} from './types/event.js'
export type { JobsConfig } from './types/config.js'
export type { JobAlert, OnAlertFn } from './types/alert.js'
export type { JobLogger } from './utils/logger.js'
export {
  JobError,
  JobValidationError,
  JobConfigError,
  JobSchedulerError,
  JobSkippedError,
  JobTerminalStateError,
  JobDoneSignal,
  JobGiveUpSignal,
} from './utils/errors.js'

export type { JobErrorCode, JobTerminalReason } from './utils/errors.js'

export { jobWrapper, jobWatchdog } from './wrapper/index.js'
export { formatAlert } from './connectors/messages.js'

export type {
  DiagnoseResult,
  OverdueAction,
  OverdueFinding,
  OverdueReason,
  WatchdogResult,
  JobWatchdogOptions,
} from './types/watchdog.js'

/**
 * Builds the package API from the map of job definitions.
 *
 * Gathers the write commands, the state queries and the diagnosis used by the watchdog.
 *
 * @example
 * ```typescript
 * const jobs = createJobScheduler(
 *   {
 *     sendEmail: {
 *       maxRetryAttempts: 5,
 *       retryDelay: (attempt) => Math.min(30 * 2 ** attempt, 3600),
 *       failureStrategy: { action: 'cancel', alert: true },
 *     },
 *   },
 *   config
 * )
 *
 * await jobs.createJob('sendEmail', 'user#123', { to: 'email@example.com' })
 * await jobs.getLatestExecutions('sendEmail#job-id-123', 10)
 * ```
 *
 * Among the history queries, prefer `getLatestExecutions` and `getOccurrenceExecutions`:
 * both read a limited range. `getJobExecutions` and `getJobErrors` scan everything the job
 * has accumulated, which in an old recurring job grows without limit.
 */
export const createJobScheduler = <T extends JobDefinitions>(
  jobDefinitions: T,
  config?: JobsConfig
) => {
  const withConfig = <R>(fn: () => Promise<R>): Promise<R> =>
    runInScope({ config }, fn)

  return {
    createJob: (
      name: JobName<T>,
      source: string,
      payload: Record<string, unknown> = {},
      schedule?: ScheduleOptions
    ) => withConfig(() => createJob(name, source, payload, schedule, jobDefinitions)),
    cancelJob: (id: string) => withConfig(() => cancelJob(id)),
    retryNow: (id: string) => withConfig(() => retryNow(id)),
    getJob: (id: string) => withConfig(() => getJobById(id)),
    getJobIdsBySource: (source: string, name?: JobName<T>) =>
      withConfig(() => getJobIdsBySource(source, name)),
    getJobErrors: (jobId: string): Promise<JobErrorRecord[]> =>
      withConfig(() => getJobErrors(jobId)),
    getJobExecutions: (jobId: string): Promise<JobExecution[]> =>
      withConfig(() => getExecutions(jobId)),
    getLatestExecutions: (
      jobId: string,
      limit = DEFAULT_EXECUTION_PAGE_SIZE
    ): Promise<JobExecution[]> => withConfig(() => getLatestExecutions(jobId, limit)),
    getOccurrenceExecutions: (
      jobId: string,
      scheduledTime: string
    ): Promise<JobExecution[]> =>
      withConfig(() => getOccurrenceExecutions(jobId, scheduledTime)),
    diagnose: () => withConfig(() => diagnose()),
  }
}
