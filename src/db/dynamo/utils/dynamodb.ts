import {
  ConditionalCheckFailedException,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import * as dynamoUtils from '@aws-sdk/util-dynamodb'

const marshallOptions = {
  convertEmptyValues: true,
  removeUndefinedValues: true,
  convertClassInstanceToMap: false,
}

const unmarshallOptions = {
  wrapNumbers: false,
}

export const marshall = (data: unknown) =>
  dynamoUtils.marshall(data, marshallOptions)

export const unmarshall = <T extends object = Record<string, unknown>>(
  data?: Record<string, AttributeValue>
) => (data ? dynamoUtils.unmarshall(data, unmarshallOptions) : {}) as T

/**
 * Filters the keys that go into an update expression.
 *
 * Drops only `undefined`, in line with what the item builders do when marshalling: since
 * `marshallOptions.removeUndefinedValues` is `true`, an `undefined` key would disappear
 * from `ExpressionAttributeValues` but stay in the `UpdateExpression`, breaking the call.
 * Every other value is written, including `false` and `0`. To remove an attribute, use
 * `keysToDelete`.
 */
export const getKeysToUpdate = (data: Record<string, unknown>) =>
  Object.keys(data).filter((key) => data[key] !== undefined)

/**
 * Identifies the DynamoDB condition failure. The `name` covers the error coming from
 * another copy of the SDK, where `instanceof` does not match.
 *
 * @param error - Error caught from the operation
 * @returns Whether the error is a condition failure
 */
export const isConditionalCheckFailure = (error: unknown) =>
  error instanceof ConditionalCheckFailedException ||
  (error as { name?: string } | null)?.name ===
    'ConditionalCheckFailedException'
