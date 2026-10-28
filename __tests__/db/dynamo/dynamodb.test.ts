import { describe, expect, test } from 'bun:test'
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'
import {
  getKeysToUpdate,
  isConditionalCheckFailure,
  marshall,
  unmarshall,
} from '../../../src/db/dynamo/utils/dynamodb.js'

describe('db/dynamo/utils/dynamodb', () => {
  describe('marshall', () => {
    test('converts values to AttributeValue', () => {
      expect(
        marshall({ s: 'text', n: 42, b: false, l: [1], m: { x: 'y' } })
      ).toEqual({
        s: { S: 'text' },
        n: { N: '42' },
        b: { BOOL: false },
        l: { L: [{ N: '1' }] },
        m: { M: { x: { S: 'y' } } },
      })
    })

    test('removes undefined values', () => {
      expect(marshall({ a: 'x', b: undefined })).toEqual({ a: { S: 'x' } })
    })

    test('converts empty string to NULL', () => {
      expect(marshall({ a: '' })).toEqual({ a: { NULL: true } })
    })
  })

  describe('unmarshall', () => {
    test('converts AttributeValue to plain values', () => {
      expect(
        unmarshall({ s: { S: 'text' }, n: { N: '42' }, b: { BOOL: true } })
      ).toEqual({ s: 'text', n: 42, b: true })
    })

    test('without data: returns empty object', () => {
      expect(unmarshall(undefined)).toEqual({})
    })
  })

  describe('getKeysToUpdate', () => {
    test('drops only undefined keys', () => {
      expect(
        getKeysToUpdate({ a: 'x', b: undefined, c: false, d: 0, e: null, f: '' })
      ).toEqual(['a', 'c', 'd', 'e', 'f'])
    })
  })

  describe('isConditionalCheckFailure', () => {
    test('recognizes the SDK exception by instance', () => {
      const err = new ConditionalCheckFailedException({
        message: 'The conditional request failed',
        $metadata: {},
      })

      expect(isConditionalCheckFailure(err)).toBe(true)
    })

    test('recognizes the error by name, for another copy of the SDK', () => {
      const err = Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      })

      expect(isConditionalCheckFailure(err)).toBe(true)
    })

    test('other errors: false', () => {
      expect(isConditionalCheckFailure(new Error('Entity not found'))).toBe(false)
      expect(
        isConditionalCheckFailure(
          Object.assign(new Error('throttled'), {
            name: 'ProvisionedThroughputExceededException',
          })
        )
      ).toBe(false)
    })

    test('value that is not an error: false', () => {
      expect(isConditionalCheckFailure(null)).toBe(false)
      expect(isConditionalCheckFailure(undefined)).toBe(false)
      expect(isConditionalCheckFailure('ConditionalCheckFailedException')).toBe(false)
    })
  })
})
