# ReachInbox Email Scheduler

ReachInbox email scheduling assignment with a React/TypeScript dashboard and a MySQL-backed Express API. BullMQ delayed jobs run on Redis with a separate worker and Nodemailer transport for Ethereal SMTP.

## Architecture

- **Express API** validates schedule requests, applies idempotency, persists an `Email` and transactional `EmailOutbox` record, and exposes email status/list endpoints.
- **MySQL + Prisma** store sender identities, email state, SMTP acceptance metadata, and outbox state. Prisma migrations are under `backend/prisma/migrations`.
- **BullMQ + Redis** hold delayed jobs with stable IDs derived from email IDs. The API and worker both reconcile persisted scheduled records on startup.
- **Worker** claims an email through a conditional database transition, obtains an atomic Redis send reservation, delivers through configured SMTP, and records `SENT` only after SMTP accepts the message. SMTP credentials are environment-only.
- **Rate coordination** uses one Redis Lua script and Redis server time to atomically check a sender's minimum interval and rolling-hour allowance across worker processes. A nullable `Sender.hourlyLimit` overrides the configured default.
- **Email search** uses a versioned MySQL outbox and Elasticsearch document IDs derived from email IDs. A separate worker reconciler indexes changes without blocking email delivery.
- **Queue monitoring** uses Bull Board for the existing email and Slack queues, protected with a dedicated environment token.

The SQL transaction cannot include Redis. If the API commits an email but cannot enqueue it, it leaves a pending outbox row and responds `503` with the saved email ID. Repeating the same request/key retries the enqueue; API or worker startup also scans scheduled and stale-processing rows and reconciles jobs. A crash after Redis enqueue but before the outbox update is safe to retry because the BullMQ job ID is stable. Redis should keep its configured AOF persistence enabled. Email schedule reconciliation runs at process startup and on the same-key retry; recurring Slack-notification recovery is described below.

SMTP acceptance means the SMTP server accepted the message, not that the recipient's inbox received it. A crash after SMTP acceptance and before MySQL records `SENT` leaves an ambiguous outcome; retry can send a duplicate. Exactly-once SMTP delivery is not claimed. `SENT` and `smtpAcceptedAt` mean SMTP accepted the message.

The minimum interval is measured between atomic Redis send-start reservations immediately before the worker invokes SMTP. The hourly allowance is a rolling 60-minute window of unique email IDs reserved for send; BullMQ/SMTP retries for the same email reuse its reservation while it remains in that window. This counts authorized logical sends (including a reservation followed by a worker crash), not confirmed inbox delivery. Quota or interval denial returns the BullMQ job to its persisted delayed state, leaves the database email `SCHEDULED`, and does not increment its SMTP attempt count. Different sender IDs have independent windows.

An effective hourly limit of `0` disables sending for that sender. The Lua script denies every reservation without modifying quota history, and the job stays `SCHEDULED` in BullMQ with a 24-hour delay before rechecking; this avoids an immediate retry loop. A positive `Sender.hourlyLimit` resumes sending for that sender. To resume from the default, set the sender override to `null` (or a positive value) and configure a positive `SENDER_MAX_EMAILS_PER_HOUR`; environment changes require restarting the worker. A parked job is reconsidered within 24 hours after the change and worker restart, subject to its other rate limits. The global environment value is validated as positive, but the limiter fails closed if it is ever passed zero.

Redis coordination is atomic within Redis, but not transactional with MySQL or SMTP. On a Redis error, the worker returns the row to `SCHEDULED` and BullMQ retries with the configured exponential backoff and bounded attempt count; if infrastructure retries exhaust, startup reconciliation restores the scheduled job after Redis is available. Redis loss or restoration from data older than its durable persistence can lose quota history, so the configured Redis AOF/persistence remains part of the rate-limit guarantee. A crash after the reservation but before SMTP conservatively consumes one slot until the rolling window expires. A crash after SMTP acceptance but before MySQL records it can still cause a duplicate on retry.

## Elasticsearch email search

