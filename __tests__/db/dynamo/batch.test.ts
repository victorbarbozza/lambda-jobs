import { afterAll, beforeEach, describe, expect, setSystemTime, test, vi } from 'bun:test'
import type { DynamoDB, TransactWriteItem } from '@aws-sdk/client-dynamodb'
import {
  createEntityTransactBatch,
  createRelationTransactBatch,
  deleteRelationTransactBatch,
  sendCommandTransactWriteBatch,
} from '../../../src/db/dynamo/commands/batch.js'

const TABLE = 'jobs-test-table'
const NOW = '2026-01-01T10:00:00.000Z'

const client = { transactWriteItems: vi.fn() }
const dynamoDB = client as unknown as DynamoDB

const deleteItem = (index: number): TransactWriteItem => ({
  Delete: {
    TableName: TABLE,
    Key: { source: { S: 'PendingJob#open' }, target: { S: `Deadline#${index}` } },
  },
})

describe('db/dynamo/commands/batch', () => {
  beforeEach(() => {
    setSystemTime(new Date(NOW))
    client.transactWriteItems.mockReset()
    client.transactWriteItems.mockResolvedValue({})
  })

  afterAll(() => {
    setSystemTime()
  })

  describe('createEntityTransactBatch', () => {
    test('Put of the entity with id, source and target equal to the key, and createdAt', () => {
      const item = createEntityTransactBatch(TABLE)('Job', 'sendEmail#uuid-1', {
        status: 'scheduled',
        maxRetryAttempts: 3,
      })

      expect(item).toEqual({
        Put: {
          TableName: TABLE,
          Item: {
            status: { S: 'scheduled' },
            maxRetryAttempts: { N: '3' },
            id: { S: 'sendEmail#uuid-1' },
            source: { S: 'Job#sendEmail#uuid-1' },
            target: { S: 'Job#sendEmail#uuid-1' },
            createdAt: { S: NOW },
          },
        },
      })
    })

    test('id, source, target and createdAt in the data are overwritten', () => {
      const item = createEntityTransactBatch(TABLE)('Job', 'sendEmail#uuid-1', {
        id: 'other',
        source: 'Job#other',
        target: 'Job#other',
        createdAt: '2025-12-31T00:00:00.000Z',
      })

      expect(item.Put!.Item).toEqual({
        id: { S: 'sendEmail#uuid-1' },
        source: { S: 'Job#sendEmail#uuid-1' },
        target: { S: 'Job#sendEmail#uuid-1' },
        createdAt: { S: NOW },
      })
    })

    test('without data: only the keys and createdAt', () => {
      const item = createEntityTransactBatch(TABLE)('Job', 'sendEmail#uuid-1')

      expect(item.Put!.Item).toEqual({
        id: { S: 'sendEmail#uuid-1' },
        source: { S: 'Job#sendEmail#uuid-1' },
        target: { S: 'Job#sendEmail#uuid-1' },
        createdAt: { S: NOW },
      })
    })

    test('undefined values are left out of the item', () => {
      const item = createEntityTransactBatch(TABLE)('Job', 'sendEmail#uuid-1', {
        nextRetryAt: undefined,
      })

      expect(item.Put!.Item).not.toHaveProperty('nextRetryAt')
    })
  })

  describe('createRelationTransactBatch', () => {
    test('Put of the relation with source, target and createdAt, without id', () => {
      const item = createRelationTransactBatch(TABLE)(
        'JobSource',
        'user#123',
        'Job',
        'sendEmail#uuid-1'
      )

      expect(item).toEqual({
        Put: {
          TableName: TABLE,
          Item: {
            source: { S: 'JobSource#user#123' },
            target: { S: 'Job#sendEmail#uuid-1' },
            createdAt: { S: NOW },
          },
        },
      })
    })

    test('the data goes into the item', () => {
      const item = createRelationTransactBatch(TABLE)(
        'JobSource',
        'user#123',
        'Job',
        'sendEmail#uuid-1',
        { relation: 'Job' }
      )

      expect(item.Put!.Item).toMatchObject({ relation: { S: 'Job' } })
    })
  })

  describe('deleteRelationTransactBatch', () => {
    test('Delete by source and target', () => {
      const item = deleteRelationTransactBatch(TABLE)(
        'PendingJob',
        'open',
        'Deadline',
        '2026-01-01T10:00:00.000Z#sendEmail#uuid-1'
      )

      expect(item).toEqual({
        Delete: {
          TableName: TABLE,
          Key: {
            source: { S: 'PendingJob#open' },
            target: { S: 'Deadline#2026-01-01T10:00:00.000Z#sendEmail#uuid-1' },
          },
        },
      })
    })
  })

  describe('sendCommandTransactWriteBatch', () => {
    const send = sendCommandTransactWriteBatch(dynamoDB)

    test('sends the items as TransactItems, with the ClientRequestToken', async () => {
      const items = [deleteItem(1), deleteItem(2)]

      await send(items, 'token-1')

      expect(client.transactWriteItems).toHaveBeenCalledWith({
        TransactItems: items,
        ClientRequestToken: 'token-1',
      })
    })

    test('returns the result of transactWriteItems', async () => {
      const output = { $metadata: {}, ConsumedCapacity: [] }
      client.transactWriteItems.mockResolvedValue(output)

      expect(await send([deleteItem(1)])).toBe(output)
    })

    test('100 items: sends', async () => {
      const items = Array.from({ length: 100 }, (_, index) => deleteItem(index))

      await send(items)

      expect(client.transactWriteItems).toHaveBeenCalledTimes(1)
    })

    test('more than 100 items: throws without sending', () => {
      const items = Array.from({ length: 101 }, (_, index) => deleteItem(index))

      expect(() => send(items)).toThrow('Transaction cannot exceed 100 items.')
      expect(client.transactWriteItems).not.toHaveBeenCalled()
    })
  })
})
