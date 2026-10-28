import { DynamoDB, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb'

import {
  createEntityTransactBatch,
  createRelationTransactBatch,
  deleteRelationTransactBatch,
  sendCommandTransactWriteBatch,
} from './commands/batch.js'
import { deleteEntity, deleteRelation } from './commands/delete.js'
import {
  getEntity,
  getAllRelationsWhithPrefix,
  queryRelationsInRange,
} from './commands/get.js'
import { upsertRelationField, updateEntityField } from './commands/update.js'

export * from './types.js'
export * from './utils/assemblers.js'
export { isConditionalCheckFailure } from './utils/dynamodb.js'

/**
 * Graph operations on the jobs table, copied from `dynamo-graphdb-utils` with only what
 * `entities.ts` uses.
 *
 * Every item has `source` as partition key and `target` as sort key, both in the
 * `Type#id` format. An entity points to itself; a relation links two entities.
 */
export const createRawGraphCommands = (
  graphTableName: string,
  dynamoDBConfig: DynamoDBClientConfig
) => {
  const dynamoDBClient = new DynamoDB(dynamoDBConfig)

  return {
    deleteEntity: deleteEntity(graphTableName, dynamoDBClient),
    deleteRelation: deleteRelation(graphTableName, dynamoDBClient),

    getAllRelationsWhithPrefix: getAllRelationsWhithPrefix(
      graphTableName,
      dynamoDBClient
    ),
    queryRelationsInRange: queryRelationsInRange(
      graphTableName,
      dynamoDBClient
    ),
    getEntity: getEntity(graphTableName, dynamoDBClient),

    upsertRelationField: upsertRelationField(graphTableName, dynamoDBClient),
    updateEntityField: updateEntityField(graphTableName, dynamoDBClient),

    createRelationTransactBatch: createRelationTransactBatch(graphTableName),
    createEntityTransactBatch: createEntityTransactBatch(graphTableName),
    deleteRelationTransactBatch: deleteRelationTransactBatch(graphTableName),
    sendCommandTransactWriteBatch:
      sendCommandTransactWriteBatch(dynamoDBClient),
  }
}