The root Compose file adds Elasticsearch `8.19.23` on `127.0.0.1:9200`, with a persistent `elasticsearch_data` volume and a health check. This **local development service only** disables Elasticsearch security and is bound to loopback; do not reuse that setting in production. Allocate at least 4 GB to Docker (the service is capped at 2 GB and uses a 1 GB JVM heap). Start the existing services and the new search service with:

```sh
docker compose up -d mysql redis elasticsearch
docker compose ps
```

If host port 3306 is occupied, use the existing development override and apply it consistently to later Compose commands: `MYSQL_PORT=13306 docker compose up -d mysql`. The named MySQL and Redis volumes remain in place. Run the additive migration with `cd backend && npm run db:migrate`; it adds `Email.searchVersion` and `EmailSearchOutbox` and queues existing database emails for initial indexing. It does not reset or recreate the database.

Configure the backend in the root `.env` (the values are optional, and the API starts without Elasticsearch):

```dotenv
ELASTICSEARCH_URL=http://127.0.0.1:9200
ELASTICSEARCH_USERNAME=
ELASTICSEARCH_PASSWORD=
```

For production, use an HTTPS cluster with authentication and a trusted TLS certificate; do not disable Elasticsearch security. The client uses system trusted roots and a five-second request timeout. Never put credentials in source control.

The index `reachinbox-emails-v1` has explicit mappings: `id`, `senderId`, `recipient`, and `status` are exact-match fields; `subject` has full-text and exact subfields; `body` is full-text; and schedule/acceptance/created/updated fields are dates. All email states (`SCHEDULED`, `PROCESSING`, `SENT`, `FAILED`) are indexed. Search text matches subject and body, with subject weighted higher. Results include sender ID, recipient, subject, status, and timestamps, but omit the body and internal SMTP/queue metadata.

The search endpoint supports `q`, `status`, `senderId`, `page`, and `pageSize`:

```sh
curl 'http://127.0.0.1:3000/api/emails/search?q=meeting&status=SENT&senderId=default&page=1&pageSize=20'
```

`pageSize` is 1–100; offsets are limited to the first 10,000 matches. The response contains `data` and `pagination: { page, pageSize, total, totalPages }`. Invalid parameters return `400`; an unconfigured or unavailable Elasticsearch cluster returns `503 SEARCH_UNAVAILABLE`. Existing MySQL-backed listing and detail endpoints remain available. Search is unauthenticated like the existing email API and is **not production-ready for multi-tenant data** until application authentication and authorization are added.

Each app-controlled email create/update increments `searchVersion` and inserts an outbox row in the same MySQL transaction. The migration backfills existing rows. The worker scans up to 50 events every 5 seconds and on startup, uses a 60-second database lease for concurrent workers, and retries with exponential backoff from 5 seconds to a one-hour cap. Attempt counts cap at 12 while transient events remain pending and continue retrying at the capped interval. It reads the latest MySQL row before writing and uses Elasticsearch external versioning with the stable email ID, so delayed older work cannot overwrite a newer state. Duplicate index writes are safe. Elasticsearch downtime never blocks scheduling or SMTP; it leaves durable pending rows and search may lag until recovery. MySQL and Elasticsearch do not share a transaction.

Recipient addresses and complete email bodies are personal/sensitive data indexed in Elasticsearch so body search can work. Results omit the body, but Elasticsearch administrators can access indexed documents. Apply production access controls, retention, backups, encryption, and deletion policies appropriate for that data.

## Bull Board queue dashboard

Set `BULL_BOARD_TOKEN` in the root `.env` to a unique random token of at least 32 characters. The dashboard is served at `/admin/queues` and covers `scheduled-emails` and `slack-notifications`; search indexing uses the MySQL outbox poller and adds no BullMQ queue. All dashboard pages and API requests require `Authorization: Bearer $BULL_BOARD_TOKEN`; invalid or missing values return `401`. Keep this admin route behind HTTPS and trusted network access. The bearer token grants queue visibility and Bull Board's queue actions; it is separate from `SLACK_MANAGEMENT_TOKEN`.

