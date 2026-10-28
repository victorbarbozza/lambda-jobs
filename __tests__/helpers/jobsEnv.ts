const JOBS_TEST_ENV = {
  JOB_TABLE_NAME: 'jobs-test-table',
  AWS_REGION: 'us-east-1',
  JOB_ROLE_ARN: 'arn:aws:iam::123456789012:role/job-role',
} as const

/** ARN of the Lambda that runs the jobs in the tests, as in `context.invokedFunctionArn`. */
export const TEST_FUNCTION_ARN =
  'arn:aws:lambda:us-east-1:123456789012:function:acme-orders-prod-jobRunner'

export const applyJobsTestEnv = (
  overrides: Partial<Record<keyof typeof JOBS_TEST_ENV, string>> = {}
): void => {
  const env = { ...JOBS_TEST_ENV, ...overrides }

  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
}

export const clearJobsTestEnv = (): void => {
  for (const key of Object.keys(JOBS_TEST_ENV)) {
    delete process.env[key]
  }

  delete process.env.JOB_SCHEDULE_GROUP
}
