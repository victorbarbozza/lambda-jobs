import type { TSchema } from 'typebox'
import type { OnAlertFn } from './alert.js'
import type { JobsConfig } from './config.js'
import type { ExecutionPolicy, JobErrorRecord } from './job.js'
import type { JobLogger } from '../utils/logger.js'

/**
 * Event delivered to the job handler.
 *
 * The base envelope is built by EventBridge Scheduler. Before calling the handler, the
 * library validates the event and overwrites `attempt` with the effective attempt
 * computed by the lifecycle.
 *
 * The handler must be idempotent on `id`, `scheduledTime` and `attempt`: the same
 * occurrence can be delivered again and, if the Lambda dies on a hard timeout before
 * recording the outcome, a later attempt may repeat the work of that occurrence.
 *
 * In some terminal cases (`completed`, `cancelled`, `expired` or already completed for
 * the same `scheduledTime`), the wrapper may answer success to the Scheduler without
 * calling the user handler.
 */
export interface JobEvent<T = unknown> {
  /** Full ID of the stored job. */
  id: string
  /** Job name as registered in the scheduler. */
  name: string
  /** Business key used to correlate the job with the application domain. */
  jobSource: string
  /** Typed payload consumed by the job handler. */
  payload: T
  /** Time EventBridge scheduled for this occurrence. */
  scheduledTime: string
  /**
   * Current attempt of the occurrence, already normalized by the lifecycle.
   *
   * Always starts at `1`.
   */
  attempt: number
  /**
   * Maximum number of retries configured for the job.
   *
   * Limits:
   * - minimum: `0`
   * - maximum: `100`
   */
  maxRetryAttempts: number
  /**
   * ID EventBridge assigns to each invocation attempt
   * (`<aws.scheduler.execution-id>`).
   *
   * Used to correlate the execution with the CloudWatch logs.
   */
  schedulerExecutionId?: string
}

/** Sends an extra alert from a callback, delivered to `onAlert` as `custom`. */
export type AlertFn = (message: string) => Promise<void>

/** Control of the occurrence, passed to the handler as the second argument. */
export interface JobContext {
  /** Current attempt of the occurrence, starting at `1`. */
  attempt: number
  /** Whether no other attempt will follow this one. */
  isLastAttempt: boolean
  /** JSON logger with the job identified on every line. */
  log: JobLogger
  /**
   * Ends the job successfully and removes the schedule.
   *
   * For a recurring job that reached its goal and no longer needs to run.
   */
  done: () => never
  /**
   * Ends the occurrence as a failure, applying the `failureStrategy`.
   *
   * For when the handler knows that insisting will not help.
   */
  giveUp: (reason: string) => never
  /**
   * Sets the wait until the next attempt, in seconds, instead of the configured
   * backoff.
   *
   * Only takes effect when the handler ends in error.
   */
  retryIn: (seconds: number) => void
}

/**
 * Options of `jobWrapper`.
 *
 * Every callback is optional and always receives the validated `JobEvent`. They let you
 * observe success, retry, terminal failure and internal errors of the wrapper and the
 * lifecycle.
 */
export interface JobWrapperOptions<TPayload = unknown, TResult = unknown> {
  /** Table, Scheduler group and role, and the ARN of the job Lambdas. */
  config?: JobsConfig
  /** Receives the alerts of this job. Without it, they are only logged. */
  onAlert?: OnAlertFn
  /** TypeBox schema used to validate `event.payload` before the handler runs. */
  eventSchema?: TSchema
  /**
   * Retry policy of this job, when different from the default.
   *
   * Only `retryDelay` **must** be here: it is a function and does not survive the event
   * serialization. The other fields already reach the executor through the job record,
   * and setting them here overrides the policy the job was created with.
   */
  definition?: ExecutionPolicy
  /** Called when the handler succeeds. */
  onSuccess?: (
    job: JobEvent<TPayload>,
    result: TResult,
    duration: number
  ) => Promise<void> | void
  /** Called when the handler throws in a single attempt. */
  onExecutionError?: (
    job: JobEvent<TPayload>,
    error: Error,
    duration: number
  ) => Promise<void> | void
  /** Called before the handler when the current attempt is a retry (`attempt > 1`). */
  onRetry?: (job: JobEvent<TPayload>) => Promise<void> | void
  /** Called when the occurrence runs out of attempts. */
  onJobFailure?: (
    job: JobEvent<TPayload>,
    errors: JobErrorRecord[],
    alert: AlertFn
  ) => Promise<void> | void
  /** Called on an internal infrastructure failure of the wrapper or the lifecycle. */
  onInternalError?: (
    context: string,
    error: Error,
    alert: AlertFn
  ) => Promise<void> | void
}