Example dashboard API request:

```sh
curl -H "Authorization: Bearer $BULL_BOARD_TOKEN" \
  http://127.0.0.1:3000/admin/queues/api/queues
```

No authenticated application user system exists yet, so the token is deployment-wide administrative access, not per-user authorization.

## Frontend dashboard

The React dashboard reads scheduled and sent emails from `GET /api/emails/scheduled` and `GET /api/emails/sent`, using the backend's `limit`/`cursor` pagination response. The compose dialog accepts recipient addresses as text or CSV, reports valid/invalid/duplicate addresses, and submits one request per recipient to the existing `POST /api/emails/schedule` contract. Each request sends `senderId`, `recipient`, `subject`, `body`, `scheduledAt`, and a stable campaign-scoped `idempotencyKey`.

The start time, minimum delay (seconds), and hourly limit controls spread the campaign's individual `scheduledAt` values. These controls do not change backend configuration: the Redis sender-wide delay and hourly quota remain authoritative, and may delay sends further. The selected hourly limit scopes the current campaign's planned schedule only.

Run the API and worker as described above, then start the frontend from `frontend/`:

```sh
npm ci
if [ ! -f .env ]; then cp .env.example .env; fi
npm run dev
```

`VITE_API_BASE_URL` is the frontend API setting. It defaults to same-origin paths; Vite's development proxy forwards `/api` and `/health` to `http://127.0.0.1:3000`. For production, serve the API through the same-origin reverse proxy or provide an API origin that already permits browser access; this backend does not configure CORS. Do not put secrets in `VITE_` variables because Vite embeds them in client bundles.

## Prerequisites and setup

- Node.js 22 LTS (20+ supported by the code) and npm 10+
- Docker Compose v2 with access to the Docker daemon
- MySQL 8.4 and Redis 7.4 (provided by the root Compose file)
- Ethereal SMTP credentials to actually deliver test messages; API and mocked-SMTP tests do not require them

From the repository root:

```sh
if [ ! -f .env ]; then cp .env.example .env; fi
docker compose up -d
```

The example maps MySQL to `127.0.0.1:13306` and Redis to `127.0.0.1:6379` for this development environment. Change `MYSQL_PORT` if that host port is occupied, and update `DATABASE_URL` to match. If the API is later run in another Compose container, use `mysql:3306` in `DATABASE_URL` and `redis` as `REDIS_HOST`. `.env.example` contains placeholders only; use private values for any shared environment. Never commit `.env`.

Install backend packages and apply the forward-only migration:

```sh
cd backend
npm ci
npm run prisma:generate
npm run prisma:validate
npm run db:migrate
```

`db:migrate` runs `prisma migrate deploy`; it does not reset the database. The API upserts the `default` sender row on startup from `DEFAULT_SENDER_EMAIL` and optional `DEFAULT_SENDER_NAME`.

## Environment variables

The backend loads the repository-root `.env` when started from `backend/`. Existing process environment values take precedence.

