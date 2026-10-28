import type { BaseEntity, unknownEntity } from '../types.js'
import type {
  AttributeValue,
  DynamoDB,
  TransactWriteItem,
} from '@aws-sdk/client-dynamodb'

import { createEntityKey } from '../utils/assemblers.js'
import { marshall } from '../utils/dynamodb.js'

export const createRelationTransactBatch =
  (graphTableName: string) =>
  <T = unknownEntity>(
    sourceEntityType: string,
    sourceId: string,
    targetEntityType: string,
    targetId: string,
    data?: T | BaseEntity<T>
  ): TransactWriteItem => ({
    Put: {
      Item: createRelationItem(
        sourceEntityType,
        sourceId,
        targetEntityType,
        targetId,
        data
      ),
      TableName: graphTableName,
    },
  })

export const createEntityTransactBatch =
  (graphTableName: string) =>
  <T = unknownEntity>(
    entityType: string,
    entityId: string,
    data?: T | BaseEntity<T>
  ): TransactWriteItem => ({
    Put: {
      Item: createEntityItem(entityType, entityId, data),
      TableName: graphTableName,
    },
  })

export const deleteRelationTransactBatch =
  (graphTableName: string) =>
  (
    sourceEntityType: string,
    sourceId: string,
    targetEntityType: string,
    targetId: string
  ): TransactWriteItem => ({
    Delete: {
      Key: createRelationKeyItem(
        sourceEntityType,
        sourceId,
        targetEntityType,
        targetId
      ),
      TableName: graphTableName,
    },
  })

export const sendCommandTransactWriteBatch =
  (dynamoDBClient: DynamoDB) =>
  (commands: TransactWriteItem[], ClientRequestToken?: string) => {
    if (commands.length > 100) {
      throw new Error(`Transaction cannot exceed 100 items.`)
    }

    return dynamoDBClient.transactWriteItems({
      TransactItems: commands,
      ClientRequestToken,
    })
  }

// Private

const createEntityItem = <T = unknownEntity>(
  entityType: string,
  entityId: string,
  data?: T | BaseEntity<T>
): Record<string, AttributeValue> => {
  const source = createEntityKey(entityType, entityId)
  const newData = (data ?? {}) as unknownEntity
  return marshall({
    ...newData,
    id: entityId,
    source,
    target: source,
    createdAt: new Date().toISOString(),
  })
}

const createRelationItem = <T = unknownEntity>(
  sourceEntityType: string,
  sourceId: string,
  targetEntityType: string,
  targetId: string,
  data?: T | BaseEntity<T>
): Record<string, AttributeValue> => {
  const source = createEntityKey(sourceEntityType, sourceId)
  const target = createEntityKey(targetEntityType, targetId)
  const newData = (data ?? {}) as unknownEntity
  return marshall({
    ...newData,
    source,
    target,
    createdAt: new Date().toISOString(),
  })
}

const createRelationKeyItem = (
  sourceEntityType: string,
  sourceId: string,
  targetEntityType: string,
  targetId: string
): Record<string, AttributeValue> => {
  const source = createEntityKey(sourceEntityType, sourceId)
  const target = createEntityKey(targetEntityType, targetId)
  return marshall({ source, target })
}
