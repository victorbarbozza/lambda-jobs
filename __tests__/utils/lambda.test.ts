import { describe, expect, test } from 'bun:test'
import { JobConfigError } from '../../src/utils/errors.js'
import {
  buildLambdaFunctionArn,
  getLambdaArn,
  getUnqualifiedArn,
} from '../../src/utils/lambda.js'
import { runInScope } from '../../src/utils/scope.js'
import { TEST_FUNCTION_ARN } from '../helpers/jobsEnv.js'

const FUNCTION_PREFIX = 'arn:aws:lambda:us-east-1:123456789012:function:'

describe('lambda', () => {
  describe('getUnqualifiedArn', () => {
    test('unqualified ARN stays the same', () => {
      expect(getUnqualifiedArn(TEST_FUNCTION_ARN)).toBe(TEST_FUNCTION_ARN)
    })

    test('drops the alias', () => {
      expect(getUnqualifiedArn(`${TEST_FUNCTION_ARN}:live`)).toBe(TEST_FUNCTION_ARN)
    })

    test('drops the version', () => {
      expect(getUnqualifiedArn(`${TEST_FUNCTION_ARN}:42`)).toBe(TEST_FUNCTION_ARN)
    })
  })

  describe('buildLambdaFunctionArn', () => {
    test('replaces the last `-` segment of the name with jobName', () => {
      expect(buildLambdaFunctionArn(TEST_FUNCTION_ARN, 'sendEmail')).toBe(
        `${FUNCTION_PREFIX}acme-orders-prod-sendEmail`
      )
    })

    test('name without `-`: replaced whole', () => {
      expect(buildLambdaFunctionArn(`${FUNCTION_PREFIX}watchdog`, 'sendEmail')).toBe(
        `${FUNCTION_PREFIX}sendEmail`
      )
    })

    test('qualified ARN: the qualifier is dropped, not taken as the name', () => {
      expect(buildLambdaFunctionArn(`${TEST_FUNCTION_ARN}:live`, 'sendEmail')).toBe(
        `${FUNCTION_PREFIX}acme-orders-prod-sendEmail`
      )
    })
  })

  describe('getLambdaArn', () => {
    const functionArn = (jobName: string) => `${FUNCTION_PREFIX}explicit-${jobName}`

    test('config.functionArn wins over the invoked Lambda', () => {
      const arn = runInScope(
        {
          config: { functionArn },
          invokedFunctionArn: TEST_FUNCTION_ARN,
          jobName: 'sendEmail',
        },
        () => getLambdaArn('sendEmail')
      )

      expect(arn).toBe(`${FUNCTION_PREFIX}explicit-sendEmail`)
    })

    test('config.functionArn works outside a Lambda', () => {
      const arn = runInScope({ config: { functionArn } }, () => getLambdaArn('sendSms'))

      expect(arn).toBe(`${FUNCTION_PREFIX}explicit-sendSms`)
    })

    test('same job as the scope: the invoked Lambda, unqualified', () => {
      // The retry goes back to the Lambda that ran the attempt, even when its name does
      // not end in `-{jobName}`.
      const arn = runInScope(
        {
          invokedFunctionArn: `${FUNCTION_PREFIX}orders-worker:live`,
          jobName: 'sendEmail',
        },
        () => getLambdaArn('sendEmail')
      )

      expect(arn).toBe(`${FUNCTION_PREFIX}orders-worker`)
    })

    test('other job: built from the invoked Lambda', () => {
      const arn = runInScope(
        { invokedFunctionArn: TEST_FUNCTION_ARN, jobName: 'jobRunner' },
        () => getLambdaArn('sendEmail')
      )

      expect(arn).toBe(`${FUNCTION_PREFIX}acme-orders-prod-sendEmail`)
    })

    test('scope without jobName, as in the watchdog: built from the invoked Lambda', () => {
      const arn = runInScope({ invokedFunctionArn: TEST_FUNCTION_ARN }, () =>
        getLambdaArn('sendEmail')
      )

      expect(arn).toBe(`${FUNCTION_PREFIX}acme-orders-prod-sendEmail`)
    })

    test('without functionArn and without invokedFunctionArn: JobConfigError', () => {
      expect(() => runInScope({}, () => getLambdaArn('sendEmail'))).toThrow(
        JobConfigError
      )
    })

    test('outside any scope: JobConfigError naming the job and functionArn', () => {
      expect(() => getLambdaArn('sendEmail')).toThrow(
        'Cannot find the Lambda of job "sendEmail". Set `functionArn` in the config'
      )
    })
  })
})
