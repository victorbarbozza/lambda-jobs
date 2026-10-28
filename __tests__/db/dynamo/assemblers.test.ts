import { describe, expect, test } from 'bun:test'
import {
  createEntityKey,
  getTargetId,
  getTargetIds,
} from '../../../src/db/dynamo/utils/assemblers.js'

const relation = (target: string) => ({
  source: 'JobSource#user#123',
  target,
  createdAt: '2026-01-01T10:00:00.000Z',
})

describe('db/dynamo/utils/assemblers', () => {
  test('createEntityKey joins type and id with #', () => {
    expect(createEntityKey('Job', 'sendEmail#uuid-1')).toBe('Job#sendEmail#uuid-1')
  })

  test('getTargetId drops only the type prefix of the target', () => {
    expect(
      getTargetId(relation('Deadline#2026-01-01T10:00:00.000Z#sendEmail#uuid-1'))
    ).toBe('2026-01-01T10:00:00.000Z#sendEmail#uuid-1')
  })

  test('getTargetIds returns the target id of each relation', () => {
    expect(
      getTargetIds([relation('Job#sendEmail#uuid-1'), relation('Job#sendSms#uuid-2')])
    ).toEqual(['sendEmail#uuid-1', 'sendSms#uuid-2'])
  })

  test('getTargetIds without relations: empty list', () => {
    expect(getTargetIds([])).toEqual([])
  })
})
