# ReachInbox Email Scheduler

A full-stack email scheduling assignment with a React dashboard, an Express API, durable delayed jobs, and a separate worker that sends test messages through Ethereal Email.

## Features

### Backend

- Express and TypeScript API with health, authentication, email scheduling, status, search, and Slack integration routes.
- MySQL persistence through Prisma, including idempotency and transactional outboxes for queueing and search indexing.
- Redis and BullMQ delayed email jobs, retries, worker recovery, and sender-wide rate coordination.
- Nodemailer SMTP delivery through Ethereal Email. An email is marked `SENT` only after SMTP accepts it.
- Optional Elasticsearch indexing and search, plus a token-protected Bull Board dashboard.
- Optional Slack OAuth connection and quota notification delivery.

### Frontend

- React, TypeScript, Vite, and Tailwind CSS dashboard.
- Scheduled and sent email views, pagination, Google sign-in, and a multi-recipient composer that accepts addresses or CSV input.
- Campaign start time, spacing, and hourly pacing controls. The backend's sender-wide limits remain authoritative.
- Production Node server that serves the Vite build and proxies `/api/*` to the backend while forwarding cookies.

## Architecture

```text
React/Vite browser
       | /api (same-origin proxy in production)
       v
Express API ------ MySQL / Prisma
       |                |
       +---- Redis / BullMQ delayed jobs --- Worker --- Ethereal SMTP
       |                                            +--- Elasticsearch (optional)
       |                                            +--- Slack API (optional)
       +---- Bull Board (protected)
```

- **Express** validates requests and returns paginated email state.
- **MySQL and Prisma** store emails, senders, idempotency keys, SMTP acceptance metadata, and outbox records. Migrations live in `backend/prisma/migrations`.
- **Redis and BullMQ** hold delayed jobs and coordinate sender pacing and quotas across workers.
- **The worker** claims due emails, reserves sender quota, and calls Nodemailer. It records `SENT` after SMTP acceptance; a failed final attempt is `FAILED`.
- **Ethereal Email** is a fake SMTP service for test messages. Its preview is not inbox delivery to a real recipient.
- **Elasticsearch** is optional. It indexes email status and searchable content from the MySQL outbox. Local Compose disables Elasticsearch security and binds it to loopback; production must use HTTPS, authentication, and trusted TLS.
- **Slack** is optional. OAuth stores an encrypted incoming webhook; quota notifications are delivered through a separate BullMQ queue.

## Prerequisites

- Node.js 22 LTS and npm 10 or newer
- Docker Compose v2 and a running Docker daemon for local MySQL, Redis, and optional Elasticsearch
- Google Cloud Web OAuth client for sign-in
- Ethereal Email account for SMTP testing

## Backend setup

From the repository root, create the root `.env` from the example if it does not already exist, then start local services:

```sh
if [ ! -f .env ]; then cp .env.example .env; fi
docker compose up -d mysql redis
docker compose ps
```

The Compose file supplies MySQL 8.4 and Redis 7.4 with named persistent volumes. Elasticsearch 8.19.23 is optional for local search:

```sh
docker compose up -d elasticsearch
```

The default MySQL host port is `3306`; the example file may set a local override such as `13306`. Keep `DATABASE_URL` consistent with `MYSQL_PORT`. Redis is published only on loopback for local development, with AOF persistence enabled. Do not use the development credentials or Elasticsearch security settings in a shared or production environment. `docker compose down -v` deletes the named data volumes.

Install backend dependencies and prepare the database:

```sh
cd backend
npm ci
npm run prisma:generate
npm run prisma:validate
npm run db:migrate
```

`db:migrate` runs `prisma migrate deploy`; it applies pending forward migrations and does not reset the database. The migration history currently includes the initial scheduler, sender rate limits, Slack connection/notifications and replay tracking, and email search outbox.

Start the API and worker in separate terminals from `backend/`:

```sh
npm run dev
```

```sh
npm run dev:worker
```

The API listens on `PORT` when supplied by the platform, otherwise `API_PORT` (default `3000`). `GET /health` returns `{"status":"ok"}`. The API can run without SMTP credentials; the worker requires `SMTP_USER` and `SMTP_PASS`.

For compiled production processes:

```sh
npm run typecheck
npm run build
npm start
```

Start the compiled worker in another terminal with `npm run start:worker`.

## Environment variables

The backend loads `../.env` when run from `backend/`; process environment variables take precedence. The examples contain placeholders only. Keep real values in untracked secret storage, never in source control or frontend `VITE_` variables.

