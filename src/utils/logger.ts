import type { JobEvent } from '../types/event.js'

/** Severity level emitted by the job logger. */
export type LogLevel = 'info' | 'warn' | 'error'

export interface JobLogger {
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
}

/**
 * JSON logger with the job identified on every line.
 *
 * Emitting `jobId`, `name`, `scheduledTime` and `attempt` as fields allows filtering by
 * job in CloudWatch Logs Insights, which free text does not.
 */
export const createJobLogger = (event: JobEvent): JobLogger => {
  const base = {
    jobId: event.id,
    name: event.name,
    jobSource: event.jobSource,
    scheduledTime: event.scheduledTime,
    attempt: event.attempt,
  }

  const emit =
    (level: LogLevel) =>
    (message: string, data?: Record<string, unknown>): void => {
      const line = JSON.stringify({ level, message, ...base, ...data })
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }

  return { info: emit('info'), warn: emit('warn'), error: emit('error') }
}
