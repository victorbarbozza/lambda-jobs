/** Source of the partition that holds the deadlines still open. */
export const PENDING_SOURCE_ID = 'open'

/** Entity types stored in the jobs table. */
export enum EntityType {
  /** Main job record, with status, schedule, payload and metadata. */
  Job = 'Job',
  /** Groups the jobs created from a `jobSource`. */
  JobSource = 'JobSource',
  /** A single execution attempt, identified by `scheduledTime` and `attempt`. */
  JobExecution = 'JobExecution',
  /** Groups the occurrences whose delivery is still expected. */
  PendingJob = 'PendingJob',
  /**
   * Deadline of an occurrence, with the expected instant at the start of the key.
   *
   * ISO 8601 sorts lexicographically, which keeps the partition sorted by time and lets
   * the watchdog query only the overdue ones.
   */
  Deadline = 'Deadline',
}

/** Occurrence whose delivery is past its deadline, as returned by the watchdog query. */
export interface OverdueJob {
  jobId: string
  /** ISO instant by which the delivery was expected. */
  deadline: string
}
