import { JobConfigError } from './errors.js'
import { getJobsConfig } from './jobsConfig.js'
import { getScope } from './scope.js'

/** Lambda ARN without the version or alias at the end. */
export const getUnqualifiedArn = (arn: string): string =>
  arn.split(':').slice(0, 7).join(':')

/**
 * ARN of the Lambda of `jobName`, next to the current one.
 *
 * Replaces the last segment of the function name (after the last `-`) by `jobName`:
 * `acme-orders-prod-watchdog` becomes `acme-orders-prod-sendEmail`. A name without `-`
 * is replaced whole.
 */
export const buildLambdaFunctionArn = (
  currentArn: string,
  jobName: string
): string => {
  const arn = getUnqualifiedArn(currentArn)
  const nameStart = arn.lastIndexOf(':') + 1
  const name = arn.slice(nameStart)
  const prefix = name.slice(0, name.lastIndexOf('-') + 1)

  return `${arn.slice(0, nameStart)}${prefix}${jobName}`
}

/**
 * ARN of the Lambda that runs `jobName`.
 *
 * `JobsConfig.functionArn` wins when given. Without it, the retry of the running job
 * goes back to the current Lambda, and any other job is looked for next to it. Outside a
 * Lambda there is nothing to derive from.
 */
export const getLambdaArn = (jobName: string): string => {
  const { functionArn } = getJobsConfig()
  if (functionArn) return functionArn(jobName)

  const scope = getScope()

  if (scope.invokedFunctionArn) {
    return scope.jobName === jobName
      ? getUnqualifiedArn(scope.invokedFunctionArn)
      : buildLambdaFunctionArn(scope.invokedFunctionArn, jobName)
  }

  throw new JobConfigError(
    `Cannot find the Lambda of job "${jobName}". ` +
      'Set `functionArn` in the config: createJobScheduler runs outside a job ' +
      'Lambda and has no ARN to derive it from.'
  )
}
