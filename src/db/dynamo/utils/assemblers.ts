import type { BaseRelationDynamoDB } from '../types.js'

const getId = (key: string) => key.substring(key.indexOf('#') + 1)

export const createEntityKey = (entityType: string, id: string): string =>
  `${entityType}#${id}`

export const getTargetId = (entity: BaseRelationDynamoDB): string =>
  getId(entity.target)

export const getTargetIds = (entities: BaseRelationDynamoDB[]): string[] =>
  entities.map(getTargetId)
