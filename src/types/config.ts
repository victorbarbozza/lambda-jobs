/**
 * Configuration accepted by `createJobScheduler`, `jobWrapper` and `jobWatchdog`.
 *
 * The three create schedules (job, retry and re-run by the watchdog), so the three need
 * the same values. Every field is optional and falls back to the environment variable
 * noted on it.
 */
export interface JobsConfig {
  /** DynamoDB table of the jobs. Fallback: `JOB_TABLE_NAME`. */
  tableName?: string
  /** EventBridge Scheduler group. Fallback: `JOB_SCHEDULE_GROUP`, then `'default'`. */
  scheduleGroup?: string
  /** Role the Scheduler assumes to invoke the Lambdas. Fallback: `JOB_ROLE_ARN`. */
  schedulerRoleArn?: string
  /**
   * Full ARN of the Lambda that runs `jobName`.
   *
   * Without it, a retry goes back to the Lambda that ran the attempt, and the watchdog
   * uses its own ARN with the last segment of the name (after the last `-`) replaced by
   * `jobName`. `createJobScheduler` runs outside a job Lambda and has nothing to derive
   * from, so creating a job there requires this option.
   */
  functionArn?: (jobName: string) => string
  /** Fallback: `AWS_REGION`. */
  region?: string
}
