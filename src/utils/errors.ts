
/** Stable codes used by the library's exceptions, for programmatic handling. */
export type JobErrorCode =
  | 'ERR_JOB'
  | 'ERR_JOB_VALIDATION'
  | 'ERR_JOB_CONFIG'
  | 'ERR_JOB_SCHEDULER'
  | 'ERR_JOB_TERMINAL_STATE'
  | 'ERR_JOB_ABANDONED'

/**
 * Terminal reasons in which the occurrence must not run anymore and the Scheduler can
 * be answered with success without triggering new retries.
 */
export type JobTerminalReason =
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'already_completed_for_scheduled_time'

/** Base error of the library. Every specific exception extends it. */
export class JobError extends Error {
  code: JobErrorCode

  constructor(message: string, options?: { code?: JobErrorCode; cause?: unknown }) {
    super(message, { cause: options?.cause })
    this.code = options?.code ?? 'ERR_JOB'
    this.name = 'JobError'
  }
}

/** Invalid input, or invalid job or schedule configuration. */
export class JobValidationError extends JobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { code: 'ERR_JOB_VALIDATION', ...options })
    this.name = 'JobValidationError'
  }
}

/** Required configuration missing or inconsistent. */
export class JobConfigError extends JobError {
  constructor(message: string) {
    super(message, { code: 'ERR_JOB_CONFIG' })
    this.name = 'JobConfigError'
  }
}

/** Failure talking to EventBridge Scheduler. */
export class JobSchedulerError extends JobError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { code: 'ERR_JOB_SCHEDULER', ...options })
    this.name = 'JobSchedulerError'
  }
}

/**
 * A transient, operational skip.
 *
 * It raises no alert, but still answers failure to the Scheduler, allowing a retry when
 * the situation may recover later.
 */
export class JobSkippedError extends JobError {
  constructor(message: string) {
    super(message, { code: 'ERR_JOB' })
    this.name = 'JobSkippedError'
  }
}

/** Signal of `ctx.done()`: the job reached its goal and must not run anymore. */
export class JobDoneSignal extends JobError {
  constructor(jobId: string) {
    super(`Job ${jobId} finished by the handler`, { code: 'ERR_JOB' })
    this.name = 'JobDoneSignal'
  }
}

/** Signal of `ctx.giveUp()`: the handler gave up and the occurrence is terminal. */
export class JobGiveUpSignal extends JobError {
  constructor(reason: string) {
    super(reason, { code: 'ERR_JOB_ABANDONED' })
    this.name = 'JobGiveUpSignal'
  }
}

/**
 * The occurrence is already in a terminal state and the Scheduler must be answered with
 * success, without running the handler again.
 */
export class JobTerminalStateError extends JobError {
  reason: JobTerminalReason

  constructor(message: string, options: { reason: JobTerminalReason }) {
    super(message, { code: 'ERR_JOB_TERMINAL_STATE' })
    this.reason = options.reason
    this.name = 'JobTerminalStateError'
  }
}
