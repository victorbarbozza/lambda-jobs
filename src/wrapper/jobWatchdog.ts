import type { Context, Handler } from 'aws-lambda'
import { runWatchdog } from '../service/watchdog.js'
import type { JobDefinitions } from '../types/job.js'
import type { JobWatchdogOptions, WatchdogResult } from '../types/watchdog.js'
import { runInScope } from '../utils/scope.js'

/**
 * Handler of the Lambda that examines occurrences past their deadline.
 *
 * Must be triggered by a recurring schedule, typically every five minutes. It runs no
 * job: it finds what the lib can't observe from inside the execution — a delivery that
 * never arrived, a dead invocation, a lost retry and a stalled recurring job.
 *
 * @example
 * ```typescript
 * export const handler = jobWatchdog(jobDefinitions, { config, onAlert })
 * ```
 */
export const jobWatchdog = (
  jobDefinitions: JobDefinitions = {},
  options: JobWatchdogOptions = {}
): Handler<unknown, WatchdogResult> =>
  async (_event: unknown, context: Context) =>
    runInScope(
      {
        config: options.config,
        onAlert: options.onAlert,
        invokedFunctionArn: context?.invokedFunctionArn,
      },
      () => runWatchdog(jobDefinitions)
    )