| Variable(s) | Requirement and use |
|---|---|
| `DATABASE_URL` | Required. MySQL Prisma URL; URL-encode reserved characters in credentials. |
| `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `MYSQL_PORT`, `REDIS_PORT`, `ELASTICSEARCH_PORT` | Local Compose database names, development credentials, and loopback host ports. |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Redis connection; host and port default to `127.0.0.1:6379`, password is optional. |
| `API_PORT`, `PORT` | Optional listen port. Injected `PORT` takes precedence; local fallback is `3000`. |
| `DEFAULT_SENDER_EMAIL`, `DEFAULT_SENDER_NAME` | Default sender identity; email is required, name is optional. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | Ethereal SMTP settings. Defaults are `smtp.ethereal.email`, `587`, and `false`; worker credentials are required to start sending. |
| `WORKER_CONCURRENCY`, `EMAIL_MAX_ATTEMPTS`, `EMAIL_RETRY_DELAY_MS`, `EMAIL_PROCESSING_STALE_MS` | Worker concurrency, bounded attempts, exponential retry delay, and stale-processing recovery. Defaults are `5`, `3`, `5000`, and `900000`. |
| `EMAIL_MIN_SEND_DELAY_MS`, `SENDER_MAX_EMAILS_PER_HOUR` | Backend sender-wide minimum send interval and default rolling-hour quota. Defaults are `1000` ms and `100`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_SESSION_SECRET`, `FRONTEND_ORIGIN` | Optional auth configuration. Configure the Google values together; session secret must be at least 32 characters. Set the exact browser origin for split frontend/API origins. |
| `ELASTICSEARCH_URL`, `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD` | Optional search endpoint and paired credentials. Without a URL, indexing pauses and search returns `503`. |
| `BULL_BOARD_TOKEN` | Optional dashboard bearer token, at least 32 random characters. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `SLACK_TOKEN_ENCRYPTION_KEY`, `SLACK_MANAGEMENT_TOKEN` | Optional Slack OAuth, webhook encryption, and management protection settings. |

The root `.env.example` also contains local Compose variables for MySQL, Redis, and Elasticsearch ports and credentials. Change every development password before using any shared deployment.

## Frontend setup and Google sign-in

Set up the backend and local services first. Then, from the repository root:

```sh
cd frontend
npm ci
```

Create `frontend/.env` from `frontend/.env.example` if it does not already exist. Set `VITE_GOOGLE_CLIENT_ID` to the same public Google Web OAuth client ID used by backend `GOOGLE_CLIENT_ID`, then start Vite:

```sh
npm run dev
```

In Google Cloud Console, add `http://localhost:5173` as an authorized JavaScript origin (add `http://127.0.0.1:5173` only if using that host). Add the production frontend origin when deployed. This Google Identity Services popup flow does not use a redirect URI or client secret.

Set the same client ID in backend `GOOGLE_CLIENT_ID` and frontend `VITE_GOOGLE_CLIENT_ID`. Generate `GOOGLE_SESSION_SECRET` with `openssl rand -hex 32` and keep it only in backend secrets. Configure both backend Google values together; when Google auth is enabled, email API routes require a valid session.

For local development, Vite proxies `/api` and `/health` to `http://127.0.0.1:3000`. In production, the frontend Node server runs `npm start`, serves `dist/`, and proxies `/api/*` to `BACKEND_ORIGIN`. Keep production browser requests same-origin and leave `VITE_API_BASE_URL` unset. Set backend `FRONTEND_ORIGIN` to the exact frontend origin. The proxy preserves request cookies and backend `Set-Cookie` headers; the session cookie is HttpOnly and scoped to `/api`.

## Ethereal Email setup

