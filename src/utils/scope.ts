import { AsyncLocalStorage } from 'node:async_hooks'
import type { OnAlertFn } from '../types/alert.js'
import type { JobsConfig } from '../types/config.js'

/** What the entry point of the current call knows. */
export interface JobScope {
  config?: JobsConfig
  onAlert?: OnAlertFn
  /** ARN of the running Lambda, from `context.invokedFunctionArn`. */
  invokedFunctionArn?: string
  /** Job whose attempt is running, set by `jobWrapper`. */
  jobName?: string
}

const storage = new AsyncLocalStorage<JobScope>()

/**
 * Runs `fn` with `scope` visible to everything it calls.
 *
 * `createJobScheduler`, `jobWrapper` and `jobWatchdog` each open their own scope, so the
 * database and the scheduler read the configuration without it going through every
 * function, and two schedulers with different configs in the same process don't mix.
 */
export const runInScope = <T>(scope: JobScope, fn: () => T): T =>
  storage.run(scope, fn)

/** Scope of the current call. Empty outside the entry points. */
export const getScope = (): JobScope => storage.getStore() ?? {}
