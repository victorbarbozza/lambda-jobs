import type {
  unknownEntity,
  BaseEntity,
  BaseEntityDynamoDB,
  BaseRelationDynamoDB,
} from '../types.js'
import type { DynamoDB, UpdateItemCommandInput } from '@aws-sdk/client-dynamodb'

import { createEntityKey } from '../utils/assemblers.js'
import { getKeysToUpdate, marshall, unmarshall } from '../utils/dynamodb.js'

export const upsertRelationField =
  (graphTableName: string, dynamoDBClient: DynamoDB) =>
  async <T = unknownEntity>(
    sourceEntityType: string,
    sourceId: string,
    targetEntityType: string,
    targetId: string,
    data: Partial<BaseRelationDynamoDB<T>>,
    keysToDelete: string[] = []
  ): Promise<BaseRelationDynamoDB<T>> => {
    const source = createEntityKey(sourceEntityType, sourceId)
    const target = createEntityKey(targetEntityType, targetId)
    delete data.source
    delete data.target

    const params = createUpsertItemParams(
      graphTableName,
      source,
      target,
      data,
      keysToDelete
    )

    const result = await dynamoDBClient.updateItem(params)
    const attributes = unmarshall(result.Attributes)

    return attributes as BaseRelationDynamoDB<T>
  }

export const updateEntityField =
  (graphTableName: string, dynamoDBClient: DynamoDB) =>
  async <T = unknownEntity>(
    entityType: string,
    entityId: string,
    data: Partial<BaseEntityDynamoDB<T>>,
    keysToDelete: string[] = []
  ): Promise<BaseEntityDynamoDB<T>> => {
    const source = createEntityKey(entityType, entityId)
    delete data.id
    delete data.source
    delete data.target

    const params = createUpdateItemParams(
      graphTableName,
      source,
      source,
      data,
      keysToDelete
    )

    const result = await dynamoDBClient.updateItem(params)
    return unmarshall<BaseEntityDynamoDB<T>>(result.Attributes)
  }

// Private

const buildUpdateExpression = (
  keysToUpdate: string[],
  keysToDelete: string[],
  isUpsert = false
): string => {
  const setExpression = buildSetExpression(keysToUpdate, isUpsert)
  const deleteExpression = buildDeleteExpression(
    keysToDelete,
    keysToUpdate.length
  )

  if (keysToUpdate.length > 0 && keysToDelete.length > 0)
    return `${setExpression} ${deleteExpression}`

  if (keysToDelete.length > 0) return deleteExpression
  return setExpression
}

const buildSetExpression = (keysToUpdate: string[], isUpsert = false): string => {
  const params = keysToUpdate.map((key, index) =>
    isUpsert && key === 'createdAt'
      ? `#${index} = if_not_exists(#${index}, :${index})`
      : `#${index} = :${index}`
  )

  return `SET ${params.join(', ')}`
}

const buildDeleteExpression = (
  keysToDelete: string[],
  offset: number
): string =>
  `REMOVE ${keysToDelete.map((_, index) => `#${offset + index}`).join(', ')}`

const buildAttributeNames = (keysToUpdate: string[], keysToDelete: string[]) =>
  [...keysToUpdate, ...keysToDelete].reduce<Record<string, string>>(
    (accumulator, k, index) => ({ ...accumulator, [`#${index}`]: k }),
    { '#source': 'source', '#target': 'target' }
  )

const buildAttributeValues = <T = unknownEntity>(
  keysToUpdate: string[],
  data: T
) =>
  keysToUpdate.reduce(
    (accumulator, k, index) => ({
      ...accumulator,
      [`:${index}`]: (data as unknownEntity)[k],
    }),
    {}
  )

const createUpdateItemParams = <T = unknownEntity>(
  graphTableName: string,
  source: string,
  target: string,
  data: Partial<BaseEntity<T>>,
  keysToDelete: string[]
): UpdateItemCommandInput => {
  const dataUpdated: Record<string, unknown> = {
    ...data,
    updatedAt: new Date().toISOString(),
  }
  const keysToUpdate = getKeysToUpdate(dataUpdated)

  return {
    TableName: graphTableName,
    Key: marshall({ source, target }),
    ConditionExpression:
      'attribute_exists(#source) AND attribute_exists(#target)',
    ReturnValues: 'ALL_NEW',
    UpdateExpression: buildUpdateExpression(keysToUpdate, keysToDelete),
    ExpressionAttributeNames: buildAttributeNames(keysToUpdate, keysToDelete),
    ExpressionAttributeValues: marshall(
      buildAttributeValues(keysToUpdate, dataUpdated)
    ),
  }
}

const createUpsertItemParams = <T = unknownEntity>(
  graphTableName: string,
  source: string,
  target: string,
  data: Partial<BaseEntity<T>>,
  keysToDelete: string[]
): UpdateItemCommandInput => {
  const dataUpdated = {
    createdAt: new Date().toISOString(),
    ...data,
    updatedAt: new Date().toISOString(),
  }
  const keysToUpdate = getKeysToUpdate(dataUpdated)
  const expression = buildAttributeNames(keysToUpdate, keysToDelete)
  delete expression['#source']
  delete expression['#target']

  return {
    TableName: graphTableName,
    Key: marshall({ source, target }),
    ReturnValues: 'ALL_NEW',
    UpdateExpression: buildUpdateExpression(keysToUpdate, keysToDelete, true),
    ExpressionAttributeNames: expression,
    ExpressionAttributeValues: marshall(
      buildAttributeValues(keysToUpdate, dataUpdated)
    ),
  }
}