1. Create a test account at [Ethereal Email](https://ethereal.email/create).
2. Set `SMTP_HOST=smtp.ethereal.email`, `SMTP_PORT=587`, `SMTP_SECURE=false`, and the account's `SMTP_USER` and `SMTP_PASS` in the worker's secret environment.
3. Set `DEFAULT_SENDER_EMAIL` to the sender identity shown in the test message.
4. Schedule a message and inspect the generated preview URL in worker logs, or sign in to the Ethereal account's web interface to view the test message.

Ethereal accepts test messages for preview; it does not deliver them to real recipient inboxes. Keep SMTP credentials out of logs, source control, and client-side variables.

## Scheduling and reliability

`POST /api/emails/schedule` requires a future ISO-8601 `scheduledAt` value and a stable, client-generated `idempotencyKey`. It stores the email and a queue outbox record in one MySQL transaction, then enqueues a BullMQ job with a stable ID. A repeated identical request/key returns the same email; reusing the key with a different payload returns `409`.

BullMQ persists delayed jobs in Redis. The API and worker reconcile scheduled or stale-processing database records on startup; same-key retries also repair enqueue failures. Keep Redis persistence enabled. If SMTP fails, the worker records the error and retries with exponential backoff up to `EMAIL_MAX_ATTEMPTS` (default 3). After the final attempt the row becomes `FAILED`; scheduled and sent list endpoints do not include failed rows. A crash after SMTP acceptance but before the database update can cause a duplicate retry, so delivery is at-least-once rather than exactly-once.

Important endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /health` | API health check |
| `POST /api/emails/schedule` | Create or replay an idempotent schedule request |
| `GET /api/emails/scheduled?limit=25` | List `SCHEDULED` and `PROCESSING` emails |
| `GET /api/emails/sent?limit=25` | List SMTP-accepted `SENT` emails |
| `GET /api/emails/:id` | Read an email's status, attempts, error, and acceptance metadata |
| `GET /api/emails/search` | Search indexed emails when Elasticsearch is configured |

List endpoints support cursor pagination. If scheduling returns `503 QUEUE_UNAVAILABLE`, the email has been saved; retry the same request with the same idempotency key.

## Rate limiting and concurrency


| Control | Scope | Effect |
|---|---|---|
| Composer hourly pacing | Current campaign only | Spreads planned `scheduledAt` times across recipients; it does not configure the backend. |
| `SENDER_MAX_EMAILS_PER_HOUR` and optional `Sender.hourlyLimit` | Each sender across workers | Redis atomically enforces a rolling 60-minute allowance immediately before SMTP starts. A sender override takes precedence; `0` disables sending for that sender. |
| `EMAIL_MIN_SEND_DELAY_MS` | Each sender across workers | Minimum time between send-start reservations; `0` disables this pacing rule. |
| `WORKER_CONCURRENCY` | Each worker process | Maximum jobs handled concurrently by that process. Redis coordination still applies across processes. |

Rate-limited jobs remain scheduled and are delayed before reconsideration. They do not consume an SMTP attempt while parked. A zero hourly limit parks jobs for 24-hour rechecks; restart the worker after changing environment settings.

## Search and Bull Board

### Elasticsearch

For local development, start the Compose service with `docker compose up -d elasticsearch` and set `ELASTICSEARCH_URL=http://127.0.0.1:9200`. Its security is disabled only for local loopback development. Use an authenticated HTTPS Elasticsearch cluster with trusted TLS in production. Email bodies and recipient addresses are indexed; protect access, retention, backup, and deletion accordingly. Indexing uses a durable MySQL outbox and retries independently of email sending. Search is not tenant-isolated.

### Bull Board

Set `BULL_BOARD_TOKEN` to a unique random value of at least 32 characters. Open `/admin/queues` through the API service and send `Authorization: Bearer <token>` for dashboard requests. It covers the scheduled email and Slack notification queues. Treat the token as deployment-wide administrative access and keep the route behind HTTPS and trusted network controls.

## Slack OAuth and quota alerts

Slack is optional. Create a Slack app with OAuth v2 and the `incoming-webhook` scope. Set its redirect URL to `https://<api-host>/api/slack/oauth/callback`, then configure `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `SLACK_TOKEN_ENCRYPTION_KEY` (64 hex characters), and `SLACK_MANAGEMENT_TOKEN` (at least 32 random characters). Keep these values in backend secrets.

OAuth start and disconnect require `Authorization: Bearer <SLACK_MANAGEMENT_TOKEN>`. The encrypted webhook is stored in MySQL; workspace and channel metadata are stored without encryption. A deployment currently supports one shared Slack connection, not per-user or per-tenant connections. When sender quota is reached, a separate queue delivers an alert. Failed notifications can be inspected and explicitly replayed through the protected Slack notification endpoints.

Automated Slack tests mock Slack HTTP calls. Live OAuth installation and real Slack message delivery have not been verified for this submission; configure the real app and test those steps in the target workspace.

## Current deployment notes

The frontend and API are deployed on Railway. Configure the frontend as a Node service rooted at `frontend/`, with build command `npm ci && npm run build`, start command `npm start`, and `BACKEND_ORIGIN` set to the backend HTTPS origin. Configure the API service rooted at `backend/`, with `npm ci`, Prisma client generation, and `npm run build` as its build steps, and `npm start` as its start command. Apply pending production migrations with `npm run db:migrate` from `backend/` using the production database URL. Set backend `FRONTEND_ORIGIN` to the exact frontend origin; the API listens on Railway's injected `PORT`.

Railway Trial blocks outbound SMTP, so the worker is currently run locally and connects to the Railway MySQL and Redis services through Railway tunnels. This preserves Ethereal SMTP and the existing queue/database; the local worker machine and both tunnels must remain running for scheduled messages to be processed. Railway documents SMTP availability on Pro and above: [Outbound networking](https://docs.railway.com/networking/outbound-networking).

The local worker configuration is stored in the ignored `backend/.env.local-worker`; do not copy its values into this README or commit that file. Open the database and Redis tunnels first. From the repository root, run the following commands to build the worker and start it with that configuration. `DOTENV_CONFIG_PATH` is resolved relative to the process working directory; existing process environment variables take precedence over values in the file.

```sh
# macOS/Linux
cd backend
npm run build
DOTENV_CONFIG_PATH=.env.local-worker npm run start:worker
```

```powershell
# PowerShell
Set-Location backend
npm run build
$env:DOTENV_CONFIG_PATH = ".env.local-worker"
npm run start:worker
```

The codebase does not include a Railway deployment manifest; service build/start settings and tunnel setup are managed in Railway and the local environment. For a stable always-on worker on Railway, Trial SMTP restrictions would need to be addressed (for example, by moving to a plan that permits SMTP and redeploying the worker).

## Tests and validation

The repository has backend tests in `backend/tests` and two frontend proxy tests in `frontend/tests`. From `frontend/`, `npm test` runs the package script `node --test tests/*.test.mjs` against `tests/proxy.test.mjs`. The backend suite uses MySQL and Redis and mocks SMTP; it does not send every automated test message to Ethereal.

Previously recorded validation (2026-10-17):

- Backend Prisma generation/validation, migration status, typecheck, and production build passed.
- Full serial backend suite: 42 passed, 0 failed, 1 skipped. The skipped case was the live Elasticsearch round-trip; Elasticsearch was unhealthy at that check because of disk watermark pressure.
- Frontend proxy tests: 2 passed; frontend production build passed.
- Compose configuration validation passed.
- A separate manual Ethereal test was accepted and its preview inspected; this does not verify delivery to an actual inbox.
- Slack HTTP tests are mocked; live Slack OAuth and message delivery were not verified.

These are historical results from the date above, not checks rerun for this README update.

Run validation locally after setup:

```sh
cd backend
npm run prisma:validate
npm run typecheck
npm run build
npm test
```

```sh
cd frontend
npm test
npm run build
```

## Assumptions, trade-offs, and limitations

- Google sign-in verifies identity, but there is no database user/tenant ownership model. Signed-in users share the deployment email and sender data.
- The default sender is seeded from environment configuration; sender administration and per-sender SMTP credentials are not implemented.
- SMTP acceptance is not inbox delivery. A crash between SMTP acceptance and database update can result in duplicate delivery.
- Failed emails are not included in the Scheduled or Sent lists. Search can index `FAILED` records when Elasticsearch is enabled, but there is no email retry/replay endpoint in this implementation.
- Redis quota reservations are atomic in Redis but not transactional with MySQL or SMTP. Redis data loss can affect recent quota history.
- Elasticsearch is optional and can lag behind MySQL while its outbox retries. Search needs a healthy configured cluster.
- Slack connection and quota alerting are deployment-wide, not tenant-scoped.
- The worker currently depends on a locally running machine and Railway tunnels because of the Railway Trial SMTP restriction.

## Demo video

**Video link:** `[Add demo video URL]`

Suggested demo sequence (under five minutes):

1. Sign in with Google and show the dashboard.
2. Schedule a message for about one minute in the future to an Ethereal test recipient and show campaign pacing options.
3. Stop the worker before the scheduled time, restart it before it is due, and verify the future scheduled message still sends after its due time.
4. Open the Ethereal preview and show SMTP acceptance; explain that it is a test mailbox, not a real inbox delivery.
5. Briefly show search or the protected queue dashboard, if configured.

## Submission checklist

- [ ] Confirm the GitHub repository is private.
- [ ] Invite `Mitrajit` and `Yadav036` to the repository with the required access.
- [ ] Add the demo video link above.
- [ ] Check that `.env`, `frontend/.env`, and `backend/.env.local-worker` are not committed.
- [ ] Verify the documented deployment state and validation results before submission.
