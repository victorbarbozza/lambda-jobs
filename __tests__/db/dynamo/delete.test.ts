import { beforeEach, describe, expect, test, vi } from 'bun:test'
import {
  ConditionalCheckFailedException,
  type DynamoDB,
} from '@aws-sdk/client-dynamodb'
import {
  deleteEntity,
  deleteRelation,
} from '../../../src/db/dynamo/commands/delete.js'

const TABLE = 'jobs-test-table'

const client = { deleteItem: vi.fn() }
const dynamoDB = client as unknown as DynamoDB

const EXISTS_PARAMS = {
  ConditionExpression: 'attribute_exists(#source) AND attribute_exists(#target)',
  ExpressionAttributeNames: { '#source': 'source', '#target': 'target' },
  ReturnValues: 'ALL_OLD',
}

describe('db/dynamo/commands/delete', () => {
  beforeEach(() => {
    client.deleteItem.mockReset()
    client.deleteItem.mockResolvedValue({})
  })

  describe('deleteEntity', () => {
    test('deletes the entity item with existence condition', async () => {
      await deleteEntity(TABLE, dynamoDB)('Job', 'sendEmail#uuid-1')

      expect(client.deleteItem).toHaveBeenCalledWith({
        TableName: TABLE,
        Key: {
          source: { S: 'Job#sendEmail#uuid-1' },
          target: { S: 'Job#sendEmail#uuid-1' },
        },
        ...EXISTS_PARAMS,
      })
    })

    test('returns the unmarshalled old Attributes', async () => {
      client.deleteItem.mockResolvedValue({
        Attributes: { id: { S: 'sendEmail#uuid-1' }, maxRetryAttempts: { N: '3' } },
      })

      const result = await deleteEntity(TABLE, dynamoDB)('Job', 'sendEmail#uuid-1')

      expect(result as unknown).toEqual({ id: 'sendEmail#uuid-1', maxRetryAttempts: 3 })
    })

    test('missing entity: propagates ConditionalCheckFailedException', async () => {
      const err = new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      })
      client.deleteItem.mockRejectedValue(err)

      await expect(
        deleteEntity(TABLE, dynamoDB)('Job', 'sendEmail#uuid-1')
      ).rejects.toBe(err)
    })
  })

  describe('deleteRelation', () => {
    test('deletes the relation item with existence condition', async () => {
      await deleteRelation(TABLE, dynamoDB)(
        'PendingJob',
        'open',
        'Deadline',
        '2026-01-01T10:00:00.000Z#sendEmail#uuid-1'
      )

      expect(client.deleteItem).toHaveBeenCalledWith({
        TableName: TABLE,
        Key: {
          source: { S: 'PendingJob#open' },
          target: { S: 'Deadline#2026-01-01T10:00:00.000Z#sendEmail#uuid-1' },
        },
        ...EXISTS_PARAMS,
      })
    })

    test('without Attributes: returns empty object', async () => {
      const result = await deleteRelation(TABLE, dynamoDB)(
        'JobSource',
        'user#123',
        'Job',
        'sendEmail#uuid-1'
      )

      expect(result as unknown).toEqual({})
    })
  })
})
