import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import type {
  Job,
  JobErrorRecord,
  JobExecution,
  JobInput,
} from '../types/job.js'
import { JobConfigError } from '../utils/errors.js'
import { toErrorRecords } from '../utils/job.js'
import { getJobsConfig } from '../utils/jobsConfig.js'
import {
  createRawGraphCommands,
  getTargetId,
  getTargetIds,
  isConditionalCheckFailure,
} from './dynamo/index.js'
import { EntityType, PENDING_SOURCE_ID, type OverdueJob } from './types.js'

type GraphDB = ReturnType<typeof createRawGraphCommands>
type GraphMeta = 'source' | 'target' | 'relation'

const stripGraphFields = <
  T extends { source?: unknown; target?: unknown; relation?: unknown },
>(
  entity: T
): Omit<T, GraphMeta> => {
  const { source, target, relation, ...rest } = entity
  return rest
}

const createGraph = (tableName: string, region?: string): GraphDB =>
  createRawGraphCommands(tableName, { region })

const cachedGraphs = new Map<string, GraphDB>()

/**
 * Resolves the graph client on the first query, and not on module import.
 *
 * That way the table is only required by whoever really reads or writes jobs. One
 * client is kept per table and region, because the config comes from the entry point
 * of each call.
 */
const graph = (): GraphDB => {
  const { tableName, region } = getJobsConfig()
  if (!tableName) {
    throw new JobConfigError(
      'Jobs table not set: use tableName in the config or JOB_TABLE_NAME'
    )
  }

  const key = `${region}#${tableName}`
  let cached = cachedGraphs.get(key)
  if (!cached) {
    cached = createGraph(tableName, region)
    cachedGraphs.set(key, cached)
  }
  return cached
}

/**
 * A delete with existence condition fails when the item is already gone, and that is
 * "not found" for whoever wants to delete.
 */
const isNotFound = (err: unknown): boolean => isConditionalCheckFailure(err)

const ignoreNotFound = (err: unknown): void => {
  if (isNotFound(err)) return
  throw err
}

/** Target of the deadline relation, with the instant first so it sorts by time. */
const deadlineTarget = (deadline: string, jobId: string): string =>
  `${deadline}#${jobId}`

/**
 * Stores the job with its source relation and the deadline of the first delivery, in a
 * single transaction.
 */
export const createJob = async (job: JobInput): Promise<void> => {
  const transactItems = [
    graph().createEntityTransactBatch(EntityType.Job, job.id, job),
    graph().createRelationTransactBatch(
      EntityType.JobSource,
      job.jobSource,
      EntityType.Job,
      job.id
    ),
  ]

  if (job.nextDeadline) {
    transactItems.push(
      graph().createRelationTransactBatch(
        EntityType.PendingJob,
        PENDING_SOURCE_ID,
        EntityType.Deadline,
        deadlineTarget(job.nextDeadline, job.id)
      )
    )
  }

  await graph().sendCommandTransactWriteBatch(transactItems)
}

/**
 * Splits the fields between writing and removing.
 *
 * A partial update ignores keys whose value is `undefined`, so clearing a field takes
 * asking for its removal by name.
 */
const partitionUpdate = (
  fields: Partial<JobInput>
): { set: Partial<JobInput>; remove: string[] } => {
  const set: Record<string, unknown> = {}
  const remove: string[] = []

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) remove.push(key)
    else set[key] = value
  }

  return { set: set as Partial<JobInput>, remove }
}

/**
 * Moves the deadline of an occurrence to a new instant, or removes it when absent.
 *
 * The instant is part of the key, so moving means deleting and creating — both go in the
 * same transaction so the job never has two open deadlines. The job update is partial
 * and comes afterwards, so the job only turns terminal once the deadline is right.
 */
export const moveDeadline = async (
  jobId: string,
  from: string | undefined,
  to: string | undefined,
  fields: Partial<JobInput>
): Promise<void> => {
  const transactItems = []

  if (from) {
    transactItems.push(
      graph().deleteRelationTransactBatch(
        EntityType.PendingJob,
        PENDING_SOURCE_ID,
        EntityType.Deadline,
        deadlineTarget(from, jobId)
      )
    )
  }

  if (to) {
    transactItems.push(
      graph().createRelationTransactBatch(
        EntityType.PendingJob,
        PENDING_SOURCE_ID,
        EntityType.Deadline,
        deadlineTarget(to, jobId)
      )
    )
  }

  if (transactItems.length > 0) {
    await graph().sendCommandTransactWriteBatch(transactItems)
  }

  const { set, remove } = partitionUpdate({ ...fields, nextDeadline: to })

  await graph().updateEntityField(EntityType.Job, jobId, set, remove)
}

/**
 * Lists occurrences whose deadline has passed, oldest first.
 *
 * Pages by `nextPageToken`: DynamoDB may return fewer items than the limit and still
 * have a next page.
 */
