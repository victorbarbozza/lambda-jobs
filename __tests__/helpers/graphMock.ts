import { mock, vi } from 'bun:test'
import * as realGraph from '../../src/db/dynamo/index.js'

/**
 * Mock of the graph client used by `src/db/entities`.
 *
 * Must be registered before the module under test is evaluated, so `mock.module` runs
 * in the body of this file: whoever imports this helper first makes sure `entities` sees
 * the mock, and not the real lib.
 */
export const graphCommands = {
  createEntityTransactBatch: vi.fn(),
  createRelationTransactBatch: vi.fn(),
  deleteRelationTransactBatch: vi.fn(),
  queryRelationsInRange: vi.fn(),
  sendCommandTransactWriteBatch: vi.fn(),
  getEntity: vi.fn(),
  updateEntityField: vi.fn(),
  upsertRelationField: vi.fn(),
  getAllRelationsWhithPrefix: vi.fn(),
  deleteEntity: vi.fn(),
  deleteRelation: vi.fn(),
}

export const createRawGraphCommands = vi.fn(() => graphCommands)
export const getTargetIds = vi.fn(() => ['sendEmail#uuid-1'])
export const getTargetId = vi.fn(
  (relation: { target: string }) => relation.target.split('#').slice(1).join('#')
)

export const registerGraphMock = (): void => {
  mock.module('../../src/db/dynamo/index.js', () => ({
    ...realGraph,
    createRawGraphCommands,
    getTargetId,
    getTargetIds,
  }))
}

registerGraphMock()
