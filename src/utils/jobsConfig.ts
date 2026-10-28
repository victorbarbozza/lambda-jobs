import { getScope } from './scope.js'

/**
 * Configuration of the current call, with the environment variables as fallback.
 *
 * Read on every use, and not on import, so a Lambda that never touches a resource
 * doesn't need its configuration.
 */
export const getJobsConfig = () => {
  const config = getScope().config ?? {}

  return {
    tableName: config.tableName ?? process.env.JOB_TABLE_NAME,
    scheduleGroup:
      config.scheduleGroup ?? process.env.JOB_SCHEDULE_GROUP ?? 'default',
    schedulerRoleArn: config.schedulerRoleArn ?? process.env.JOB_ROLE_ARN,
    functionArn: config.functionArn,
    region: config.region ?? process.env.AWS_REGION,
  }
}
