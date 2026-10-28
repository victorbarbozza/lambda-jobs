import { afterAll, beforeEach, describe, expect, setSystemTime, test, vi } from 'bun:test'
import type { DynamoDB, UpdateItemCommandInput } from '@aws-sdk/client-dynamodb'
import {
  updateEntityField,
  upsertRelationField,
} from '../../../src/db/dynamo/commands/update.js'

const TABLE = 'jobs-test-table'
const NOW = '2026-01-01T10:00:00.000Z'
const EXISTS_CONDITION = 'attribute_exists(#source) AND attribute_exists(#target)'

const client = { updateItem: vi.fn() }
const dynamoDB = client as unknown as DynamoDB

/** Params of the first `updateItem` call. */
const sentParams = () => client.updateItem.mock.calls[0]![0] as UpdateItemCommandInput

describe('db/dynamo/commands/update', () => {
  beforeEach(() => {
    setSystemTime(new Date(NOW))
    client.updateItem.mockReset()
    client.updateItem.mockResolvedValue({})
  })

  afterAll(() => {
    setSystemTime()
  })

  describe('updateEntityField', () => {
    const update = updateEntityField(TABLE, dynamoDB)

    test('updates the entity item with existence condition and ALL_NEW', async () => {
      await update('Job', 'sendEmail#uuid-1', { status: 'active' })

      expect(sentParams()).toEqual({
        TableName: TABLE,
        Key: {
          source: { S: 'Job#sendEmail#uuid-1' },
          target: { S: 'Job#sendEmail#uuid-1' },
        },
        ConditionExpression: EXISTS_CONDITION,
        ReturnValues: 'ALL_NEW',
        UpdateExpression: 'SET #0 = :0, #1 = :1',
        ExpressionAttributeNames: {
          '#source': 'source',
          '#target': 'target',
          '#0': 'status',
          '#1': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':0': { S: 'active' },
          ':1': { S: NOW },
        },
      })
    })

    test('keysToDelete go into REMOVE, numbered after the SET keys', async () => {
      await update('Job', 'sendEmail#uuid-1', { status: 'completed' }, [
        'nextRetryAt',
        'nextDeadline',
      ])

      const params = sentParams()
      expect(params.UpdateExpression).toBe('SET #0 = :0, #1 = :1 REMOVE #2, #3')
      expect(params.ExpressionAttributeNames).toMatchObject({
        '#0': 'status',
        '#1': 'updatedAt',
        '#2': 'nextRetryAt',
        '#3': 'nextDeadline',
      })
      expect(Object.keys(params.ExpressionAttributeValues!)).toEqual([':0', ':1'])
    })

    test('drops id, source and target from the data', async () => {
      await update('Job', 'sendEmail#uuid-1', {
        id: 'other',
        source: 'Job#other',
        target: 'Job#other',
        status: 'active',
      })

      const params = sentParams()
      expect(params.UpdateExpression).toBe('SET #0 = :0, #1 = :1')
      expect(params.ExpressionAttributeNames).toMatchObject({
        '#0': 'status',
        '#1': 'updatedAt',
      })
      expect(params.Key).toEqual({
        source: { S: 'Job#sendEmail#uuid-1' },
        target: { S: 'Job#sendEmail#uuid-1' },
      })
    })

    test('undefined values are left out of SET; false and 0 are written', async () => {
      await update('Job', 'sendEmail#uuid-1', {
        paused: false,
        attempt: 0,
        nextRetryAt: undefined,
      })

      const params = sentParams()
      expect(params.UpdateExpression).toBe('SET #0 = :0, #1 = :1, #2 = :2')
      expect(params.ExpressionAttributeNames).toMatchObject({
        '#0': 'paused',
        '#1': 'attempt',
        '#2': 'updatedAt',
      })
      expect(params.ExpressionAttributeValues).toEqual({
        ':0': { BOOL: false },
        ':1': { N: '0' },
        ':2': { S: NOW },
      })
    })

    test('returns the unmarshalled Attributes', async () => {
      client.updateItem.mockResolvedValue({
        Attributes: { id: { S: 'sendEmail#uuid-1' }, status: { S: 'active' } },
      })

      const result = await update('Job', 'sendEmail#uuid-1', { status: 'active' })

      expect(result as unknown).toEqual({ id: 'sendEmail#uuid-1', status: 'active' })
    })
  })

  describe('upsertRelationField', () => {
    const upsert = upsertRelationField(TABLE, dynamoDB)

    test('writes the relation without condition, keeping the first createdAt', async () => {
      await upsert('Job', 'sendEmail#uuid-1', 'JobExecution', '2026-01-01T10:00:00#0001', {
        status: 'running',
      })

      expect(sentParams()).toEqual({
        TableName: TABLE,
        Key: {
          source: { S: 'Job#sendEmail#uuid-1' },
          target: { S: 'JobExecution#2026-01-01T10:00:00#0001' },
        },
        ReturnValues: 'ALL_NEW',
        UpdateExpression: 'SET #0 = if_not_exists(#0, :0), #1 = :1, #2 = :2',
        ExpressionAttributeNames: {
          '#0': 'createdAt',
          '#1': 'status',
          '#2': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':0': { S: NOW },
          ':1': { S: 'running' },
          ':2': { S: NOW },
        },
      })
    })

    test('createdAt in the data is the value of if_not_exists', async () => {
      await upsert('Job', 'sendEmail#uuid-1', 'JobExecution', '2026-01-01T10:00:00#0001', {
        createdAt: '2025-12-31T00:00:00.000Z',
        status: 'running',
      })

      const params = sentParams()
      expect(params.UpdateExpression).toBe(
        'SET #0 = if_not_exists(#0, :0), #1 = :1, #2 = :2'
      )
      expect(params.ExpressionAttributeValues![':0']).toEqual({
        S: '2025-12-31T00:00:00.000Z',
      })
    })

    test('drops source and target from the data', async () => {
      await upsert('Job', 'sendEmail#uuid-1', 'JobExecution', '2026-01-01T10:00:00#0001', {
        source: 'Job#other',
        target: 'JobExecution#other',
        status: 'running',
      })

      const params = sentParams()
      expect(Object.values(params.ExpressionAttributeNames!)).toEqual([
        'createdAt',
        'status',
        'updatedAt',
      ])
      expect(params.Key).toEqual({
        source: { S: 'Job#sendEmail#uuid-1' },
        target: { S: 'JobExecution#2026-01-01T10:00:00#0001' },
      })
    })

    test('keysToDelete go into REMOVE', async () => {
      await upsert(
        'Job',
        'sendEmail#uuid-1',
        'JobExecution',
        '2026-01-01T10:00:00#0001',
        { status: 'completed' },
        ['error']
      )

      const params = sentParams()
      expect(params.UpdateExpression).toBe(
        'SET #0 = if_not_exists(#0, :0), #1 = :1, #2 = :2 REMOVE #3'
      )
      expect(params.ExpressionAttributeNames!['#3']).toBe('error')
    })

    test('returns the unmarshalled Attributes', async () => {
      client.updateItem.mockResolvedValue({
        Attributes: { status: { S: 'running' }, attempt: { N: '1' } },
      })

      const result = await upsert(
        'Job',
        'sendEmail#uuid-1',
        'JobExecution',
        '2026-01-01T10:00:00#0001',
        { status: 'running' }
      )

      expect(result as unknown).toEqual({ status: 'running', attempt: 1 })
    })
  })
})
