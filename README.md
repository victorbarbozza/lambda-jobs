# lambda-jobs

Job scheduling for AWS Lambda with EventBridge Scheduler: persisted state, retries with
backoff and a watchdog that alerts when a delivery does not happen.

```ts
const jobs = createJobScheduler({ sendEmail: { maxRetryAttempts: 3 } }, config)

await jobs.createJob('sendEmail', 'user#123', { to: 'a@b.com' })
```

---

## Contents

**Using**

- [Installation](#installation)
- [The three pieces](#the-three-pieces)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Alerts](#alerts)
- [AWS infrastructure](#aws-infrastructure)
- [Defining a job](#defining-a-job)
- [Schedules](#schedules)
- [The scheduler API](#the-scheduler-api)
- [Writing the handler](#writing-the-handler)
- [Retries and terminal failure](#retries-and-terminal-failure)
- [The watchdog](#the-watchdog)
- [Querying state](#querying-state)
- [Types](#types)
- [Errors](#errors)
- [Recipes](#recipes)
- [Known limits](#known-limits)

**How it works inside**

- [Why retries are rescheduling](#why-retries-are-rescheduling)
- [Hard timeout and the role of the watchdog](#hard-timeout-and-the-role-of-the-watchdog)
- [What the library reads from executions](#what-the-library-reads-from-executions)
- [How the deadline is stored](#how-the-deadline-is-stored)
- [Idempotency](#idempotency)

---

# Using

## Installation

```bash
bun add lambda-jobs
```

With npm: `npm install lambda-jobs`.

Requires Node.js 24 or later.

`@aws-sdk/client-dynamodb`, `@aws-sdk/util-dynamodb` and `@aws-sdk/client-scheduler` are
peer dependencies: bun, npm and pnpm install them with the package, and the Lambda
Node.js runtime already includes them, so your bundle can leave them out. With Yarn, add
them yourself.

To validate the payload with `eventSchema`, also add `typebox` (`bun add typebox`).

## The three pieces

| Piece | Where it runs | What for |
|-------|---------------|----------|
| `createJobScheduler(definitions, config?)` | any Lambda of the application | create, cancel and query jobs |
| `jobWrapper(handler, options?)` | the Lambda of each job | run the job with lifecycle and retries |
| `jobWatchdog(definitions, options?)` | one recurring Lambda per service | detect deliveries that did not happen |

The three create schedules (the job, its retries and the re-run by the watchdog), so the
three need the same configuration.

## Quick start

### 1. Declare the jobs and the config

Keep the definitions and the config in one module. The three pieces import it.

```ts
// jobs.ts
import type { JobDefinitions, JobsConfig } from 'lambda-jobs'

export const definitions = {
  sendEmail: {
    maxRetryAttempts: 5,
    retryDelay: (attempt: number) => Math.min(30 * 2 ** attempt, 3600),
    failureStrategy: { action: 'cancel', alert: true },
  },
  purgeExpired: {
    schedule: { rate: { value: 1, unit: 'hours' } },
  },
} satisfies JobDefinitions

export const config: JobsConfig = {
  functionArn: (jobName) => `${process.env.ORDERS_FUNCTION_ARN_PREFIX}${jobName}`,
}
```

`ORDERS_FUNCTION_ARN_PREFIX` is a variable of your application, not of the library, for
example `arn:aws:lambda:us-east-1:123456789012:function:acme-orders-prod-`. The table, the
group, the role and the region come from the environment variables in
[Configuration](#configuration).

### 2. Create the job handler

Each job has its own Lambda. With the config above, `sendEmail` runs in
`acme-orders-prod-sendEmail`.

```ts
// handlers/sendEmail.ts
import { Type } from 'typebox'
import { jobWrapper, type JobEvent } from 'lambda-jobs'
import { config, definitions } from '../jobs'

interface EmailPayload {
  to: string
  subject: string
}

export const handler = jobWrapper<EmailPayload>(
  async (job: JobEvent<EmailPayload>, ctx) => {
    ctx.log.info('sending', { to: job.payload.to })
    await emailService.send(job.payload.to, job.payload.subject)
    return { sent: true }
  },
  {
    config,
    definition: definitions.sendEmail,
    eventSchema: Type.Object({
      to: Type.String({ format: 'email' }),
      subject: Type.String(),
    }),
  }
)
```

### 3. Create the watchdog handler

```ts
// handlers/watchdog.ts
import { jobWatchdog } from 'lambda-jobs'
import { config, definitions } from '../jobs'

export const handler = jobWatchdog(definitions, { config })
```

Point a `rate(5 minutes)` schedule at this Lambda. Without it, a lost delivery goes
unnoticed.

### 4. Create a job

```ts
import { createJobScheduler } from 'lambda-jobs'
import { config, definitions } from './jobs'

const jobs = createJobScheduler(definitions, config)

const id = await jobs.createJob(
  'sendEmail',
  'user#123',
  { to: 'user@example.com', subject: 'Welcome' },
  { delay: { value: 10, unit: 'minutes' } }
)
```

## Configuration

### `JobsConfig` and environment variables

`createJobScheduler(definitions, config)`, `jobWrapper(handler, { config })` and
`jobWatchdog(definitions, { config })` accept the same `JobsConfig`. Every field is
optional and falls back to an environment variable.

| Field | Variable | Required | Description |
|-------|----------|:--------:|-------------|
| `tableName` | `JOB_TABLE_NAME` | Yes | DynamoDB table where the jobs are stored |
| `region` | `AWS_REGION` | Yes | Region of the AWS clients. Lambda sets `AWS_REGION` |
| `schedulerRoleArn` | `JOB_ROLE_ARN` | To create or delete schedules | Role the Scheduler assumes to invoke the job Lambda |
| `scheduleGroup` | `JOB_SCHEDULE_GROUP` | No | EventBridge Scheduler group. Default: `default` |
| `functionArn` | none | In `createJobScheduler`, for `createJob` and `retryNow` | `(jobName) => string` returning the full ARN of the Lambda of the job |

No client is created on import: each value is only required by the part that uses it. A
Lambda that only queries jobs needs only `JOB_TABLE_NAME` and `AWS_REGION`.

Each call reads the config of its own entry point. Two schedulers with different configs
in the same process do not mix.

### Which Lambda runs each job

Each schedule targets one Lambda ARN, resolved in this order:

1. `config.functionArn(jobName)`, when set. It wins everywhere.
2. A retry created by `jobWrapper` goes back to the Lambda that ran the attempt:
   `context.invokedFunctionArn`, without version or alias.
3. A re-run created by the watchdog (`onMissed: 'run'`) uses the ARN of the watchdog with
   the last `-` segment of the function name replaced by the job name:
   `acme-orders-prod-watchdog` becomes `acme-orders-prod-sendEmail`. A name without `-`
   is replaced whole.
4. `createJobScheduler` has nothing to derive from. There, `createJob` and `retryNow`
   throw `JobConfigError` without `functionArn`.

A `createJobScheduler` called inside a job handler is no exception: it runs with its own
config and does not see the ARN of the wrapper. `cancelJob`, the queries and `diagnose`
do not need `functionArn`.

Set `functionArn` in the shared config, and the wrapper and the watchdog use it too.

## Alerts

`jobWrapper` and `jobWatchdog` accept `onAlert`. The library calls it with a `JobAlert`:

```ts
type JobAlert =
  | { type: 'job_failed'; job: JobEvent; errors: JobErrorRecord[] }
  | { type: 'internal_error'; stage: string; error: Error }
  | { type: 'overdue'; job: Job; reason: OverdueReason; deadline: string; action: OverdueAction }
  | { type: 'custom'; message: string }

type OnAlertFn = (alert: JobAlert) => Promise<void> | void
```

- `job_failed`: an occurrence ran out of attempts and the job has
  `failureStrategy.alert: true`. `errors` holds the failures of that occurrence.
- `internal_error`: the wrapper or the lifecycle failed (table, schedule), or a callback of
  `jobWrapper` threw. `stage` names the step: `startExecution`, `completeExecution`,
  `failExecution`, `finishJob` or the name of the callback.
- `overdue`: the watchdog found an occurrence past its deadline. `action` says what it
  did.
- `custom`: a message sent with the `alert` argument of `onJobFailure` or
  `onInternalError`.

`formatAlert(alert)` returns any alert as plain text.

Example that posts the text to a webhook:

```ts
// jobs.ts
import { formatAlert, type JobAlert } from 'lambda-jobs'

export const onAlert = async (alert: JobAlert) => {
  const response = await fetch(process.env.ALERT_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: formatAlert(alert) }),
  })

  if (!response.ok) throw new Error(`Alert webhook returned ${response.status}`)
}
```

Pass the same `onAlert` to the wrapper and the watchdog:

```ts
// handlers/sendEmail.ts
export const handler = jobWrapper(handlerFn, { config, onAlert })

// handlers/watchdog.ts
export const handler = jobWatchdog(definitions, { config, onAlert })
```

Without `onAlert`, the alert is only logged with `console.warn`, as one JSON line. `text`
is the output of `formatAlert`:

```json
{"level":"warn","message":"[jobs-notification] onAlert not set, alert logged only","alert":"job_failed","text":"Job failed after exhausting all attempts\n..."}
```

Alerts are best effort. A failure inside `onAlert` is logged with `console.error` and
never changes the result of the job. `createJobScheduler` raises no alerts and takes no
`onAlert`.

## AWS infrastructure

Besides the configuration, the infrastructure needs the resources below. The library
creates schedules and items in them, but does not create them.

- **DynamoDB table.** Partition key `source` (String), sort key `target` (String), no
  secondary index. TTL enabled on the `ttl` attribute. Only executions of jobs with
  `executionRetentionDays` get a `ttl`, so without retention nothing expires.
- **Schedule group** in EventBridge Scheduler. Any group, given in `JOB_SCHEDULE_GROUP`,
  or the `default` group that every account has.
- **Scheduler role**, given in `JOB_ROLE_ARN`. Its trust policy allows
  `scheduler.amazonaws.com`. Its policy allows `lambda:InvokeFunction` on the job
  Lambdas.
- **Watchdog Lambda**, triggered by an EventBridge Scheduler schedule with
  `rate(5 minutes)`.

| Who | Needs |
|-----|-------|
| Lambda that creates or cancels jobs | table read and write; `scheduler:CreateSchedule` and `scheduler:DeleteSchedule` on the group; `iam:PassRole` on the scheduler role |
| Lambda that runs the job | the same — each retry is a new schedule, and closing a job deletes its schedule |
| Watchdog Lambda | the same as the job Lambda |
| Lambda that only queries jobs | table read |
| Scheduler role | `lambda:InvokeFunction` on the job Lambdas, and on the watchdog if its schedule uses the same role |

Table read is `dynamodb:GetItem` and `dynamodb:Query`. Table write is `dynamodb:PutItem`,
`dynamodb:UpdateItem` and `dynamodb:DeleteItem`, also used inside transactions.

### Example with AWS CDK

```ts
import * as cdk from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'
import * as scheduler from 'aws-cdk-lib/aws-scheduler'
import type { Construct } from 'constructs'

export class OrdersJobsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const prefix = 'acme-orders-prod'
    const groupName = `${prefix}-jobs`
    const functionArnPrefix =
      `arn:${this.partition}:lambda:${this.region}:${this.account}:function:${prefix}-`

    // Partition key `source`, sort key `target`, TTL on `ttl`, no index
    const table = new dynamodb.TableV2(this, 'JobsTable', {
      partitionKey: { name: 'source', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'target', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    })

    // Leave it out and set no JOB_SCHEDULE_GROUP to use the `default` group
    new scheduler.CfnScheduleGroup(this, 'JobsGroup', { name: groupName })

    // Role the Scheduler assumes to invoke the job Lambdas and the watchdog
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    })
    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [`${functionArnPrefix}*`],
      })
    )

    const environment = {
      JOB_TABLE_NAME: table.tableName,
      JOB_SCHEDULE_GROUP: groupName,
      JOB_ROLE_ARN: schedulerRole.roleArn,
      // Read by `config.functionArn` in jobs.ts, not by the library
      ORDERS_FUNCTION_ARN_PREFIX: functionArnPrefix,
    }

    // Table, schedules in the group and PassRole on the scheduler role
    const grantJobs = (fn: lambda.IFunction) => {
      table.grantReadWriteData(fn)
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule'],
          resources: [
            `arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule/${groupName}/*`,
          ],
        })
      )
      schedulerRole.grantPassRole(fn.grantPrincipal)
    }

    const jobsFunction = (name: string, timeout: cdk.Duration) => {
      const fn = new nodejs.NodejsFunction(this, name, {
        functionName: `${prefix}-${name}`,
        entry: `src/handlers/${name}.ts`,
        runtime: lambda.Runtime.NODEJS_24_X,
        timeout,
        environment,
      })
      grantJobs(fn)
      return fn
    }

    // One Lambda per job, named `${prefix}-${jobName}`
    jobsFunction('sendEmail', cdk.Duration.minutes(1))
    jobsFunction('purgeExpired', cdk.Duration.minutes(5))

    // The Lambda that creates jobs
    jobsFunction('api', cdk.Duration.seconds(30))

    // The watchdog, every 5 minutes
    const watchdog = jobsFunction('watchdog', cdk.Duration.minutes(5))

    new scheduler.CfnSchedule(this, 'WatchdogSchedule', {
      scheduleExpression: 'rate(5 minutes)',
      flexibleTimeWindow: { mode: 'OFF' },
      target: { arn: watchdog.functionArn, roleArn: schedulerRole.roleArn },
    })
  }
}
```

With this naming, the watchdog finds the job Lambdas even without `functionArn`.

`NodejsFunction` leaves `@aws-sdk/*` out of the bundle by default and uses the SDK of the
runtime, which matches the peer dependencies.

### The same as IAM policies

For setups without CDK. The examples use region `us-east-1`, account `123456789012`, table
`acme-orders-prod-jobs`, group `acme-orders-prod-jobs` and scheduler role
`acme-orders-prod-scheduler`.

Trust policy of the scheduler role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "scheduler.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Policy of the scheduler role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "lambda:InvokeFunction",
      "Resource": "arn:aws:lambda:us-east-1:123456789012:function:acme-orders-prod-*"
    }
  ]
}
```

Policy of each Lambda that creates jobs, runs jobs or runs the watchdog:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:123456789012:table/acme-orders-prod-jobs"
    },
    {
      "Effect": "Allow",
      "Action": ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"],
      "Resource": "arn:aws:scheduler:us-east-1:123456789012:schedule/acme-orders-prod-jobs/*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::123456789012:role/acme-orders-prod-scheduler"
    }
  ]
}
```

With the `default` group, the scheduler resource is
`arn:aws:scheduler:us-east-1:123456789012:schedule/default/*`. A Lambda that only queries
jobs needs only `dynamodb:GetItem` and `dynamodb:Query` on the table. Each Lambda also
needs its usual CloudWatch Logs permissions.

For the watchdog, create an EventBridge Scheduler schedule with expression
`rate(5 minutes)`, target the watchdog Lambda and the scheduler role. The policy above
covers the watchdog when its name has the same prefix (`acme-orders-prod-watchdog`).

## Defining a job

Each entry of the map passed to `createJobScheduler` is a `JobDefinition`. Every field is
optional.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxRetryAttempts` | `number` | `0` | Retries after the first run. `3` means 4 runs in total. Limits: `0`–`100` |
| `retryDelay` | `(attempt) => number` | exponential backoff | Wait in seconds before attempt `attempt`. Receives the number of the attempt about to happen, starting at `2` |
| `retryMaxAgeMinutes` | `number` | `60` | Maximum age of the occurrence. Once this time has passed since `scheduledTime`, retries stop even with attempts left. Limits: `1`–`1440` |
| `failureStrategy` | `FailureStrategy` | `{ action: 'continue', alert: false }` | What to do when the attempts run out |
| `schedule` | `ScheduleOptions` | `delay` of 5 minutes | Schedule used when `createJob` receives none |
| `onMissed` | `'alert' \| 'run'` | `'alert'` | What the watchdog does with an occurrence that did not happen |
| `deadlineToleranceSeconds` | `number` | `300` | Tolerance before the watchdog considers the delivery late |
| `flexibleWindowMinutes` | `number` | `0` | Allows the Scheduler to deliver up to N minutes after the nominal time. Limits: `0`–`1440` |
| `executionRetentionDays` | `number` | never expires | Days the history of this job is kept, through TTL |

The default backoff is `30s` before the first retry and doubles on each one, capped at 1
hour.

`createJob` validates the definition and throws `JobValidationError` when a field is out
of its limits, when `retryDelay(2)` is not greater than 0 or is longer than
`retryMaxAgeMinutes`, or when `executionRetentionDays` is shorter than
`retryMaxAgeMinutes`.

### What must be repeated in `jobWrapper`

The definition is declared in the Lambda that **creates** the job; the retry is decided in
the one that **runs** it. They are different processes, and part of the configuration has
to cross over.

| Field | How it reaches the Lambda that runs the job |
|-------|---------------------------------------------|
| `maxRetryAttempts` | travels in the event |
| `retryMaxAgeMinutes`, `flexibleWindowMinutes`, `failureStrategy` | stored on the job |
| `deadlineToleranceSeconds` | `createJob` uses it for the first deadline; after that **only through the wrapper** |
| `executionRetentionDays` | **only through the wrapper** |
| **`retryDelay`** | **only through the wrapper** |

`retryDelay` is a function: it survives neither the serialization of the event nor the
write to the table. Pass the definition to the wrapper:

```ts
jobWrapper(handlerFn, { config, definition: definitions.sendEmail })
```

Without it, the job uses the default backoff and the default tolerance, silently. The
fields given there **override** the policy the job was created with.

## Schedules

Exactly one strategy per job.

```ts
{ delay: { value: 30, unit: 'minutes' } }          // once, relative to now
{ at: '2027-12-31T23:59:00Z' }                     // once, absolute instant
{ cron: '0 9 * * ? *', endDate: '2027-06-01T00:00:00Z' }        // recurring
{ rate: { value: 5, unit: 'minutes' }, endDate: '...' }         // recurring
```

`unit` accepts `minutes`, `hours` and `days`. `endDate` only makes sense on recurring
schedules.

> EventBridge Scheduler cron has **6 fields**
> (`minutes hours day-of-month month day-of-week year`), not the 5 of Unix.

`createJob` validates locally before calling AWS and throws `JobValidationError` when
`at`/`endDate` is invalid or already past, the cron does not have 6 fields, or
`delay.value`/`rate.value` is not greater than zero.

### Flexible window

`flexibleWindowMinutes` spreads the load: a thousand jobs set for midnight with a
15-minute window do not all arrive in the same second. In exchange, you no longer know
the exact instant, and the watchdog deadline widens by the same amount — with a 15-minute
window, a lost delivery takes at least 20 minutes to be detected.

For a set time (billing, reminder), leave it at `0`.

## The scheduler API

```ts
const jobs = createJobScheduler(definitions, config)
```

**Commands**

| Method | Returns | Description |
|--------|---------|-------------|
| `createJob(name, source, payload?, schedule?)` | `Promise<string>` | Creates the job and the schedule. Returns the id `{name}#{uuid}`. If scheduling fails, the job is removed and the error propagates. Needs `functionArn` |
| `cancelJob(id)` | `Promise<boolean>` | Cancels the job and removes the schedule, the deadline and the pending retry. `false` if it was already terminal or does not exist. When it does not exist, it still removes the schedule, to clean up orphans |
| `retryNow(id)` | `Promise<boolean>` | Schedules an attempt of the current occurrence in 30s, ignoring the backoff. `false` if the job is already terminal or does not exist. Needs `functionArn` |

**Queries**

| Method | Returns | Description |
|--------|---------|-------------|
| `getJob(id)` | `Promise<Job \| null>` | The stored job |
| `getJobIdsBySource(source, name?)` | `Promise<string[]>` | Ids of a source, optionally filtered by job type |
| `getLatestExecutions(jobId, limit?)` | `Promise<JobExecution[]>` | Latest attempts, newest first. `limit` defaults to `20` |
| `getOccurrenceExecutions(jobId, scheduledTime)` | `Promise<JobExecution[]>` | Every attempt of one occurrence |
| `getJobExecutions(jobId)` | `Promise<JobExecution[]>` | Full history — **no limit** |
| `getJobErrors(jobId)` | `Promise<JobErrorRecord[]>` | Only the failures of the history — **no limit** |
| `diagnose()` | `Promise<DiagnoseResult>` | Occurrences past their deadline and the reason of each, with no side effect |

The two without limit read the whole partition of the job. On a long-lived recurring job,
prefer `getLatestExecutions` for screens and `getOccurrenceExecutions` to investigate one
occurrence.

## Writing the handler

The handler receives `(job, ctx)`.

```ts
export const handler = jobWrapper<Payload>(
  async (job, ctx) => {
    ctx.log.info('processing', { attempt: ctx.attempt })

    const account = await findAccount(job.payload.accountId)
    if (!account) return ctx.giveUp('account no longer exists')

    if (await alreadyMigrated(account)) ctx.done()

    const response = await api.send(account)
    if (response.status === 429) {
      ctx.retryIn(response.retryAfter)
      throw new Error('rate limited')
    }

    return response
  },
  { config }
)
```

### `ctx`

| Member | Effect |
|--------|--------|
| `ctx.attempt` | Current attempt of the occurrence, starting at `1` |
| `ctx.isLastAttempt` | Whether no other attempt will follow this one |
| `ctx.log` | JSON logger with the job identified on every line, to filter in Logs Insights |
| `ctx.done()` | Ends the job as `completed` and removes the schedule. For a recurring job that reached its goal |
| `ctx.giveUp(reason)` | Ends the occurrence as a failure right away, without spending the remaining attempts. Applies the `failureStrategy` |
| `ctx.retryIn(seconds)` | Sets the wait before the next attempt. Only applies if the handler ends in error |

`done()` and `giveUp()` stop the handler immediately — the return type is `never`.

### `jobWrapper` options

| Option | When | Signature |
|--------|------|-----------|
| `config` | on every call | `JobsConfig`, see [Configuration](#configuration) |
| `onAlert` | on every alert | `(alert: JobAlert) => Promise<void> \| void`, see [Alerts](#alerts) |
| `eventSchema` | before the handler | TypeBox `TSchema`, validates `event.payload` |
| `definition` | when the attempt opens and when rescheduling | `ExecutionPolicy` — see [above](#what-must-be-repeated-in-jobwrapper) |
| `onSuccess` | after success | `(job, result, duration) => void` |
| `onExecutionError` | after an attempt fails | `(job, error, duration) => void` |
| `onRetry` | before the handler, if `attempt > 1` | `(job) => void` |
| `onJobFailure` | when the attempts run out | `(job, errors, alert) => void` — `errors` holds only the failures of the current occurrence |
| `onInternalError` | internal failure of the wrapper or the lifecycle | `(context, error, alert) => void` |

A callback that throws does not bring the job down: the error becomes an internal failure.
The `alert(message)` helper sends a `custom` alert to `onAlert`, best effort.

## Retries and terminal failure

When an attempt fails, the library records the `JobExecution` as `failed` and schedules
the next one after the `retryDelay` wait. Attempts stop when:

- `maxRetryAttempts` runs out
- the occurrence is older than `retryMaxAgeMinutes` since `scheduledTime`
- the handler calls `ctx.giveUp(reason)`

Then the `failureStrategy` applies:

```ts
interface FailureStrategy {
  action: 'continue' | 'cancel'
  alert: boolean
}
```

| | Effect |
|---|---|
| `action: 'continue'` | A `once` job ends as `failed`. A recurring job stays active, and the deadline points to the next occurrence |
| `action: 'cancel'` | Cancels the job and removes the schedule |
| `alert: true` | Raises a `job_failed` alert when the attempts run out. A failure in `onAlert` does not change the result of the job |

### Job status

```text
scheduled ──> active ──> completed
    │            │   └──> failed
    └────────────┴──────> cancelled
```

| Status | Meaning |
|--------|---------|
| `scheduled` | Created, waiting for the first run |
| `active` | Recurring job whose first occurrence has started |
| `completed` | Closed, no more runs expected |
| `failed` | Attempts exhausted, or the watchdog closed an occurrence past its deadline |
| `cancelled` | Cancelled explicitly |

A `once` job goes from `scheduled` straight to `completed` or `failed`. A recurring job
becomes `completed` when its `endDate` expires.

## The watchdog

Not every failure happens **inside** the handler. If the Lambda is never invoked, or dies
on a hard timeout, no line of the library runs — and nothing inside the execution can
report it.

The watchdog is one Lambda per service, triggered every 5 minutes, that scans the
occurrences whose deadline has passed:

| Reason | What happened |
|--------|---------------|
| `never_delivered` | The delivery did not reach the Lambda: function not deployed, role without permission, throttling, payload over 256KB |
| `invocation_died` | The invocation started and died without recording an outcome (hard timeout, out of memory) |
| `retry_lost` | A scheduled retry did not arrive |
| `recurrence_stalled` | The recurring job stopped firing |

In every case it raises an `overdue` alert, and the finding records in `action` what was
done:

| `action` | When |
|----------|------|
| `closed` | The job was closed as `failed`. The default, with `onMissed: 'alert'` |
| `rescheduled` | The occurrence was run again, with `onMissed: 'run'` |
| `deadline_pushed` | The job stays alive and the deadline moved to the next occurrence |

An attempt stuck in `running` is closed as `failed` with code `ERR_JOB_ABANDONED`.

`recurrence_stalled` never closes the job: one missed occurrence does not invalidate the
next ones. The deadline is **pushed**, so the alert repeats every period until someone
fixes it.

The deadline of a job already terminal is cleared silently — it is a leftover, not an
incident.

The watchdog reads `onMissed` from the definitions passed to `jobWatchdog`. A job missing
from them gets `'alert'`. For the Lambda that `onMissed: 'run'` targets, see
[Which Lambda runs each job](#which-lambda-runs-each-job).

To inspect without changing anything, `jobs.diagnose()` does the same classification with
no side effect.

> **Suggested alarm.** The library creates nothing in CloudWatch. To know whether the
> watchdog itself stopped, create an alarm on the `Invocations` metric of its Lambda with
> `treatMissingData: breaching`.

## Querying state

```ts
const job = await jobs.getJob('sendEmail#uuid')

const ids = await jobs.getJobIdsBySource('user#123')
const emailsOnly = await jobs.getJobIdsBySource('user#123', 'sendEmail')

const recent = await jobs.getLatestExecutions('sendEmail#uuid', 10)
const attempts = await jobs.getOccurrenceExecutions(
  'sendEmail#uuid',
  '2026-01-01T03:00:00Z'
)

const errors = await jobs.getJobErrors('sendEmail#uuid')
const { overdue, truncated } = await jobs.diagnose()
```

### Retention

Nothing expires by default. Retention is per job, because the answer changes by domain:

```ts
const definitions = {
  chargeSubscription: { executionRetentionDays: 1825 },
  renderPdfReport: { executionRetentionDays: 30 },
  syncCache: {},
} satisfies JobDefinitions
```

- requires TTL enabled on the `ttl` attribute of the table
- `createJob` rejects a retention shorter than the `retryMaxAgeMinutes` of the same job —
  the history would expire before the occurrence ends
- the value is resolved on the first attempt and inherited by the next ones, so the
  occurrence expires whole
- it arrives through `options.definition` of `jobWrapper`, because the Lambda that runs
  the job is the one that writes executions

## Types

### `JobEvent<T>`: what the handler receives

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Full job id, `{name}#{uuid}` |
| `name` | `string` | Job name as registered |
| `jobSource` | `string` | Business key given to `createJob` |
| `payload` | `T` | The typed payload |
| `scheduledTime` | `string` | Instant of the occurrence. The same on all of its attempts |
| `attempt` | `number` | Current attempt, starting at `1` |
| `maxRetryAttempts` | `number` | Limit configured for the job |
| `schedulerExecutionId?` | `string` | Id EventBridge assigns to the delivery, to correlate with the logs |

### `Job`: what `getJob` returns

The fields of `JobEvent` (except `scheduledTime`, `attempt` and `schedulerExecutionId`),
plus:

| Field | Type | Description |
|-------|------|-------------|
| `status` | `JobStatus` | See [job status](#job-status) |
| `schedule` | `ScheduleOptions` | The schedule it was created with |
| `failureStrategy` | `FailureStrategy` | Terminal strategy |
| `retryMaxAgeMinutes?` | `number` | Value the job was created with |
| `flexibleWindowMinutes?` | `number` | Value the job was created with |
| `lastScheduledTime?` | `string` | Last occurrence that started running |
| `nextDeadline?` | `string` | Deadline of the next expected delivery. Absent on a terminal job |
| `nextRetryAt?` | `string` | When the scheduled retry will happen |
| `completedAt?` | `number` | Instant it became terminal, in UTC ms |
| `createdAt` / `updatedAt?` | `string` | ISO dates written on each write |

### `JobExecution`: one attempt

| Field | Type | Description |
|-------|------|-------------|
| `scheduledTime` | `string` | Occurrence this attempt belongs to |
| `attempt` | `number` | Attempt number within the occurrence |
| `status` | `'running' \| 'completed' \| 'failed'` | State of the attempt |
| `startedAt` | `number` | Start, in UTC ms |
| `expiresAt` | `number` | When this invocation runs out of time. `startedAt` plus the remaining Lambda time |
| `completedAt?` | `number` | Completion, in UTC ms |
| `error?` | `ExecutionError` | `{ message, code?, stack? }` |
| `schedulerExecutionId?` | `string` | Id EventBridge assigned to the delivery |
| `ttl?` | `number` | Expiration of the record, in UTC seconds, if a retention is declared |

### `JobErrorRecord`: one failure, in the query format

`{ jobId, attempt, scheduledTime, message, code?, stack? }`

### `WatchdogResult` and `DiagnoseResult`

```ts
interface WatchdogResult {
  examined: number          // overdue deadlines examined
  findings: OverdueFinding[]
  truncated: boolean        // there were more than fit in the page
}

interface OverdueFinding {
  jobId: string
  name: string
  jobSource: string
  reason: OverdueReason     // never_delivered | invocation_died | retry_lost | recurrence_stalled
  deadline: string
  action: OverdueAction     // closed | rescheduled | deadline_pushed
}
```

`DiagnoseResult` is `{ overdue, truncated }`, with the same findings without the `action`
field — the diagnosis does not act.

For `JobsConfig` and `JobAlert`, see [Configuration](#configuration) and
[Alerts](#alerts). Every type in this README is exported from `lambda-jobs`, as are
`JobDefinition`, `JobDefinitions`, `ExecutionPolicy`, `ScheduleOptions`, `JobContext`,
`JobWrapperOptions`, `JobWatchdogOptions` and `OnAlertFn`.

## Errors

All extend `JobError` and carry a stable `code`.

| Class | `code` | When |
|-------|--------|------|
| `JobValidationError` | `ERR_JOB_VALIDATION` | Invalid definition or schedule in `createJob` |
| `JobConfigError` | `ERR_JOB_CONFIG` | Table, region or scheduler role missing, or no ARN for the Lambda of the job (see [Which Lambda runs each job](#which-lambda-runs-each-job)) |
| `JobSchedulerError` | `ERR_JOB_SCHEDULER` | Failure talking to EventBridge. Carries the original in `cause` |
| `JobError` | `ERR_JOB` | Base. Thrown directly when the delivered job does not exist |

These are internal to the wrapper — you do not need to handle them:

| Class | Role |
|-------|------|
| `JobTerminalStateError` | The occurrence must not run. The wrapper answers success and exits |
| `JobSkippedError` | The previous attempt is still alive. Refuses the duplicate delivery and answers failure |
| `JobDoneSignal` / `JobGiveUpSignal` | Signals of `ctx.done()` and `ctx.giveUp()` |

```ts
import { JobValidationError } from 'lambda-jobs'

try {
  await jobs.createJob('sendEmail', source, payload, { at: chosenDate })
} catch (err) {
  if (err instanceof JobValidationError) return badRequest(err.message)
  throw err
}
```

## Recipes

### One-off reminder, cancellable

```ts
const jobs = createJobScheduler(
  { reminder: { failureStrategy: { action: 'continue', alert: false } } },
  config
)

const jobId = await jobs.createJob('reminder', `booking#${id}`, { bookingId: id }, {
  at: booking.startsAt,
})

// the user cancelled the booking
await jobs.cancelJob(jobId)
```

### Recurring cleanup that ends by itself

```ts
const jobs = createJobScheduler(
  { migrateLegacy: { schedule: { rate: { value: 1, unit: 'hours' } } } },
  config
)

export const handler = jobWrapper(
  async (job, ctx) => {
    const batch = await nextBatch()

    if (batch.length === 0) ctx.done()   // finished: closes the recurring job

    await migrate(batch)
  },
  { config }
)
```

### Unstable API, with long backoff and `Retry-After`

```ts
const definitions = {
  syncPartner: {
    maxRetryAttempts: 8,
    retryDelay: (attempt: number) => Math.min(60 * 2 ** attempt, 3600),
    retryMaxAgeMinutes: 720,
  },
} satisfies JobDefinitions

export const handler = jobWrapper(
  async (job, ctx) => {
    const res = await partner.send(job.payload)

    if (res.status === 404) ctx.giveUp('resource removed at the partner')
    if (res.status === 429) {
      ctx.retryIn(Number(res.headers['retry-after']))
      throw new Error('rate limited by the partner')
    }

    return res
  },
  { config, definition: definitions.syncPartner }
)
```

### Billing with long audit trail and alert

```ts
const definitions = {
  charge: {
    maxRetryAttempts: 5,
    executionRetentionDays: 1825,
    onMissed: 'run',
    failureStrategy: { action: 'cancel', alert: true },
  },
} satisfies JobDefinitions

export const handler = jobWrapper(
  async (job) => billing.charge(job.payload),
  {
    config,
    onAlert,
    definition: definitions.charge,
    onJobFailure: async (job, errors, alert) => {
      await alert(
        `Charge failed: ${job.jobSource}\nLast error: ${errors.at(-1)?.message}`
      )
    },
  }
)
```

### Showing the history on a screen

```ts
const [job, attempts] = await Promise.all([
  jobs.getJob(jobId),
  jobs.getLatestExecutions(jobId, 20),
])
```

## Known limits

- **One page per watchdog pass.** Each pass handles at most 500 overdue deadlines,
  oldest first (`WATCHDOG_PAGE_SIZE` in `src/config.ts`, not configurable). The rest waits
  for the next pass. `truncated: true` in `WatchdogResult` and in `DiagnoseResult` says
  this happened. With `rate(5 minutes)`, a thousand overdue deadlines are handled in two
  passes.
- **Recurring occurrences don't wait for each other.** A `cron` or `rate` occurrence
  fires even if the previous one is still running. Use an interval longer than the
  Lambda timeout, or two occurrences can run together.
- **Retry window and recurrence.** In a recurring job, keep the total retry window
  (`retryMaxAgeMinutes`) shorter than the interval between occurrences, or a late
  occurrence runs together with the next one.

---

# How it works inside

This part is not needed to use the library. It is there to understand decisions and to
debug.

## Why retries are rescheduling

EventBridge Scheduler invokes Lambda **always asynchronously** (`InvocationType: Event`).
The `RetryPolicy` and the DLQ of the schedule only cover failures of the `Invoke`
*call*: once the call is accepted, the Scheduler considers the delivery done, whatever the
handler does next. A handler that throws causes no redelivery, does not increment
`<aws.scheduler.attempt-number>` and does not go to the DLQ.

So the library uses none of that. When the handler fails:

1. the wrapper catches the error and records the attempt as `failed`
2. it creates a **new one-time schedule** for the next attempt, carrying the original
   `scheduledTime` and the number of the next attempt
3. it returns success, so that the asynchronous retry of Lambda — limited to 2, with no
   configurable backoff — never fires

Consequences: `maxRetryAttempts` can go beyond 2, each wait is set by `retryDelay`, and
all attempts of an occurrence share the same `scheduledTime`.

The wrapper **never rethrows the handler error**: the outcome is already stored and the
next attempt already scheduled. An infrastructure error of the wrapper itself still
propagates.

## Hard timeout and the role of the watchdog

When the Lambda hits a hard timeout or the runtime dies, the invocation vanishes in the
middle of the handler: nothing is recorded and the attempt stays `running` forever.

Every expected occurrence writes a **deadline**. It is rewritten on every transition and
deleted when the job reaches a terminal state. The watchdog scans the overdue deadlines
and classifies each one by the actual state of the job and its executions.

A duplicate delivery that arrives while the previous attempt is still within its
`expiresAt` is refused with `JobSkippedError`, so the same occurrence is not processed in
parallel. An attempt past its `expiresAt` is closed as abandoned and the occurrence
continues with the next attempt.

## What the library reads from executions

Each attempt becomes a `JobExecution` keyed by `scheduledTime#attempt`. It is not
decorative history — the library reads these records to decide:

| Who reads | What for |
|-----------|----------|
| attempt start | Tell a new occurrence from a retry and compute the attempt number. The lookup is by `scheduledTime`, not by the `lastScheduledTime` of the job: on a recurring job, a late retry may arrive after the next occurrence has started |
| attempt start | Refuse a duplicate delivery while the previous one is alive, and close the one past its deadline |
| attempt start | Block reprocessing of an occurrence already completed |
| attempt failure | Build the error list handed to `onJobFailure` |
| next deadline | Infer the cadence of a `cron` from the distance between the last two occurrences, without parsing the expression. For `rate` the interval comes from the definition and nothing is read |
| watchdog | Classify the overdue deadline: an attempt stuck in `running` is `invocation_died`, no attempt at all is `never_delivered` |

Deleting executions deletes operational state, not only audit, which is why retention is
opt-in and validated against the retry window.

Every read the library makes is bounded: scoped to the occurrence, or one page in
descending order with a limit. None scans the history of the job, which on a long-lived
recurring job would grow forever.

## How the deadline is stored

All records live in one table, keyed by `source` and `target`, both in the `Type#id`
format:

```text
source                    target
Job#sendEmail#uuid  ->    Job#sendEmail#uuid                                 the job
Job#sendEmail#uuid  ->    JobExecution#2026-01-01T12:00:00Z#0001             one attempt
JobSource#user#123  ->    Job#sendEmail#uuid                                 source to job
PendingJob#open     ->    Deadline#2026-01-01T12:05:00.000Z#sendEmail#uuid   open deadline
```

The watchdog has to answer "which deliveries should have happened already?" without
scanning the table. The library uses a single partition, sorted by time:

```text
source                    target
PendingJob#open     ->    Deadline#2026-01-01T12:05:00.000Z#sendEmail#uuid
PendingJob#open     ->    Deadline#2026-01-01T12:07:30.000Z#purgeExpired#uuid
```

Each job has **at most one** open deadline. Moving it means deleting and creating in the
same transaction, because the instant is part of the key. Finding the overdue ones is a
range query up to `Deadline#{now}`.

Since the partition only holds what is pending, it stays small: a job running normally
leaves nothing behind.

## Idempotency

**The handler must be idempotent with respect to the occurrence.** Running the same
occurrence more than once must not cause a wrong effect in your domain, because:

- EventBridge may redeliver the same occurrence
- retries use the same `scheduledTime`
- if the Lambda dies after the side effect and before the library records the outcome, a
  later attempt reprocesses that occurrence

Good idempotency keys: `job.id` combined with `job.scheduledTime`, and `job.attempt` when
you need to tell attempts apart.

---

## License

MIT
