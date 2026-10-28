import { beforeEach, describe, expect, test, vi } from 'bun:test'
import type { DynamoDB, QueryCommandInput } from '@aws-sdk/client-dynamodb'
import {
  getAllRelationsWhithPrefix,
  getEntity,
  queryRelationsInRange,
} from '../../../src/db/dynamo/commands/get.js'

const TABLE = 'jobs-test-table'

const client = {
  getItem: vi.fn(),
  query: vi.fn(),
}
const dynamoDB = client as unknown as DynamoDB

/** Params of each `query` call, copied because the pagination reuses the same object. */
const queryCalls: QueryCommandInput[] = []

describe('db/dynamo/commands/get', () => {
  beforeEach(() => {
    client.getItem.mockReset()
    client.query.mockReset()
    queryCalls.length = 0
  })

  /** Each call to `query` answers the next page of the list. */
  const answerPages = (
    pages: { Items?: Record<string, unknown>[]; LastEvaluatedKey?: unknown }[]
  ) => {
    let call = 0
    client.query.mockImplementation(async (params: QueryCommandInput) => {
      queryCalls.push({ ...params })
      return pages[call++]
    })
  }

  describe('getEntity', () => {
    test('reads the item with source and target equal to the entity key', async () => {
      client.getItem.mockResolvedValue({ Item: { id: { S: 'sendEmail#uuid-1' } } })

      await getEntity(TABLE, dynamoDB)('Job', 'sendEmail#uuid-1')

      expect(client.getItem).toHaveBeenCalledWith({
        TableName: TABLE,
        Key: {
          source: { S: 'Job#sendEmail#uuid-1' },
          target: { S: 'Job#sendEmail#uuid-1' },
        },
      })
    })

    test('returns the unmarshalled item', async () => {
      client.getItem.mockResolvedValue({
        Item: {
          id: { S: 'sendEmail#uuid-1' },
          source: { S: 'Job#sendEmail#uuid-1' },
          target: { S: 'Job#sendEmail#uuid-1' },
          maxRetryAttempts: { N: '3' },
          createdAt: { S: '2026-01-01T10:00:00.000Z' },
        },
      })

      const result = await getEntity(TABLE, dynamoDB)('Job', 'sendEmail#uuid-1')

      expect(result).toEqual({
        id: 'sendEmail#uuid-1',
        source: 'Job#sendEmail#uuid-1',
        target: 'Job#sendEmail#uuid-1',
        maxRetryAttempts: 3,
        createdAt: '2026-01-01T10:00:00.000Z',
      })
    })

    test('without Item: returns null', async () => {
      client.getItem.mockResolvedValue({})

      expect(await getEntity(TABLE, dynamoDB)('Job', 'sendEmail#uuid-1')).toBeNull()
    })
  })

  describe('getAllRelationsWhithPrefix', () => {
    test('queries the partition of the entity with begins_with on the target', async () => {
      answerPages([{ Items: [] }])

      await getAllRelationsWhithPrefix(TABLE, dynamoDB)(
        'Job',
        'sendEmail#uuid-1',
        'JobExecution#'
      )

      expect(queryCalls).toEqual([
        {
          TableName: TABLE,
          KeyConditionExpression: '#pk = :pk AND begins_with(#prefix, :prefix)',
          ExpressionAttributeNames: { '#pk': 'source', '#prefix': 'target' },
          ExpressionAttributeValues: {
            ':pk': { S: 'Job#sendEmail#uuid-1' },
            ':prefix': { S: 'JobExecution#' },
          },
          ExclusiveStartKey: undefined,
        },
      ])
    })

    test('reads pages until LastEvaluatedKey is empty', async () => {
      const firstKey = { source: { S: 'Job#sendEmail#uuid-1' }, target: { S: 'a' } }
      const secondKey = { source: { S: 'Job#sendEmail#uuid-1' }, target: { S: 'b' } }
      answerPages([
        { Items: [{ target: { S: 'a' } }], LastEvaluatedKey: firstKey },
        { Items: [{ target: { S: 'b' } }], LastEvaluatedKey: secondKey },
        { Items: [{ target: { S: 'c' } }] },
      ])

      const result = await getAllRelationsWhithPrefix(TABLE, dynamoDB)(
        'Job',
        'sendEmail#uuid-1',
        'JobExecution#'
      )

      expect(queryCalls.map((params) => params.ExclusiveStartKey)).toEqual([
        undefined,
        firstKey,
        secondKey,
      ])
      expect(result as unknown).toEqual([
        { target: 'a' },
        { target: 'b' },
        { target: 'c' },
      ])
    })

    test('page without Items: continues to the next one', async () => {
      const firstKey = { source: { S: 'Job#sendEmail#uuid-1' }, target: { S: 'a' } }
      answerPages([
        { LastEvaluatedKey: firstKey },
        { Items: [{ target: { S: 'b' } }] },
      ])

      const result = await getAllRelationsWhithPrefix(TABLE, dynamoDB)(
        'Job',
        'sendEmail#uuid-1',
        'JobExecution#'
      )

      expect(client.query).toHaveBeenCalledTimes(2)
      expect(result as unknown).toEqual([{ target: 'b' }])
    })
  })

  describe('queryRelationsInRange', () => {
    const query = (
      range?: { from?: string; to?: string },
      options?: Parameters<ReturnType<typeof queryRelationsInRange>>[3]
    ) => queryRelationsInRange(TABLE, dynamoDB)('PendingJob', 'open', range, options)

    beforeEach(() => {
      answerPages([{ Items: [] }])
    })

    test('with from and to: BETWEEN', async () => {
      await query({ from: 'Deadline#a', to: 'Deadline#b' })

      expect(queryCalls[0]).toMatchObject({
        TableName: TABLE,
        KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
        ExpressionAttributeNames: { '#pk': 'source', '#sk': 'target' },
        ExpressionAttributeValues: {
          ':pk': { S: 'PendingJob#open' },
          ':from': { S: 'Deadline#a' },
          ':to': { S: 'Deadline#b' },
        },
      })
    })

    test('only from: >=', async () => {
      await query({ from: 'Deadline#a' })

      expect(queryCalls[0]).toMatchObject({
        KeyConditionExpression: '#pk = :pk AND #sk >= :from',
        ExpressionAttributeNames: { '#pk': 'source', '#sk': 'target' },
        ExpressionAttributeValues: {
          ':pk': { S: 'PendingJob#open' },
          ':from': { S: 'Deadline#a' },
        },
      })
    })

    test('only to: <=', async () => {
      await query({ to: 'Deadline#b' })

      expect(queryCalls[0]).toMatchObject({
        KeyConditionExpression: '#pk = :pk AND #sk <= :to',
        ExpressionAttributeNames: { '#pk': 'source', '#sk': 'target' },
        ExpressionAttributeValues: {
          ':pk': { S: 'PendingJob#open' },
          ':to': { S: 'Deadline#b' },
        },
      })
    })

    test('without range: the whole partition', async () => {
      await query()

      expect(queryCalls[0]).toMatchObject({
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'source' },
        ExpressionAttributeValues: { ':pk': { S: 'PendingJob#open' } },
      })
    })

    test('empty range: the whole partition', async () => {
      await query({})

      expect(queryCalls[0]).toMatchObject({
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'source' },
        ExpressionAttributeValues: { ':pk': { S: 'PendingJob#open' } },
      })
    })

    test('ScanIndexForward is true by default', async () => {
      await query()

      expect(queryCalls[0]!.ScanIndexForward).toBe(true)
    })

    test('ascending: false reads in descending order', async () => {
      await query(undefined, { ascending: false })

      expect(queryCalls[0]!.ScanIndexForward).toBe(false)
    })

    test('passes limit and nextPageToken as Limit and ExclusiveStartKey', async () => {
      const nextPageToken = { source: { S: 'PendingJob#open' }, target: { S: 'x' } }

      await query(undefined, { limit: 50, nextPageToken })

      expect(queryCalls[0]).toMatchObject({ Limit: 50, ExclusiveStartKey: nextPageToken })
    })

    test('reads a single page and returns LastEvaluatedKey as nextPageToken', async () => {
      const lastKey = { source: { S: 'PendingJob#open' }, target: { S: 'x' } }
      answerPages([
        { Items: [{ target: { S: 'Deadline#a' } }], LastEvaluatedKey: lastKey },
      ])

      const page = await query()

      expect(client.query).toHaveBeenCalledTimes(1)
      expect(page as unknown).toEqual({
        items: [{ target: 'Deadline#a' }],
        nextPageToken: lastKey,
      })
    })

    test('without Items: empty list', async () => {
      answerPages([{}])

      expect(await query()).toEqual({ items: [], nextPageToken: undefined })
    })
  })
})
