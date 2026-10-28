import type {
  unknownEntity,
  BaseEntityDynamoDB,
  BaseRelationDynamoDB,
} from '../types.js'
import type {
  DynamoDB,
  GetItemCommandInput,
  AttributeValue,
  QueryCommandInput,
} from '@aws-sdk/client-dynamodb'

import { createEntityKey } from '../utils/assemblers.js'
import { marshall, unmarshall } from '../utils/dynamodb.js'

/** Reads an entity. Returns `null` when it does not exist. */
export const getEntity =
  (graphTableName: string, dynamoDBClient: DynamoDB) =>
  async <T = unknownEntity>(
    entityType: string,
    entityId: string
  ): Promise<BaseEntityDynamoDB<T> | null> => {
    const source = createEntityKey(entityType, entityId)
    const params = createGetItemParams(graphTableName, source, source)

    const result = await dynamoDBClient.getItem(params)
    if (!result.Item) return null

    return unmarshall(result.Item) as BaseEntityDynamoDB<T>
  }

export const getAllRelationsWhithPrefix =
  (graphTableName: string, dynamoDBClient: DynamoDB) =>
  async <T = unknownEntity>(
    entityType: string,
    entityId: string,
    prefix: string
  ): Promise<BaseRelationDynamoDB<T>[]> => {
    const index = createEntityKey(entityType, entityId)
    const params = createGetAllRelationsWhithPrefix(
      graphTableName,
      index,
      prefix
    )

    return await fetchAllItemsByQuery<BaseRelationDynamoDB<T>>(
      dynamoDBClient,
      params
    )
  }

/**
 * Queries one page of an entity's relations, filtering the sort key by range.
 *
 * The sort key is `target`. The comparison is lexicographic: it only sorts correctly
 * values that sort as text (ISO 8601, ULID, zero-padded numbers).
 *
 * @param entityType - Type of the queried entity (partition).
 * @param entityId - Id of the queried entity (partition).
 * @param range - Inclusive bounds of the sort key. Omitted, queries the whole
 * partition. Only `from`: `>=`. Only `to`: `<=`. Both: `BETWEEN`.
 * @param options.limit - Maximum items read per page.
 * @param options.nextPageToken - `nextPageToken` returned by the previous page.
 * @param options.ascending - Read order of the sort key. Default `true`.
 * @returns Items of the page and the `nextPageToken` of the next one, absent on the
 * last. DynamoDB may return fewer items than `limit` and still have a next page: page
 * while `nextPageToken` exists, not by `items.length`.
 *
 * @example
 * ```ts
 * // Relations with target up to a value, in pages of 100.
 * let nextPageToken
 * do {
 *   const page = await queryRelationsInRange(
 *     'PendingJob',
 *     'open',
 *     { to: `Deadline#${new Date().toISOString()}` },
 *     { limit: 100, nextPageToken }
 *   )
 *   await process(page.items)
 *   nextPageToken = page.nextPageToken
 * } while (nextPageToken)
 * ```
 *
 * @example
 * ```ts
 * // Last 20 relations of the partition, from the highest sort key to the lowest.
 * const { items } = await queryRelationsInRange(
 *   'Job',
 *   'sendEmail#123',
 *   undefined,
 *   { limit: 20, ascending: false }
 * )
 * ```
 */
export const queryRelationsInRange =
  (graphTableName: string, dynamoDBClient: DynamoDB) =>
  async <T = unknownEntity>(
    entityType: string,
    entityId: string,
    range?: { from?: string; to?: string },
    options?: {
      limit?: number
      nextPageToken?: Record<string, AttributeValue>
      ascending?: boolean
    }
  ): Promise<{
    items: BaseRelationDynamoDB<T>[]
    nextPageToken?: Record<string, AttributeValue>
  }> => {
    const index = createEntityKey(entityType, entityId)
    const params = createQueryRelationsInRangeParams(
      graphTableName,
      index,
      range,
      options
    )

    const { Items, LastEvaluatedKey } = await dynamoDBClient.query(params)

    return {
      items: (Items ?? []).map((item) =>
        unmarshall<BaseRelationDynamoDB<T>>(item)
      ),
      nextPageToken: LastEvaluatedKey,
    }
  }

// Private

const createGetItemParams = (
  graphTableName: string,
  source: string,
  target: string
): GetItemCommandInput => ({
  TableName: graphTableName,
  Key: marshall({ source, target }),
})

const createGetAllRelationsWhithPrefix = (
  graphTableName: string,
  index: string,
  prefix: string,
  nextPageToken?: Record<string, AttributeValue>
): QueryCommandInput => ({
  TableName: graphTableName,
  KeyConditionExpression: '#pk = :pk AND begins_with(#prefix, :prefix)',
  ExpressionAttributeNames: {
    '#pk': 'source',
    '#prefix': 'target',
  },
  ExpressionAttributeValues: marshall({
    ':pk': index,
    ':prefix': prefix,
  }),
  ExclusiveStartKey: nextPageToken,
})

const createQueryRelationsInRangeParams = (
  graphTableName: string,
  index: string,
  range?: { from?: string; to?: string },
  options?: {
    limit?: number
    nextPageToken?: Record<string, AttributeValue>
    ascending?: boolean
  }
): QueryCommandInput => {
  const names: Record<string, string> = { '#pk': 'source' }
  const values: Record<string, unknown> = { ':pk': index }
  let condition = '#pk = :pk'

  if (range?.from !== undefined || range?.to !== undefined) {
    names['#sk'] = 'target'

    if (range.from !== undefined && range.to !== undefined) {
      values[':from'] = range.from
      values[':to'] = range.to
      condition += ' AND #sk BETWEEN :from AND :to'
    } else if (range.from !== undefined) {
      values[':from'] = range.from
      condition += ' AND #sk >= :from'
    } else {
      values[':to'] = range.to
      condition += ' AND #sk <= :to'
    }
  }

  return {
    TableName: graphTableName,
    KeyConditionExpression: condition,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values),
    Limit: options?.limit,
    ExclusiveStartKey: options?.nextPageToken,
    ScanIndexForward: options?.ascending ?? true,
  }
}

const fetchAllItemsByQuery = async <T extends object = Record<string, unknown>>(
  dynamoDBClient: DynamoDB,
  params: QueryCommandInput
): Promise<T[]> => {
  const result = []
  do {
    const { Items, LastEvaluatedKey } = await dynamoDBClient.query(params)
    if (Items) {
      result.push(...Items.map((item) => unmarshall<T>(item)))
    }
    params.ExclusiveStartKey = LastEvaluatedKey
  } while (params.ExclusiveStartKey)
  return result
}
