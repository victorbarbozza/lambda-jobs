import { describe, test, expect } from 'bun:test'
import {
  JobError,
  JobValidationError,
  JobConfigError,
  JobSchedulerError,
  JobSkippedError,
  JobTerminalStateError,
} from '../../src/utils/errors.js'

describe('errors', () => {
  test('JobError has code ERR_JOB and keeps cause', () => {
    const cause = new Error('original')
    const err = new JobError('failed', { cause })

    expect(err.code).toBe('ERR_JOB')
    expect(err.message).toBe('failed')
    expect(err.cause).toBe(cause)
    expect(err).toBeInstanceOf(Error)
  })

  test('subclasses have correct code and are instanceof JobError', () => {
    const cases = [
      { Cls: JobValidationError, code: 'ERR_JOB_VALIDATION' },
      { Cls: JobConfigError, code: 'ERR_JOB_CONFIG' },
      { Cls: JobSchedulerError, code: 'ERR_JOB_SCHEDULER' },
      {
        Cls: class extends JobTerminalStateError {
          constructor() {
            super('terminal', { reason: 'completed' })
          }
        },
        code: 'ERR_JOB_TERMINAL_STATE',
      },
    ] as const

    for (const { Cls, code } of cases) {
      const err = new Cls('msg')
      expect(err.code).toBe(code)
      expect(err).toBeInstanceOf(JobError)
      expect(err).toBeInstanceOf(Error)
    }
  })

  test('JobSkippedError is instanceof JobError but not of JobValidationError', () => {
    const err = new JobSkippedError('ignored')

    expect(err).toBeInstanceOf(JobError)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(JobValidationError)
    expect(err.code).toBe('ERR_JOB')
  })

  test('JobTerminalStateError keeps reason and specific code', () => {
    const err = new JobTerminalStateError('terminal', { reason: 'expired' })

    expect(err).toBeInstanceOf(JobError)
    expect(err.reason).toBe('expired')
    expect(err.code).toBe('ERR_JOB_TERMINAL_STATE')
  })
})
