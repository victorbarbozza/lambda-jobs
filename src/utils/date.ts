import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import type { DelayConfig } from '../types/schedule.js'

dayjs.extend(utc)

/** Instance with the UTC plugin already applied, so modules don't repeat the `extend`. */
export { dayjs }

export const utcNow = (): number => dayjs.utc().valueOf()

/** Formats in the shape EventBridge accepts in `at(...)`: `YYYY-MM-DDTHH:mm:ss`. */
export const formatDateToUTC = (date: string): string =>
  dayjs.utc(date).format('YYYY-MM-DDTHH:mm:ss')

export const isValidDate = (date: string): boolean => dayjs.utc(date).isValid()

export const isPastDate = (date: string): boolean =>
  dayjs.utc(date).isBefore(dayjs.utc())

/** ISO instant `delay` from now. */
export const resolveDelayToDate = (delay: DelayConfig): string =>
  dayjs.utc().add(delay.value, delay.unit).toISOString()

/** Duration of `delay` in milliseconds. */
export const delayToMs = (delay: DelayConfig): number =>
  dayjs.utc(0).add(delay.value, delay.unit).valueOf()
