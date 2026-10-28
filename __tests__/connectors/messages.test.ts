import { describe, expect, test } from 'bun:test'
import {
  formatAlert,
  internalErrorMessage,
  jobFailureMessage,
  overdueJobMessage,
} from '../../src/connectors/messages.js'
import type { JobEvent } from '../../src/types/event.js'
import type { Job, JobErrorRecord } from '../../src/types/job.js'

const event: JobEvent = {
  id: 'sendEmail#uuid-1',
  name: 'sendEmail',
  jobSource: 'user#123',
  payload: {},
  scheduledTime: '2025-01-01T00:00:00Z',
  attempt: 3,
  maxRetryAttempts: 2,
}

const job: Job = {
  id: 'sendEmail#uuid-1',
  name: 'sendEmail',
  jobSource: 'user#123',
  status: 'scheduled',
  schedule: { delay: { value: 5, unit: 'minutes' } },
  payload: {},
  maxRetryAttempts: 2,
  failureStrategy: { action: 'continue', alert: true },
  createdAt: '2025-01-01T00:00:00.000Z',
}

const errors: JobErrorRecord[] = [
  { jobId: event.id, attempt: 1, message: 'first', scheduledTime: 'x' },
  { jobId: event.id, attempt: 2, message: 'second', scheduledTime: 'x' },
  { jobId: event.id, attempt: 3, message: 'timeout', scheduledTime: 'x' },
]

/** Chat markup (bold, quote, code) that plain text must not carry. */
const expectPlainText = (text: string) => {
  expect(text).not.toMatch(/[*`>]/)
}

describe('overdueJobMessage', () => {
  test('job, source, deadline, reason and action, one per line', () => {
    const text = overdueJobMessage(
      job,
      'never_delivered',
      '2025-01-01T00:05:00.000Z',
      'closed'
    )

    expect(text).toBe(
      'Job past its deadline\n' +
        'Job: sendEmail (sendEmail#uuid-1)\n' +
        'Source: user#123\n' +
        'Expected by: 2025-01-01T00:05:00.000Z\n' +
        'Reason: the delivery never reached the job Lambda\n' +
        'Action: closed as failed'
    )
    expectPlainText(text)
  })

  test('every reason and action has a label', () => {
    const reasons = [
      'never_delivered',
      'invocation_died',
      'retry_lost',
      'recurrence_stalled',
    ] as const
    const actions = ['rescheduled', 'closed', 'deadline_pushed'] as const

    for (const reason of reasons) {
      for (const action of actions) {
        const text = overdueJobMessage(job, reason, 'x', action)
        expect(text).not.toContain('undefined')
        expectPlainText(text)
      }
    }
  })
})

describe('jobFailureMessage', () => {
  test('job, source, attempts and last error, one per line', () => {
    const text = jobFailureMessage(event, errors)

    expect(text).toBe(
      'Job failed after exhausting all attempts\n' +
        'Job: sendEmail (sendEmail#uuid-1)\n' +
        'Source: user#123\n' +
        'Attempts: 3/3\n' +
        'Last error: timeout'
    )
    expectPlainText(text)
  })

  test('without recorded errors: last error unknown', () => {
    const text = jobFailureMessage(event, [])

    expect(text).toContain('Attempts: 0/3')
    expect(text).toContain('Last error: unknown')
  })
})

describe('internalErrorMessage', () => {
  test('stage and error message', () => {
    const text = internalErrorMessage('startExecution', new Error('DynamoDB throttled'))

    expect(text).toBe('startExecution\nDynamoDB throttled')
    expectPlainText(text)
  })
})

describe('formatAlert', () => {
  test('job_failed: same text as jobFailureMessage', () => {
    expect(formatAlert({ type: 'job_failed', job: event, errors })).toBe(
      jobFailureMessage(event, errors)
    )
  })

  test('internal_error: same text as internalErrorMessage', () => {
    const error = new Error('DynamoDB throttled')

    expect(formatAlert({ type: 'internal_error', stage: 'startExecution', error })).toBe(
      internalErrorMessage('startExecution', error)
    )
  })

  test('overdue: same text as overdueJobMessage', () => {
    const text = formatAlert({
      type: 'overdue',
      job,
      reason: 'retry_lost',
      deadline: '2025-01-01T00:05:00.000Z',
      action: 'rescheduled',
    })

    expect(text).toBe(
      overdueJobMessage(job, 'retry_lost', '2025-01-01T00:05:00.000Z', 'rescheduled')
    )
  })

  test('custom: the message as is', () => {
    expect(formatAlert({ type: 'custom', message: 'stop everything' })).toBe(
      'stop everything'
    )
  })
})