export const getOverdueJobs = async (
  until: string,
  limit: number,
  nextPageToken?: Record<string, AttributeValue>
): Promise<{
  items: OverdueJob[]
  nextPageToken?: Record<string, AttributeValue>
}> => {
  const page = await graph().queryRelationsInRange(
    EntityType.PendingJob,
    PENDING_SOURCE_ID,
    { to: `${EntityType.Deadline}#${until}` },
    { limit, nextPageToken }
  )

  return {
    items: page.items.map((relation) => {
      const [deadline, ...jobId] = getTargetId(relation).split('#')
      return { deadline: deadline!, jobId: jobId.join('#') }
    }),
    nextPageToken: page.nextPageToken,
  }
}

/** Reads the main job record. Returns `null` when the ID doesn't exist in the graph. */
export const getJobById = (id: string): Promise<Job | null> =>
  graph()
    .getEntity<Job>(EntityType.Job, id)
    .then((job) => job && stripGraphFields(job))

/** Failures from the whole job history, in the format exposed by the queries. */
export const getJobErrors = (jobId: string): Promise<JobErrorRecord[]> =>
  getExecutions(jobId).then((executions) => toErrorRecords(jobId, executions))

/** Attempt number left-padded with zeros, so it sorts as a number in the key. */
const attemptKey = (attempt: number): string => String(attempt).padStart(4, '0')

/**
 * Creates or updates the record of an execution.
 *
 * The relation key is `scheduledTime#attempt`, allowing several attempts for the same
 * occurrence. The `ttl` is decided in `startExecution` and travels in the execution
 * itself, so the following phases keep it without recomputing.
 */
export const upsertExecution = async (
  jobId: string,
  execution: JobExecution
): Promise<void> => {
  await graph().upsertRelationField(
    EntityType.Job,
    jobId,
    EntityType.JobExecution,
    `${execution.scheduledTime}#${attemptKey(execution.attempt)}`,
    execution
  )
}

/** Every attempt of an occurrence, sorted by `attempt`. */
export const getOccurrenceExecutions = (
  jobId: string,
  scheduledTime: string
): Promise<JobExecution[]> =>
  graph()
    .getAllRelationsWhithPrefix<JobExecution>(
      EntityType.Job,
      jobId,
      `${EntityType.JobExecution}#${scheduledTime}#`
    )
    .then((relations) =>
      relations.map(stripGraphFields).sort((a, b) => a.attempt - b.attempt)
    )

/**
 * Latest executions of a job, newest first, in a single page.
 *
 * The `￿` closes the range at the end of the prefix, since the query is a sort key range
 * and not a `begins_with`.
 */
export const getLatestExecutions = async (
  jobId: string,
  limit: number
): Promise<JobExecution[]> => {
  const page = await graph().queryRelationsInRange<JobExecution>(
    EntityType.Job,
    jobId,
    {
      from: `${EntityType.JobExecution}#`,
      to: `${EntityType.JobExecution}#￿`,
    },
    { limit, ascending: false }
  )

  return page.items.map(stripGraphFields)
}

/** The whole execution history of a job. */
export const getExecutions = (jobId: string): Promise<JobExecution[]> =>
  graph()
    .getAllRelationsWhithPrefix<JobExecution>(
      EntityType.Job,
      jobId,
      `${EntityType.JobExecution}#`
    )
    .then((relations) => relations.map(stripGraphFields))

/**
 * IDs of the jobs created for a `jobSource`.
 *
 * When `name` is given, only jobs of that type are returned.
 */
export const getJobIdsBySource = async (
  jobSource: string,
  name?: string
): Promise<string[]> => {
  const prefix = name ? `${EntityType.Job}#${name}#` : `${EntityType.Job}#`
  const relations = await graph().getAllRelationsWhithPrefix(
    EntityType.JobSource,
    jobSource,
    prefix
  )
  return getTargetIds(relations)
}

/**
 * Deletes the job, its source relation and its pending deadline.
 *
 * Idempotent for resources already gone: "not found" errors are ignored, but any other
 * database failure is propagated.
 */
export const deleteJob = async (
  id: string,
  source: string,
  deadline?: string
): Promise<void> => {
  const deletions = [
    graph()
      .deleteRelation(EntityType.JobSource, source, EntityType.Job, id)
      .catch(ignoreNotFound),
    graph().deleteEntity(EntityType.Job, id).catch(ignoreNotFound),
  ]

  if (deadline) deletions.push(clearDeadline(id, deadline))

  await Promise.all(deletions)
}

/** Deletes only the deadline relation, when the job stops waiting for a delivery. */
export const clearDeadline = async (
  jobId: string,
  deadline: string
): Promise<void> => {
  await graph()
    .deleteRelation(
      EntityType.PendingJob,
      PENDING_SOURCE_ID,
      EntityType.Deadline,
      deadlineTarget(deadline, jobId)
    )
    .catch(ignoreNotFound)
}
