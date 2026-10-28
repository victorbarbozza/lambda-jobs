# Changelog

## 0.1.0

First version.

- `createJobScheduler`, `jobWrapper` and `jobWatchdog`.
- `JobsConfig`, with `JOB_TABLE_NAME`, `JOB_SCHEDULE_GROUP`, `JOB_ROLE_ARN` and
  `AWS_REGION` as fallback.
- `onAlert` with `JobAlert`, and `formatAlert` to turn an alert into text.
