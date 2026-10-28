import middy from '@middy/core'
import type { Context, Handler } from 'aws-lambda'
import { sendNotification } from '../connectors/notification.js'
import {
  completeExecution,
  failExecution,
  finishJob,
  startExecution,
  type ExecutionContext,
} from '../service/lifecycle/index.js'
import type {
  AlertFn,
  JobContext,
  JobEvent,
  JobWrapperOptions,
} from '../types/event.js'
import type { JobErrorRecord } from '../types/job.js'
import { utcNow } from '../utils/date.js'
import {
  JobDoneSignal,
  JobGiveUpSignal,
  JobSkippedError,
  JobTerminalStateError,
} from '../utils/errors.js'
import { createJobLogger } from '../utils/logger.js'
import { runInScope } from '../utils/scope.js'
import { validateJobEventMiddleware } from './middlewares/validateJobEvent.js'

/** `JobContext` plus what the handler asked through `retryIn`, read after the execution. */
type JobControl = JobContext & { retryInSeconds?: number }

/**
 * Wraps a job handler with event validation, lifecycle control and its own retries.
 *
 * The handler error is not rethrown: the lib records the failure, schedules the next
 * attempt and answers success. Since Lambda sees no error, its asynchronous retry doesn't
 * fire, and the retry policy stays entirely in the lib.
 *
 * @example
 * ```typescript
 * export const handler = jobWrapper(
 *   async (job: JobEvent<EmailPayload>, ctx) => {
 *     const sent = await emailService.send(job.payload)
 *     if (sent) return ctx.done()
 *     ctx.retryIn(600)
 *     throw new Error('email not sent')
 *   },
 *   { eventSchema: emailPayloadSchema, config, onAlert }
 * )
 * ```
 */
export const jobWrapper = <TPayload = unknown, TResult = unknown>(
  handler: (
    job: JobEvent<TPayload>,
    ctx: JobContext
  ) => Promise<TResult> | TResult,
  options?: JobWrapperOptions<TPayload, TResult>
): Handler<JobEvent<TPayload>, TResult | void> => {
  const alert = createAlert()
  const handleInfraError = createInfraErrorHandler(options, alert)
  const safeCallback = createSafeCallback(handleInfraError)

  const mainHandler: Handler<JobEvent<TPayload>, TResult | void> = async (
    event: JobEvent<TPayload>,
    lambdaContext: Context
  ): Promise<TResult | void> => {
    let execution: ExecutionContext

    try {
      execution = await startExecution(
        event,
        lambdaContext.getRemainingTimeInMillis(),
        options?.definition
      )
    } catch (err) {
      if (err instanceof JobTerminalStateError) return
      if (err instanceof JobSkippedError) throw err

      await handleInfraError('startExecution', err)
      throw err
    }

    event.attempt = execution.attempt

    const startedAt = utcNow()
    const control = createControl(event, execution.attempt)

    if (event.attempt > 1) {
      await safeCallback('onRetry', () => options?.onRetry?.(event))
    }

    try {
      const result = await handler(event, control)

      await completeExecution(event, execution, options?.definition).catch(
        (err) => handleInfraError('completeExecution', err)
      )

      await safeCallback('onSuccess', () =>
        options?.onSuccess?.(event, result, utcNow() - startedAt)
      )

      return result
    } catch (signal) {
      if (signal instanceof JobDoneSignal) {
        await finishJob(event.id, execution).catch((err) =>
          handleInfraError('finishJob', err)
        )
        return
      }

      const duration = utcNow() - startedAt
      const error = toError(signal)

      const result = await failExecution(
        event,
        error,
        execution,
        options?.definition,
        {
          retryInSeconds: control.retryInSeconds,
          giveUp: signal instanceof JobGiveUpSignal,
        }
      ).catch(async (err) => {
        await handleInfraError('failExecution', err)
        return null
      })

      // `giveUp` also covers `failExecution` having failed: whoever gave up won't retry
      // anyway, so the terminal failure has to be announced.
      const exhausted =
        signal instanceof JobGiveUpSignal || result?.outcome === 'exhausted'

      if (exhausted) {
        const errors = result?.outcome === 'exhausted' ? result.errors : []
        await announceFailure(event, execution, errors, options, alert, safeCallback)
      }

      await safeCallback('onExecutionError', () =>
        options?.onExecutionError?.(event, error, duration)
      )
    }
  }

  // The scope carries the config, the `onAlert` and the ARN of this Lambda to the
  // lifecycle, which creates the retry schedules.
  const scopedHandler: Handler<JobEvent<TPayload>, TResult | void> = (
    event,
    lambdaContext,
    callback
  ) =>
    runInScope(
      {
        config: options?.config,
        onAlert: options?.onAlert,
        invokedFunctionArn: lambdaContext.invokedFunctionArn,
        jobName: event.name,
      },
      () => mainHandler(event, lambdaContext, callback)
    )

  return middy(scopedHandler).use(
    validateJobEventMiddleware<TPayload>(options?.eventSchema)
  ) as Handler<JobEvent<TPayload>, TResult | void>
}

const toError = (signal: unknown): Error => {
  if (signal instanceof JobGiveUpSignal) return new Error(signal.message)
  return signal instanceof Error ? signal : new Error(String(signal))
}

/** Notifies and calls `onJobFailure` when the occurrence is exhausted. */
const announceFailure = async <TPayload, TResult>(
  event: JobEvent<TPayload>,
  execution: ExecutionContext,
  errors: JobErrorRecord[],
  options: JobWrapperOptions<TPayload, TResult> | undefined,
  alert: AlertFn,
  safeCallback: (name: string, fn: () => unknown) => Promise<void>
): Promise<void> => {
  if (execution.jobEntity.failureStrategy.alert) {
    await sendNotification({ type: 'job_failed', job: event, errors })
  }

  await safeCallback('onJobFailure', () =>
    options?.onJobFailure?.(event, errors, alert)
  )
}

/** Builds the control context handed to the handler. */
const createControl = (event: JobEvent, attempt: number): JobControl => {
  const control: JobControl = {
    attempt,
    isLastAttempt: attempt > event.maxRetryAttempts,
    log: createJobLogger(event),
    retryInSeconds: undefined,
    done: (): never => {
      throw new JobDoneSignal(event.id)
    },
    giveUp: (reason: string): never => {
      throw new JobGiveUpSignal(reason)
    },
    retryIn: (seconds: number): void => {
      control.retryInSeconds = seconds
    },
  }

  return control
}

const createAlert = (): AlertFn => (message) =>
  sendNotification({ type: 'custom', message })

/** Handles internal errors of the wrapper and calls `onInternalError` when set. */
const createInfraErrorHandler =
  <TPayload, TResult>(
    options: JobWrapperOptions<TPayload, TResult> | undefined,
    alert: AlertFn
  ) =>
  async (stage: string, err: unknown): Promise<void> => {
    const error = err instanceof Error ? err : new Error(String(err))

    if (!(error instanceof JobSkippedError)) {
      await sendNotification({ type: 'internal_error', stage, error })
    }

    try {
      await options?.onInternalError?.(stage, error, alert)
    } catch (callbackErr) {
      console.error('[jobs-wrapper] onInternalError callback failed:', callbackErr)
    }
  }

const createSafeCallback =
  (handleInfraError: (stage: string, err: unknown) => Promise<void>) =>
  async (name: string, fn: () => unknown): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      await handleInfraError(name, err)
    }
  }
