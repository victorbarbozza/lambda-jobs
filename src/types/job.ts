import type { ScheduleOptions } from './schedule.js'

/**
 * Static configuration of a job type, registered in `createJobScheduler`.
 *
 * Every field is optional: when absent, the library applies the defaults defined in
 * `config.ts`.
 */
export interface JobDefinition {
  /**
   * Maximum number of retries after the first attempt.
   *
   * Each attempt is a schedule created by the library, so AWS imposes no cap.
   *
   * Limits:
   * - minimum: `0`
   * - maximum: `100`
   */
  maxRetryAttempts?: number
  /**
   * Wait, in seconds, before the given attempt.
   *
   * Receives the number of the attempt about to happen, starting at `2`. When absent,
   * the library applies capped exponential growth.
   *
   * On a recurring job, keep the total retry window shorter than the interval between
   * occurrences, or a late occurrence runs together with the next one.
   */
  retryDelay?: (attempt: number) => number
  /**
   * Total window, in minutes, to complete an occurrence.
   *
   * Once this time has passed since `scheduledTime`, the library gives up even with
   * attempts left.
   *
   * Limits:
   * - minimum: `1`
   * - maximum: `1440`
   */
  retryMaxAgeMinutes?: number
  /**
   * EventBridge Scheduler flexible time window, in minutes.
   *
   * - `0` disables it
   * - cannot be negative
   */
  flexibleWindowMinutes?: number
  /** Default schedule used when `createJob` receives no explicit schedule. */
  schedule?: ScheduleOptions
  /** Strategy applied when every attempt is exhausted. */
  failureStrategy?: FailureStrategy
  /**
   * What the watchdog does when the occurrence never happens.
   *
   * - `alert`: only alerts
   * - `run`: reschedules it for now, besides alerting
   */
  onMissed?: MissedAction
  /**
   * Leeway, in seconds, added to the expected instant before the watchdog considers the
   * delivery late. Default: `300`.
   */
  deadlineToleranceSeconds?: number
  /**
   * Days the execution history of this job is kept, applied by the table TTL.
   *
   * Absent by default: the history never expires. Must be longer than
   * `retryMaxAgeMinutes`, because the attempt number and the detection of abandoned
   * invocations come from the history. Requires TTL enabled on the `ttl` attribute.
   */
  executionRetentionDays?: number
}

/**
 * The part of the definition that the executor of the job needs to know.
 *
 * It is what crosses the boundary between the Lambda that creates the job and the one
 * that runs it, through `jobWrapper({ definition })`. The lifecycle phases read from
 * here what each one uses.
 */
export type ExecutionPolicy = Pick<
  JobDefinition,
  | 'retryDelay'
  | 'retryMaxAgeMinutes'
  | 'deadlineToleranceSeconds'
  | 'executionRetentionDays'
>

/** Action of the watchdog for an occurrence that never happened. */
export type MissedAction = 'alert' | 'run'

/** `{ jobName: definition }` map registering the jobs available to the scheduler. */
export type JobDefinitions = Record<string, JobDefinition>

/** Job name restricted to the keys declared in `JobDefinitions`. */
export type JobName<T extends JobDefinitions> = keyof T & string

/** Stored state of the job along its lifecycle. */
export type JobStatus =
  | 'scheduled'
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** State of a single execution attempt. */
export type ExecutionStatus = 'running' | 'completed' | 'failed'

/**
 * Terminal strategy of the job when no retries are left.
 *
 * - `continue`: does not cancel the job; recurring schedules stay active until they
 *   expire
 * - `cancel`: cancels the job and removes the schedule
 * - `alert`: whether the wrapper raises an alert when the job exhausts every attempt
 */
export interface FailureStrategy {
  action: 'continue' | 'cancel'
  alert: boolean
}

/** Error stored in a failed execution. */
export interface ExecutionError {
  message: string
  code?: string
  stack?: string
}

/**
 * Record of one execution attempt for a given `scheduledTime`.
 *
 * The same `scheduledTime` may have several records when there are retries.
 */
export interface JobExecution {
  /** Instant EventBridge scheduled for this occurrence. */
  scheduledTime: string
  status: ExecutionStatus
  /** Attempt number within the same `scheduledTime`, starting at `1`. */
  attempt: number
  /** Start timestamp of the attempt, in UTC milliseconds. */
  startedAt: number
  /**
   * Instant at which the invocation that opened this attempt runs out of time, in UTC
   * milliseconds.
   *
   * It is `startedAt` plus the remaining Lambda time when the attempt started. A later
   * delivery uses it to decide whether the attempt may still be alive or was left
   * `running` by a hard timeout.
   */
  expiresAt: number
  /**
   * `<aws.scheduler.execution-id>` of the occurrence.
   *
   * Identifies the schedule occurrence, not the attempt: EventBridge renders the Input
   * once and repeats the same value on every retry. Used to correlate executions with
   * the Scheduler logs.
   */
  schedulerExecutionId?: string
  /** Completion timestamp of the attempt, when applicable. */
  completedAt?: number
  error?: ExecutionError
  /** Expiration instant of the record, in UTC seconds, applied by the table TTL. */
  ttl?: number
}

/**
 * Job before being stored.
 *
 * Holds the fields controlled by the application, without the metadata added by the
 * database such as `createdAt` and `updatedAt`.
 */
export interface JobInput {
  /** Full job identifier, in the `{jobName}#{uuid}` format. */
  id: string
  /** Logical job name as registered in `JobDefinitions`. */
  name: string
  /** Business identifier associated with the job, used for lookup and traceability. */
  jobSource: string
  status: JobStatus
  schedule: ScheduleOptions
  /** Data delivered to the job handler. */
  payload: Record<string, unknown>
  maxRetryAttempts: number
  failureStrategy: FailureStrategy
  /**
   * Flexible window the schedule was created with in EventBridge.
   *
   * It is part of the deadline the watchdog enforces: within it, the delivery is still
   * on time.
   */
  flexibleWindowMinutes?: number
  /**
   * Maximum age of the occurrence, in minutes, the job was created with.
   *
   * Kept on the job so a redeploy of the definition does not change the behavior of jobs
   * already scheduled.
   */
  retryMaxAgeMinutes?: number
  /** Last `scheduledTime` whose execution has started. */
  lastScheduledTime?: string
  /**
   * ISO instant by which the next delivery is expected.
   *
   * It is the key of the deadline relation the watchdog queries. Absent when the job is
   * in a terminal state.
   */
  nextDeadline?: string
  /** ISO instant of the next attempt scheduled by the library, when there is one. */
  nextRetryAt?: string
  /** Terminal timestamp of the job, when it can no longer run. */
  completedAt?: number
}

/**
 * Job stored in the database.
 *
 * Same shape as `JobInput`, plus the audit fields added on write.
 */
export interface Job extends JobInput {
  /** ISO date in UTC, written on creation. */
  createdAt: string
  /** ISO date in UTC, updated on every write. */
  updatedAt?: string
}

/**
 * Simplified error projection used by the history queries.
 *
 * Each record is an execution that failed for a given `scheduledTime`.
 */
export interface JobErrorRecord {
  jobId: string
  attempt: number
  message: string
  code?: string
  stack?: string
  scheduledTime: string
}
