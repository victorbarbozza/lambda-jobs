import type { MiddlewareObj } from '@middy/core'
import middyValidator from '@middy/validator'
import { transpileSchema } from '@middy/validator/transpile'
import { Type, type TSchema } from 'typebox'
import type { JobEvent } from '../../types/event.js'

/**
 * Validates the whole `JobEvent` before the handler runs.
 *
 * When `payloadSchema` is given, it is composed at runtime into the structural schema of
 * the event, validating envelope and payload in a single step.
 */
export const validateJobEventMiddleware = <T = unknown>(
  payloadSchema?: TSchema
): MiddlewareObj<JobEvent<T>, unknown> =>
  middyValidator({
    eventSchema: transpileSchema(buildJobEventSchema(payloadSchema)),
  })

/** Builds the full event schema expected by the wrapper, including the typed payload. */
const buildJobEventSchema = (payloadSchema?: TSchema): TSchema =>
  Type.Object(
    {
      id: Type.String(),
      name: Type.String(),
      jobSource: Type.String(),
      payload: payloadSchema ?? Type.Object({}),
      scheduledTime: Type.String(),
      attempt: Type.Number({ minimum: 1 }),
      maxRetryAttempts: Type.Number({ minimum: 0 }),
      schedulerExecutionId: Type.Optional(Type.String()),
    },
    { additionalProperties: false }
  )
