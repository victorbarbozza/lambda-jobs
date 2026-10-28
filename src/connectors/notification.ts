import type { JobAlert } from '../types/alert.js'
import { getScope } from '../utils/scope.js'
import { formatAlert } from './messages.js'

/**
 * Delivers the alert to the `onAlert` given to `jobWrapper` or `jobWatchdog`.
 *
 * Without `onAlert`, the alert is only logged in JSON, because there is nowhere to send
 * it.
 *
 * Notification failures are best effort: they are logged, but never break the main flow.
 */
export const sendNotification = async (alert: JobAlert): Promise<void> => {
  const { onAlert } = getScope()

  if (!onAlert) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: '[jobs-notification] onAlert not set, alert logged only',
        alert: alert.type,
        text: formatAlert(alert),
      })
    )
    return
  }

  try {
    await onAlert(alert)
  } catch (err) {
    console.error('[jobs-notification] Failed to send alert:', err)
  }
}