| Variable | Required | Default / example | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Yes | `mysql://reachinbox_dev:...@127.0.0.1:13306/reachinbox_dev` | Prisma MySQL connection. URL-encode reserved characters in credentials. |
| `REDIS_HOST` | No | `127.0.0.1` | Redis host; use the Compose service name `redis` from another container. |
| `REDIS_PORT` | No | `6379` | Redis port. |
| `REDIS_PASSWORD` | No | empty | Redis password if enabled. |
| `API_PORT` | No | `3000` | Express listen port. |
| `DEFAULT_SENDER_EMAIL` | Yes | `hello@example.com` | Address for the seeded `default` sender. |
| `DEFAULT_SENDER_NAME` | No | `ReachInbox Development` | Display name for the seeded sender. |
| `SMTP_HOST` | No | `smtp.ethereal.email` | SMTP server hostname. |
| `SMTP_PORT` | No | `587` | SMTP server port. |
| `SMTP_USER` / `SMTP_PASS` | Worker only | empty | Ethereal credentials; worker refuses to start if either is missing. Never stored in MySQL or logged. |
| `SMTP_SECURE` | No | `false` | Set `true` for implicit TLS, normally with port 465. |
| `WORKER_CONCURRENCY` | No | `5` | Number of concurrent BullMQ jobs handled by the worker. |
| `EMAIL_MAX_ATTEMPTS` | No | `3` | Bounded BullMQ attempts, including the first attempt. |
| `EMAIL_RETRY_DELAY_MS` | No | `5000` | Initial exponential retry backoff. |
| `EMAIL_PROCESSING_STALE_MS` | No | `900000` | Age after which a processing row is reconciled if its queue job is absent/terminal. |
| `EMAIL_MIN_SEND_DELAY_MS` | No | `1000` | Minimum milliseconds between send-start reservations for one sender; `0` disables pacing. |
| `SENDER_MAX_EMAILS_PER_HOUR` | No | `100` | Positive default maximum unique email reservations per sender in any rolling 60-minute window. A sender's nullable `hourlyLimit` overrides it; `0` disables that sender and parks jobs for 24-hour rechecks. |
| `ELASTICSEARCH_URL` | No | `http://127.0.0.1:9200` | Elasticsearch HTTP(S) endpoint. If unset, email indexing pauses and search returns `503`. |
| `ELASTICSEARCH_USERNAME` / `ELASTICSEARCH_PASSWORD` | No | empty | Optional paired credentials for secured Elasticsearch deployments. |
| `BULL_BOARD_TOKEN` | No | empty | At least 32 random characters; protects `/admin/queues` with Bearer authentication. |

## Run the API and worker

Run each process in a separate terminal from `backend/`:

```sh
npm run dev
```

```sh
npm run dev:worker
```

The API can run without SMTP credentials. The worker exits with a clear configuration error until both `SMTP_USER` and `SMTP_PASS` are set. To build and run the compiled processes:

```sh
npm run typecheck
npm run build
npm start
```

In another terminal, run `npm run start:worker`. `GET /health` continues to return `{"status":"ok"}`.

## Ethereal SMTP

