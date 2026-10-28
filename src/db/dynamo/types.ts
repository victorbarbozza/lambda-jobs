export type unknownEntity = Record<string, unknown>

export type BaseEntity<T = unknownEntity> = T & {
  relation?: string
  createdAt: string // ISO string
  updatedAt?: string // ISO string
}

export type BaseRelationDynamoDB<T = unknownEntity> = BaseEntity<T> & {
  source: string
  target: string
}

export type BaseEntityDynamoDB<T = unknownEntity> = BaseRelationDynamoDB<T> & {
  id: string
}
