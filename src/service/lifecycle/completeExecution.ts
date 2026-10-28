import * as db from '../../db/entities.js'
import type { JobEvent } from '../../types/event.js'
import type { ExecutionPolicy } from '../../types/job.js'
import { utcNow } from '../../utils/date.js'
import { isExpired, isOnce } from '../../utils/schedule.js'
import { nextOccurrenceDeadline } from '../deadline.js'
import { closeJob, type ExecutionContext } from './shared.js'

/**
 * Closes a successful attempt.
 *
 * The job turns terminal when it is a one-off or when the recurring schedule has already
 * expired. On a recurring job still active, the deadline now points to the next
 * occurrence.
 */
export const completeExecution = async (
  event: JobEvent,
  ctx: ExecutionContext,
  policy?: ExecutionPolicy
): Promise<void> => {
  await db.upsertExecution(event.id, {
    ...ctx.execution,
    status: 'completed',
    completedAt: utcNow(),
  })

  if (isOnce(ctx.jobEntity.schedule) || isExpired(ctx.jobEntity.schedule)) {
    await closeJob(event.id, 'completed', ctx.deadline)
    return
  }

  await db.moveDeadline(
    event.id,
    ctx.deadline,
    await nextOccurrenceDeadline(ctx.jobEntity, policy?.deadlineToleranceSeconds),
    { nextRetryAt: undefined }
  )
}