Create a test account at [Ethereal Email](https://ethereal.email/create), then copy its SMTP host, port, username, and password into the untracked root `.env`. Do not paste credentials into source code or API requests. Configure `DEFAULT_SENDER_EMAIL` to the sender identity to show in the test message. When available, the worker logs the Ethereal preview URL; that preview is a test mailbox link, not proof of inbox delivery.

## API

### Schedule an email

`POST /api/emails/schedule` requires a client-generated, stable idempotency key. `scheduledAt` must be a future ISO-8601 timestamp with an explicit offset.

```sh
curl -X POST http://127.0.0.1:3000/api/emails/schedule \
  -H 'content-type: application/json' \
  -d '{
    "senderId":"default",
    "recipient":"recipient@example.com",
    "subject":"Example subject",
    "body":"Example email body",
    "scheduledAt":"2030-01-01T10:00:00Z",
    "idempotencyKey":"campaign-42-recipient-1"
  }'
```

A new schedule returns `202` with `{ "data": { "id": "...", "status": "SCHEDULED", ... }, "idempotentReplay": false }`. Repeating the identical request/key returns `200` and the same record. Reusing a key with a different payload returns `409 IDEMPOTENCY_CONFLICT`. Invalid input/past times return `400`; unknown senders return `404`; a saved record whose queue enqueue failed returns `503 QUEUE_UNAVAILABLE` and can be retried using the same key.

### Read email state

- `GET /api/emails/scheduled?limit=25&cursor=<email-id>` returns scheduled and processing records.
- `GET /api/emails/sent?limit=25&cursor=<email-id>` returns records accepted by SMTP.
- `GET /api/emails/:id` returns one email and its status, attempt count, last error, and SMTP acceptance metadata.

List responses contain `data` and `pagination: { limit, nextCursor }`. `nextCursor` is `null` when there is no next page. Error responses use `{ "error": { "code": "...", "message": "..." } }`.

## Tests and validation

With MySQL migrated and Redis running, from `backend/`:

```sh
npm run prisma:validate
npm run typecheck
npm run build
npm test
```

The automated suite uses the configured development MySQL/Redis services and a mocked SMTP transport; it creates uniquely keyed test records and cleans up those records/jobs. It does not send email. To check actual Ethereal delivery, configure credentials and a future schedule, start the API and worker, then inspect the returned email record and Ethereal preview link.

## Slack OAuth and quota alerts

Slack integration is optional; the API runs when Slack is not configured. Create a Slack app, enable OAuth v2, set the redirect URL to `https://<public-api-host>/api/slack/oauth/callback`, and request only the `incoming-webhook` scope. Slack returns a channel-specific incoming webhook. The app stores its URL using AES-256-GCM encryption and does not retain the OAuth bot access token. OAuth calls are made to Slack's real OAuth API; automated tests mock those HTTP calls.

Set these values in the untracked root `.env`:

```dotenv
SLACK_CLIENT_ID=<Slack app client ID>
SLACK_CLIENT_SECRET=<Slack app client secret>
SLACK_REDIRECT_URL=https://<public-api-host>/api/slack/oauth/callback
SLACK_TOKEN_ENCRYPTION_KEY=<64 hex characters from openssl rand -hex 32>
SLACK_MANAGEMENT_TOKEN=<at least 32 random characters>
```

`GET /api/slack/oauth/start` requires `Authorization: Bearer $SLACK_MANAGEMENT_TOKEN` and redirects to Slack. Retrieve its `Location` header with `curl -sSI -H "Authorization: Bearer $SLACK_MANAGEMENT_TOKEN" http://127.0.0.1:3000/api/slack/oauth/start`, then open that Slack URL in a browser. Slack calls `GET /api/slack/oauth/callback`; the endpoint consumes short-lived, single-use Redis OAuth state and persists the installation. `GET /api/slack/connection` returns workspace/channel metadata and never a token. `DELETE /api/slack/connection` requires the same bearer token. Keep these management endpoints behind trusted network access as well. Since the product has no authenticated users or tenant model, this milestone associates exactly one Slack workspace/channel with the whole deployment (`deploymentKey=default`); it does not accept a client-supplied user ID as proof of identity. A later authenticated tenant model should replace that deployment-wide association.

The migration `20261017130000_slack_connections_and_notifications` adds connection metadata and a Slack notification outbox. Apply it with `cd backend && npm run db:migrate`; it is additive and does not reset existing data. The webhook URL is encrypted at rest; workspace/channel metadata is not secret. Back up the encryption key securely because losing it makes the stored connection unusable.

When Redis atomically denies a send for the rolling hourly quota, the email remains scheduled and delayed as before. The worker writes a durable notification outbox event and queues Slack delivery separately, so a slow Slack API does not block sending. A unique sender/period event key deduplicates the burst: one message per sender for the computed quota window; a zero-limit sender is limited to one event per UTC day. The worker reconciles pending outbox rows at startup and every 30 seconds while running. Reconciliation skips events already delivered/failed, respects the per-replay limit of eight attempts, and uses stable BullMQ job IDs so concurrent workers converge on one job. If a pending event's queue job has terminally failed or disappeared after exhausting attempts, the event becomes `FAILED` for explicit operator review rather than being retried indefinitely. A failed event is never automatically replayed.

Delivery retries use BullMQ exponential backoff (up to eight attempts); HTTP 429 honors `Retry-After`. Invalid/revoked webhook responses mark the connection revoked and the event failed. A Slack API rejection or unavailable connection cannot change email state or quota decisions. A crash after Slack accepts a post but before MySQL records `DELIVERED` can result in a duplicate message; exactly-once Slack delivery is not claimed. Zero-limit email jobs remain parked for 24 hours between checks and do not call SMTP; their alert says sending depends on a configuration change, not that the 24-hour recheck is a predicted send time.

### Inspecting and replaying failed Slack notifications

Both operations require `Authorization: Bearer $SLACK_MANAGEMENT_TOKEN`. The failed-event endpoint returns at most 100 records (default 50) with ID, event type, sender ID, state, attempt/replay counts, timestamps, and sanitized error text. It never returns webhook or encryption data.

```sh
curl -H "Authorization: Bearer $SLACK_MANAGEMENT_TOKEN" \
  'http://127.0.0.1:3000/api/slack/notifications/failed?limit=50'
```

After checking the failure, restore/reconnect Slack if needed and replay one event explicitly:

```sh
curl -X POST -H "Authorization: Bearer $SLACK_MANAGEMENT_TOKEN" \
  "http://127.0.0.1:3000/api/slack/notifications/<notification-id>/replay"
```

Replay accepts only `FAILED` events and returns `202`; unknown IDs return `404`, other states return `409`, and invalid/missing management credentials return `401`. It resets that delivery attempt count, increments a persistent replay generation, and schedules a new deterministic BullMQ job. The unique outbox event key is unchanged, so ordinary quota-period deduplication remains intact. Each explicit replay grants one fresh bounded set of up to eight attempts; replay events one at a time after inspecting the cause to avoid flooding Slack. If enqueueing fails, the event remains `PENDING` and periodic worker recovery retries enqueueing within about 30 seconds. The worker must be running with the encryption key configured. Events that fail again can be inspected and explicitly replayed again. `DELIVERED` events cannot be replayed through this endpoint. Check Slack for delivery; no API endpoint exposes message content or delivery history beyond the failed list.

### Slack tests

The backend suite includes Redis-backed state expiry/single-use tests and mocked Slack HTTP exchange/delivery tests. They validate application behavior but do not prove live Slack credentials, workspace installation, or real message delivery.

## Current validation results (2026-10-17)

Using Node.js 22.23.3/npm 10.9.9 from a temporary toolchain under `/tmp`, Prisma client generation, schema validation, migration status, backend typecheck, production build, Compose configuration validation, `git diff --check`, and the complete backend suite passed. The database reports all five migrations applied. The suite reports 39 passed, 0 failed, and 1 skipped: 19 scheduler tests use MySQL/Redis, the search tests use MySQL and a mocked Elasticsearch client (with Redis for Bull Board), and the Slack tests use MySQL/Redis with Slack HTTP mocked. The live Elasticsearch round-trip was not verified. The container is currently unhealthy because Elasticsearch's 90% disk watermark is exceeded and its primary shard is unassigned; search functionality needs to be rechecked after disk headroom is restored. No live Slack OAuth/message delivery or SMTP delivery was tested.

For the frontend milestone, `npm run build` in `frontend/` passed under Node 22.23.3/npm 10.9.9. There is no frontend test script or test framework in the starter package. A manual headless Chrome smoke test confirmed the dashboard renders without a blank screen or application exceptions, both list empty states render, and a mocked API error shows its message and retry button. The test used a temporary localhost response stub; it did not submit through the live backend. Request fields and response parsing were checked against the backend routes. The provided Figma URL was inaccessible from the available inspection tools, so the interface has not been visually compared with that reference.

## Current limitations

- No application user authentication/Google OAuth, sender administration API, or per-sender SMTP credentials. Search and Bull Board remain deployment-wide backend features, not tenant-isolated UI features.
- Sender identities are stored in MySQL; `default` is seeded from environment configuration. Additional sender rows can be added through a future administrative path.
- SMTP delivery is at-least-once under ambiguous crashes. MySQL state and SMTP acceptance cannot be committed atomically.
- Redis rate reservations are atomic across workers but are not committed atomically with MySQL or SMTP. Redis data loss can reset recent quota history; a reservation made before a crash may conservatively use quota without an SMTP attempt.
- Startup reconciliation and same-key retries repair pending work. If Redis is unavailable after a request commits and no same-key retry or process restart occurs, that outbox row remains pending until reconciliation runs.
- The database stores MySQL `DATETIME(3)` values as UTC instants through JavaScript `Date`; clients should send explicit ISO offsets and responses are normalized to UTC `Z` timestamps.
