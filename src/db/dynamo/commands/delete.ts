import type { DeleteItemCommandInput, DynamoDB } from '@aws-sdk/client-dynamodb'

import type { BaseEntityDynamoDB, unknownEntity } from '../types.js'
import { createEntityKey } from '../utils/assemblers.js'
import { marshall, unmarshall } from '../utils/dynamodb.js'

/**
 * Deletes an entity. Fails with `ConditionalCheckFailedException` when it does not
 * exist.
 */
export const deleteEntity =
  (graphTableName: string, dynamoDBClient: DynamoDB) =>
  async <T = unknownEntity>(
    sourceEntityType: string,
    sourceEntityId: string
  ): Promise<BaseEntityDynamoDB<T>> => {
    const source = createEntityKey(sourceEntityType, sourceEntityId)
    return dynamoDBClient
      .deleteItem(createDeleteInputParams(graphTableName, source))
      .then((res) => unmarshall<BaseEntityDynamoDB<T>>(res.Attributes))
  }

/**
 * Deletes a relation. Fails with `ConditionalCheckFailedException` when it does not
 * exist.
 */
export const deleteRelation =
  (graphTableName: string, dynamoDBClient: DynamoDB) =>
  async <T = unknownEntity>(
    sourceEntityType: string,
    sourceEntityId: string,
    targetEntityType: string,
    targetEntityId: string
  ): Promise<BaseEntityDynamoDB<T>> => {
    const source = createEntityKey(sourceEntityType, sourceEntityId)
    const target = createEntityKey(targetEntityType, targetEntityId)
    return dynamoDBClient
      .deleteItem(createDeleteInputParams(graphTableName, source, target))
      .then((resp) => unmarshall<BaseEntityDynamoDB<T>>(resp.Attributes))
  }

const createDeleteInputParams = (
  graphTableName: string,
  source: string,
  target?: string
): DeleteItemCommandInput => ({
  TableName: graphTableName,
  Key: marshall({ source, target: target || source }),
  ConditionExpression:
    'attribute_exists(#source) AND attribute_exists(#target)',
  ExpressionAttributeNames: {
    '#source': 'source',
    '#target': 'target',
  },
  ReturnValues: 'ALL_OLD',
})
