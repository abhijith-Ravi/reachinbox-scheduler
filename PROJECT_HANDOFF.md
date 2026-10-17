# ReachInbox Scheduler Project Handoff

Audit date: 2026-10-17 (Asia/Kolkata)

## Elasticsearch search and Bull Board milestone (2026-10-17)

Baseline `858f121` was verified committed and pushed (`main` and `origin/main` matched) before this work. No `.env` was written. The additive migration `20261017160000_email_search_index_outbox` adds `Email.searchVersion`, creates a durable `EmailSearchOutbox`, and backfills one pending event for each existing email. It was applied to the existing MySQL database; all five migrations report up to date. No database reset or volume deletion occurred. Compose recreated the MySQL container to bind its already existing named volume on host port 13306; its data volume was retained.

- Elasticsearch is pinned to `docker.elastic.co/elasticsearch/elasticsearch:8.19.23`; the exact compatible Node client is `@elastic/elasticsearch` 8.19.2. The local-only Compose service binds HTTP to `127.0.0.1:9200`, persists data in `elasticsearch_data`, and disables security only for this development profile. Production must use authenticated HTTPS; Docker should be allocated at least 4 GB. The app accepts optional `ELASTICSEARCH_URL` and paired optional username/password settings and starts without them.
- The `reachinbox-emails-v1` mapping uses exact fields for IDs/status/recipient, full-text subject/body, and date mappings. Only email fields needed for search are included; no SMTP/Slack credentials, queue internals, or Slack metadata are indexed. Search responses omit the body and SMTP metadata. Body and recipient PII remain stored/searchable in Elasticsearch, so production access control and retention are required.
- Every app-controlled email create/update increments `searchVersion` and creates a search outbox event in the same MySQL transaction. Existing emails are backfilled. The worker reconciles up to 50 rows every 5 seconds and at startup, claims rows with a 60-second lease, reads current MySQL state, and writes by stable email ID with external versioning. Retries use exponential backoff from 5 seconds to a one-hour cap; attempt count caps at 12 while pending work remains retryable. Indexing never runs in the SMTP request path. ES downtime leaves durable pending work; search returns `503 SEARCH_UNAVAILABLE` when ES cannot serve a query. Consistency is eventual, MySQL and Elasticsearch are not atomic, and data can lag until indexing recovers.
- `GET /api/emails/search` validates query, status, sender, page, and page size. It searches subject/body, filters any email state, caps `pageSize` at 100 and the offset window at 10,000, and returns `{ data, pagination }`. Search is unauthenticated like the existing API; it is not tenant-safe until application authentication/authorization exists.
- Bull Board at `/admin/queues` registers the existing `scheduled-emails` and `slack-notifications` queues. Indexing uses the MySQL outbox poller and creates no BullMQ queue. Every dashboard page/API route requires `Authorization: Bearer <BULL_BOARD_TOKEN>`; the token is separately configured, minimum 32 characters, and timing-safe compared. Keep it behind HTTPS and trusted network controls.

**Validation on 2026-10-17 using Node 22.23.3/npm 10.9.9 restored under `/tmp`:**

| Check | Result |
|---|---|
| `npm run prisma:generate` | PASS, Prisma Client 6.19 generated. |
| `npm run prisma:validate` | PASS. |
| `npm run db:migrate` | PASS, applied only the additive search outbox/backfill migration; no reset. |
| `npx prisma migrate status` | PASS, all five migrations up to date. |
| `npm run typecheck`, `npm run build` | PASS. |
| `docker compose config --quiet` | PASS. |
| MySQL/Redis | PASS, MySQL healthy on host port 13306 and Redis healthy on 6379. Existing named data volumes retained. |
| Elasticsearch container | Currently `Up (unhealthy)`; direct host probe cannot connect. Earlier service logs confirmed the 90% disk watermark (44.7 GB free, 9.8%) and an unassigned primary shard. I did not lower/disable the disk safety threshold or delete data. |
| `npm test` | RERUN PASS, 39 passed, 0 failed, 1 live Elasticsearch test skipped because `ELASTICSEARCH_URL` was unset. Nineteen scheduler tests use MySQL/Redis; six passing search tests use MySQL and mocked Elasticsearch, with the Bull Board test using Redis; thirteen Slack tests use MySQL/Redis and mocked Slack HTTP. SMTP is mocked. |
| Live Elasticsearch round-trip | NOT VERIFIED. Attempted with the configured client; cluster health was red and the search index primary could not be allocated. The final full-suite run skipped the optional live test because `ELASTICSEARCH_URL` was unset. |
| `git diff --check` | PASS on the final source and documentation diff. |

The temporary Node toolchain was installed only under `/tmp/reachinbox-node22`; system Node 18/npm 9 were not changed. Run from the repository root: `docker compose up -d mysql redis elasticsearch` (when 3306 is occupied use `MYSQL_PORT=13306 docker compose up -d mysql`), then from `backend/` run `npm run db:migrate`, `npm run dev`, and in a second terminal `npm run dev:worker`. Configure optional `ELASTICSEARCH_URL`, `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD`, and `BULL_BOARD_TOKEN`; see README for search/dashboard examples. Search will return 503 until Elasticsearch has assignable primary shards.

## Slack OAuth and quota-notification milestone (2026-10-17)

Implementation added locally in this milestone. Additive migrations `20261017130000_slack_connections_and_notifications` and `20261017143000_slack_notification_replay_tracking` create the Slack tables and add a replay counter without changing or dropping scheduler data. Both were applied to the existing development database; no reset/recreation was performed. No live Slack credentials are configured, and no claim of live OAuth or delivery is made.

- OAuth v2 uses Slack's real authorize and `oauth.v2.access` endpoints and requests only `incoming-webhook`. Redis state is random, expires after 10 minutes, and is consumed atomically once. Callback errors are sanitized. The channel webhook URL is AES-256-GCM encrypted; OAuth `access_token` is not stored. `SLACK_TOKEN_ENCRYPTION_KEY` is required to use Slack features, but optional for API startup.
- With no authenticated user/tenant system, an installation belongs to one deployment-wide connection (`deploymentKey=default`), not a claimed arbitrary user. OAuth start and disconnect require `Authorization: Bearer <SLACK_MANAGEMENT_TOKEN>`; keep API routes network restricted. Connection status exposes workspace/channel metadata only. This is a deployment administrator gate, not application login; future tenant auth should replace it.
- On an atomic hourly-quota denial, the email's database and BullMQ state remain as before. The processor inserts a durable notification outbox event and queues delivery asynchronously. Unique `(senderId, quota period)` hashing deduplicates burst events; disabled/zero-limit notices are deduplicated by UTC day. The separate BullMQ notification queue retries up to eight attempts with exponential backoff and honors Slack 429 `Retry-After`. Pending rows reconcile at startup and every 30 seconds while the worker runs. Stable generation-specific BullMQ IDs make concurrent recovery/replay idempotent. FAILED rows are not automatically re-enqueued. The authenticated failed-event list returns sanitized operational metadata; replay atomically claims only FAILED rows, resets the attempt count, increments the persisted `replayCount`, and creates one new bounded job generation. Missing connection results in no event; invalid webhook responses revoke the connection and fail the event. A crash after Slack accepts a post but before MySQL records it can duplicate the Slack message. No email is dropped or marked SENT due to Slack failure.
- Zero hourly limit remains fail-closed; jobs are parked for a 24-hour recheck, do not change quota history, and do not invoke SMTP. Alerts correctly say eligibility depends on a limit configuration change rather than mislabeling the recheck time as a send-eligible time. Notification failure does not affect that behavior.

Required environment: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL` (configure exactly `https://<public-api-host>/api/slack/oauth/callback` in the Slack app), `SLACK_TOKEN_ENCRYPTION_KEY` (32-byte hex key), and `SLACK_MANAGEMENT_TOKEN` (minimum 32 characters). `.env.example` contains placeholders only. Never commit a real secret. Run migration with `cd backend && npm run db:migrate`; do not reset the database.

Slack endpoints: `GET /api/slack/oauth/start` (management bearer token; redirects to Slack), `GET /api/slack/oauth/callback` (Slack callback), `GET /api/slack/connection` (metadata only), and `DELETE /api/slack/connection` (management bearer token). See README for setup commands and limitations.

Failed notification operations use the same management bearer token: `GET /api/slack/notifications/failed?limit=50` lists up to 100 sanitized records; `POST /api/slack/notifications/:id/replay` replays only a FAILED event. Restore/reconnect Slack, inspect an event, then replay one at a time. Pending enqueue failures recover automatically within about 30 seconds while the worker runs; retry-exhausted events require this explicit operator replay. Each replay is limited to eight attempts. Slack acceptance followed by a process crash before the MySQL `DELIVERED` update remains a duplicate-delivery window.

**Validation run in this milestone** (backend directory; Node 22/npm 10 from `/tmp/reachinbox-toolchain`; command-scoped local `DATABASE_URL` and `DEFAULT_SENDER_EMAIL`; `.env` was not created/edited):

| Command/check | Result |
|---|---|
| `npm run prisma:generate` | PASS, Prisma Client 6.19 generated. |
| `npm run prisma:validate` | PASS, schema valid. |
| `npm run db:migrate` | PASS, applied additive Slack connection/notification and replay-tracking migrations to existing MySQL. No reset/recreation. |
| `npx prisma migrate status` | PASS, all 4 migrations applied; schema up to date. |
| `npm run typecheck` | PASS. |
| `npm run build` | PASS. |
| `npm test` | PASS, 32 tests, 0 failed. Includes 19 existing MySQL/Redis integration tests plus 13 Slack tests; OAuth state and BullMQ recovery use Redis, Slack connection/outbox/API tests use MySQL with unique test records, Slack HTTP is mocked, and selected service tests use fakes. Existing SMTP is mocked. |
| `git diff --check` | PASS (see final milestone diff review below). |

Slack tests cover OAuth authorize scope and mocked exchange/persistence, denied/missing/expired/replayed state, exchange rejection, AES-GCM tamper detection, outbox deduplication, no-connection behavior, notification payload privacy, 429 delay, periodic recovery, failed-event authentication/inspection/replay, replay/recovery races, retry-limit enforcement, and unusable webhook revocation. They do not prove live Slack OAuth or real Slack message delivery. Slack HTTP calls are mocked; connection/outbox/API tests use MySQL and OAuth state/BullMQ tests use Redis.

## Backend scheduling and rate-limit milestone update (2026-10-17)

This update supersedes the initial starter-state implementation matrix and validation section below.

| Area | Current implementation and actual verification |
|---|---|
| Database | Prisma 6.19 models `Sender`, `Email`, and `EmailOutbox`; unique idempotency/job keys and status/schedule indexes. This milestone adds nullable `Sender.hourlyLimit` with additive migration `20261017120000_sender_rate_limits`. `prisma validate`, `migrate deploy`, and `migrate status` passed; database is up to date. No data or volumes were reset. |
| API | `POST /api/emails/schedule`, `GET /api/emails/scheduled`, `GET /api/emails/sent`, `GET /api/emails/:id`, and preserved `GET /health`. Integration tests cover validation, lists/details, replay/conflict, and concurrent idempotency. Compiled API health probe returned HTTP 200 with `{"status":"ok"}`. |
| Queue and recovery | BullMQ 6 + Redis, stable job ID per Email, SQL transactional outbox, startup email reconciliation in API/worker, and same-key enqueue retry. Redis Lua reservation coordinates minimum send-start spacing and rolling 60-minute sender quotas atomically across workers. Denied jobs return to BullMQ delayed state; email rows remain `SCHEDULED`. Slack notifications additionally use 30-second worker-managed periodic recovery; no cron is used. |
| Worker and state | Separate worker entrypoint; configurable concurrency, capped attempts, exponential backoff, conditional transitions `SCHEDULED → PROCESSING → SENT/FAILED`, persisted SMTP attempts/errors. SMTP retries reuse an email's Redis quota reservation within the rolling window. Deferrals and Redis coordination errors do not increment SMTP attempt count. |
| SMTP | Nodemailer Ethereal transport is implemented and requires credentials before worker startup. Missing-credential check produced the expected clear startup error. No credentials are configured, so real Ethereal delivery and preview URL were not verified. `SENT` means SMTP acceptance, not inbox delivery. |
| Validation | PASS: Prisma client generation and schema validation; typecheck; production build; additive migration deploy/status; all 19 integration tests against development MySQL/Redis, including zero-limit parking, real Redis concurrency and BullMQ delayed-job worker restart. Tests use mocked SMTP, unique sender/email IDs, and targeted cleanup. SMTP delivery was not tested. |
| Git and files | Base commit was `ae5a478` (`feat: implement email scheduling backend`); these backend milestone changes were subsequently committed before Slack and search work. Frontend code was not modified in that milestone. `.env` remains untouched. |

Known boundaries: MySQL, Redis, and SMTP cannot share one atomic transaction. Startup reconciliation and same-key retries repair pending outbox work. Redis Lua makes each sender reservation atomic and uses Redis server time, but data loss can erase recent rate history. A reservation is conservative: a crash before SMTP consumes quota until its 60-minute entry expires. A crash after SMTP acceptance but before MySQL records success remains ambiguous and can lead to duplicate delivery. Exactly-once SMTP delivery is not claimed.

Commands run for this milestone (from `backend/`, using the Node 22/npm 10 toolchain and command-scoped local connection values; `.env` was not created or edited): `npm run prisma:generate`, `npm run prisma:validate`, `npm run typecheck`, `npm run build`, `npm run db:migrate`, `npx prisma migrate status`, and `npm test`. The migration was applied to the existing development database without reset/recreation. The suite reports 19 passed, 0 failed. Real SMTP was not exercised because credentials are absent.

### Rate-limit semantics

- `EMAIL_MIN_SEND_DELAY_MS` defaults to 1000 ms and is measured between atomic Redis send-start reservations immediately before SMTP invocation. `0` disables the interval.
- `SENDER_MAX_EMAILS_PER_HOUR` defaults to 100 unique email reservations in any rolling 60-minute window. `Sender.hourlyLimit`, when non-null, overrides the default for that sender.
- Sender ID scopes the Redis keys. A Lua script checks/prunes the sorted set, checks the previous reservation time, and writes the unique email reservation and sender's last-start time as one operation.
- A retry with the same email ID reuses its quota reservation while present in the rolling window. It must still satisfy the minimum interval. A denied job is moved into BullMQ's delayed state and the MySQL row remains `SCHEDULED`; no SMTP attempt is recorded.
- An effective hourly limit of `0` disables sending. The Lua script fails closed without changing the quota set; jobs remain `SCHEDULED` and are parked for 24 hours between checks to avoid a retry loop. Set that sender's `hourlyLimit` to a positive number, or set it to `null` and configure a positive global default, to resume. A worker restart is required for environment changes; the delayed job is reconsidered within 24 hours after the change/restart. Global env validation requires a positive value, while the limiter still fails closed if passed zero.
- Redis errors return the row to `SCHEDULED` and use bounded BullMQ exponential retries. If these infrastructure retries exhaust, startup reconciliation restores it after Redis recovers. Redis persistence/AOF is required to retain recent quota history over Redis restarts.

## Environment validation update (2026-10-17)

This follow-up supersedes the earlier blocked install/build/runtime results below. It records checks actually completed after that audit.

| Check | Result |
|---|---|
| System toolchain | Node v18.19.1, npm 9.2.0; Docker 29.7.2; Docker Compose v5.5.0. System Node/npm remain unchanged. |
| Supported local toolchain | PASS: Node v22.23.3 and npm 10.9.9 installed under `/tmp/reachinbox-toolchain` and used for builds. No version manager was available. |
| Frontend dependency install | PASS: `npm ci` from `frontend/package-lock.json`; initial Node 18/npm 9 install had engine warnings and omitted a native optional binding. Reinstall under Node 22/npm 10 succeeded; lockfile unchanged. |
| Backend dependency install | PASS at the initial environment audit; the backend lockfile was later updated for this milestone and clean `npm ci` from the updated lockfile also passed. |
| Frontend production build | PASS under Node 22.23.3/npm 10.9.9 (`tsc -b && vite build`; Vite 8.3.4). |
| Backend typecheck and production build | PASS under Node 22.23.3/npm 10.9.9 (`npm run typecheck`, `npm run build`). |
| Backend health endpoint | PASS in host context: `GET http://127.0.0.1:3000/health` returned HTTP 200 and `{"status":"ok"}`. The sandboxed network probe could not connect, so the successful check was run outside the network-restricted sandbox. Backend was stopped after the probe. |
| Compose configuration | PASS: `docker compose config --quiet`. |
| Docker daemon | PASS with elevated Docker socket access. Without elevation, API access returned permission denied. Socket exists as `nobody:nogroup`, mode `660`; systemd status cannot be queried in this environment (`Failed to connect to bus: Operation not permitted`). This is an access boundary, not evidence that the daemon is stopped. |
| MySQL and Redis | PASS: both containers started and report healthy. Redis `PING` returned `PONG`; MySQL app-account `SELECT 1` returned `1`. |
| Host port adjustment | Initial `docker compose up -d` could not bind MySQL to 127.0.0.1:3306 because that host port is already occupied. Retried with `MYSQL_PORT=13306`; MySQL is healthy at host port 13306 and Redis at 6379. No existing listener was changed. |
| Environment files / Git | `.env` is absent; no secrets read or written. `git status` shows only this untracked handoff file; both lockfiles are unchanged. |

Commands executed in this follow-up include `npm ci --no-audit --no-fund` in each app directory, frontend `npm run build`, backend `npm run typecheck` and `npm run build`, an HTTP curl health probe, `docker compose config --quiet`, `docker compose up -d`, `docker compose ps`, `docker compose exec -T redis redis-cli ping`, and a MySQL `SELECT 1` executed inside the container. Docker containers are intentionally left running with named volumes intact.

## Purpose and verified project shape

Hiring assignment: a full-stack email scheduling service with persistent delayed jobs, multiple senders, distributed rate limits, search, OAuth, Slack alerts, and a dashboard.

Current stack: React + TypeScript + Vite + Tailwind CSS; Express + TypeScript; Prisma/MySQL; BullMQ/Redis; Nodemailer SMTP; Elasticsearch email indexing/search; and Bull Board queue monitoring. Google OAuth and frontend dashboard functionality are not implemented. Slack OAuth/notifications are committed in `858f121`; the Elasticsearch/Bull Board milestone is described above. The backend exposes schedule/list/detail/search APIs and `GET /health`.

## Architecture and intended responsibilities

The current implementation covers backend scheduling, transactional outboxes, SMTP worker, sender pacing, atomic sender hourly reservations, Slack OAuth/notifications, Elasticsearch search, and protected Bull Board. Remaining assignment responsibilities include the React dashboard and compose flow, Google OAuth/session endpoints, and deployment. Keep SMTP acceptance distinct from confirmed delivery: an SMTP server accepting a message does not prove inbox delivery. Exactly-once SMTP delivery is not claimed.

## Requirement status matrix

Legend: **Verified** means supported by current source/config inspection. Validation result **BLOCKED** means a check could not execute; **NOT IMPLEMENTED** means no implementation exists. The backend foundation update above supersedes older entries below. Priority: P0 = foundation/critical path, P1 = required feature, P2 = submission/release.

| Requirement | Current implementation evidence | Validation result | Remaining work | Priority |
|---|---|---|---|---|
| Node.js, TypeScript, Express backend | `backend/package.json`, `backend/src/` | Implemented; typecheck/build PASS on Node 22 | Continue API features as later milestones require | P0 |
| MySQL relational schema | Prisma models and migration under `backend/prisma` | Implemented; migration applied and schema diff empty | Extend for future sender/admin needs | P0 |
| BullMQ backed by Redis | BullMQ queue and configured Redis connection | Implemented; delayed-job integration tests PASS | Operational monitoring later | P0 |
| Ethereal SMTP delivery | Nodemailer transport and safe config handling | Code implemented; actual delivery NOT VERIFIED (credentials absent) | Configure Ethereal and run a real test send | P1 |
| Persistent delayed scheduling; no cron | BullMQ delayed jobs plus DB transactional outbox | Implemented; recovery tests PASS; no cron used | No current work in this slice | P0 |
| Multiple senders | `Sender` relation and senderId in API; `default` seeded from config | Data model implemented; sender administration API NOT IMPLEMENTED | Add sender management later | P1 |
| Configurable worker concurrency | `WORKER_CONCURRENCY` and BullMQ Worker | Implemented by code/config; compile PASS | Validate under real SMTP load later | P1 |
| Configurable minimum send delay | `EMAIL_MIN_SEND_DELAY_MS`; Redis Lua sender start reservation | Implemented; Redis pacing and worker reschedule tests PASS | Tune for deployment needs | P1 |
| Configurable hourly quotas | `SENDER_MAX_EMAILS_PER_HOUR` default plus nullable per-sender `Sender.hourlyLimit` | Implemented as rolling 60-minute unique email reservations; integration tests PASS | Sender administration API is future work | P1 |
| Atomic rate limiting across workers | Redis Lua script uses Redis server time and sender-scoped keys | Implemented; simultaneous Redis reservations and concurrent-worker integration tests PASS | Redis persistence remains a prerequisite | P0 |
| Reschedule on quota exhaustion | BullMQ `moveToDelayed`; database email returns to `SCHEDULED` | Implemented; record-preservation and delayed worker restart tests PASS | None in this slice | P1 |
| Duplicate prevention and idempotent requests | Unique idempotency key, stable BullMQ job ID, guarded worker transitions | Implemented; serial and concurrent tests PASS | SMTP acceptance ambiguity remains | P0 |
| Restart recovery | Startup scans scheduled/stale records and reconciles Redis jobs; Redis AOF enabled | Implemented; missing-job recovery test PASS | Full kill/restart with live SMTP not run | P0 |
| Elasticsearch indexing and email search | Versioned MySQL outbox, `reachinbox-emails-v1`, validated search API | Implemented; MySQL/fake-ES tests PASS; live ES blocked by red cluster/disk watermark | Restore disk headroom and rerun live integration; add application auth before tenant use | P1 |
| Live Bull Board dashboard | Bull Board Express route with timing-safe Bearer token guard; email and Slack queues | Authorization and queue registration integration tests PASS against Redis | Configure `BULL_BOARD_TOKEN`; restrict access to trusted network | P1 |
| Slack OAuth and persistent connection management | OAuth v2 routes/service; encrypted incoming webhook and singleton deployment connection | Implemented; mocked OAuth tests PASS; additive migrations applied | Configure real Slack app; later scope to authenticated tenant | P1 |
| Slack quota notifications | Durable outbox, periodic recovery, authenticated FAILED inspection/replay, replay generations | Implemented; dedupe, retry, recovery, replay and revoke tests PASS | Live delivery unverified; operations are deployment-wide admin access | P1 |
| React or Next.js with TypeScript | React + TypeScript + Vite source/config | Present; frontend production build previously PASS | Implement application screens | P0 |
| Tailwind or modern CSS | Tailwind dependency and Vite plugin configured | Present; frontend production build previously PASS | Complete responsive design | P1 |
| Real Google OAuth login/logout/profile | No auth implementation | NOT IMPLEMENTED | OAuth client credentials, callback, session/logout, profile | P0 |
| Scheduled and sent email dashboard | Placeholder `App.tsx` only | NOT IMPLEMENTED | Add data-backed views and status states | P1 |
| Compose fields and lead upload | Placeholder only | NOT IMPLEMENTED | Subject/body, CSV/text parsing, count, schedule, delay, limit | P1 |
| Loading/empty/success/error UI | No application states | NOT IMPLEMENTED | Add accessible async states | P1 |
| Figma-inspired UI | Starter centered card; reference not inspected | NOT IMPLEMENTED / visual comparison not performed | Inspect reference and implement dashboard styling | P2 |
| Private GitHub repo and reviewer invites | No repository visibility/invite evidence in local files | NOT VERIFIED | Confirm remotely; invite `mitrajit`, `Yadav036` | P2 |
| README setup/architecture/limitations/features | README now documents backend architecture, config, migration, API, tests, reliability limits | Updated for this milestone | Keep current as features are verified | P2 |
| Demo video <=5 minutes | No artifact/evidence | NOT IMPLEMENTED | Record after stable end-to-end flow | P2 |
| Hosted URL and submission form | No deployment configuration/evidence | NOT IMPLEMENTED | Deploy and submit when ready | P2 |
| No fake OAuth/Slack, fabricated tests, or unsupported claims | Slack integration uses actual Slack endpoints; tests mock only external Slack HTTP calls | Mocked API behavior and DB/Redis validation PASS; live OAuth/delivery NOT VERIFIED | Configure a real Slack app for live verification | P0 |

## Validation performed in initial audit (superseded)

The entries in this section describe the first audit only. For the current environment state and latest results, use **Environment validation update** at the top of this document.

| Check | Command | Result |
|---|---|---|
| Working tree and branch | `git status --short --branch` | PASS: clean `main`, tracking `origin/main` |
| Recent history | `git log -5 --oneline --decorate` | PASS: one commit, `1e65c5b chore: initialize ReachInbox scheduler project` |
| Tracked files and source/config inspection | `git ls-files`, `rg --files`, `cat` of tracked project files | PASS: starter structure listed above; no test/spec files found |
| Frontend build | `cd frontend && npm run build` | BLOCKED: `tsc: not found`; `frontend/node_modules` absent |
| Backend typecheck | `cd backend && npm run typecheck` | BLOCKED: `tsc: not found`; `backend/node_modules` absent |
| Backend production build | `cd backend && npm run build` | BLOCKED: `tsc: not found`; `backend/node_modules` absent |
| Existing tests | Initial audit found no tests | Superseded: 7 backend integration tests now PASS |
| Compose syntax/config validation | `docker compose config --quiet` | PASS: configuration parsed; this does not verify services start |
| Docker/runtime services | `docker compose ps` | BLOCKED: permission denied connecting to `/var/run/docker.sock`; no container state verified |
| Toolchain | `node --version; npm --version; docker --version` | Node v18.19.1, npm 9.2.0, Docker 29.7.2; README requires Node 20+ and npm 10+ |
| API health endpoint | Not run | BLOCKED: dependencies absent and current Node is below documented prerequisite |
| MySQL/Redis runtime | Not run | BLOCKED: Docker daemon access denied; no runtime health established |

No dependency installation was attempted. No environment values were read. `.env.example` contains development placeholders; no `.env` contents were inspected or changed. No Docker volumes or databases were altered.

## Git and environment (current update)

- **Current milestone:** repository `/home/nmit/reachinbox-scheduler`; branch `main`, committed/pushed baseline `858f121` (`feat: add Slack integration and notification recovery`); Elasticsearch/Bull Board implementation and its validation state are described at the top of this handoff.
- **Verified:** dependencies are installed from both lockfiles. Ignored `node_modules`, `dist`, and TypeScript build-info artifacts are present locally and excluded from Git.
- **Verified:** root `.env` was not written or overwritten; `.env.example` contains placeholders only. No credential values were read or added.
- **Verified:** Node 22.23.3/npm 10.9.9 were restored under `/tmp/reachinbox-node22`; system Node 18/npm 9 were unchanged. Compose/MySQL/Redis run with elevated Docker access. MySQL uses host port 13306 and existing named data volumes were retained.
- **Runtime constraint:** Elasticsearch is currently `Up (unhealthy)` and the host probe cannot connect. Its logs confirm the 90% disk watermark (44.7 GB free / 9.8%) and an unassigned primary shard. I did not disable the safety threshold or delete data.
- **Still requires setup:** restore sufficient disk headroom and verify live Elasticsearch indexing/search; configure `BULL_BOARD_TOKEN`, Google OAuth, SMTP, live Slack OAuth, and eventual deployment credentials. Never put real credentials in tracked files.

## Risks and engineering decisions

- The transactional outbox closes the normal MySQL-to-Redis enqueue failure window; MySQL and Redis still cannot share one atomic transaction.
- Redis Lua reservations are atomic across workers and use a rolling one-hour sorted set. Redis AOF/persistence is required to preserve recent quota history across restarts; loss of Redis data can reset the effective quota window.
- BullMQ persists rate-delayed jobs; an integration test confirmed a delayed job remains delayed across worker close/restart. Startup reconciliation repairs missing jobs from MySQL scheduled rows.
- SMTP acceptance is not confirmed delivery. Retries after uncertain SMTP outcomes can duplicate mail. Record this limitation and use stable message/job identifiers and conservative retry policy; exactly-once delivery is not guaranteed.
- OAuth secrets and Slack tokens require secure environment configuration and protected storage. Missing Slack connections and expired/revoked tokens must not block email processing.
- Starter Express/TypeScript dependency ranges remain `latest`; new scheduling dependencies are lockfile-backed. `npm install` reported four high-severity audit findings; no forced audit fix or broad dependency upgrade was run.
- Actual SMTP delivery was not tested because no Ethereal credentials are configured. Mock transport tests cover worker state and retry behavior.
- Elasticsearch stores email bodies and recipient addresses for full-text search. The endpoint omits bodies, but indexed PII requires production TLS/authentication, controlled access, retention, and deletion handling. Search is not tenant-safe before application authentication.
- Indexing is eventually consistent. The MySQL outbox is durable and retries continue at a capped one-hour interval; persistent schema/authentication errors can therefore remain pending until the cluster is repaired.

## Remaining work after backend foundation

1. Configure Ethereal SMTP credentials and verify one real test send and preview link.
2. Continue remaining assignment requirements as separate milestones: Google OAuth and the frontend dashboard.
3. Complete hosting, reviewer access, demo video, and submission after required features are implemented and verified.

**Dependencies:** the local Node 22/npm 10 toolchain and MySQL/Redis are now available; Docker commands require elevated socket access here, and MySQL is mapped to host port 13306 because 3306 is occupied. An Ethereal SMTP account/configuration and agreed application environment variables are still required. Do not invent credentials.

## Manual actions needed

- Configure `SMTP_USER` and `SMTP_PASS` with actual Ethereal credentials to run the worker and verify real SMTP acceptance.
- Set `EMAIL_MIN_SEND_DELAY_MS` (milliseconds) and `SENDER_MAX_EMAILS_PER_HOUR` (rolling 60-minute default) in the environment as needed. A sender-specific `hourlyLimit` can be set on its `Sender` row; there is not yet a sender administration API.
- Use the Node 22/npm 10 toolchain under `/tmp/reachinbox-node22` for validation in this environment; Docker commands need elevated socket access. MySQL is mapped to host port 13306 because 3306 is occupied. Set Elasticsearch credentials and `BULL_BOARD_TOKEN` in the untracked `.env` only when available.
- Configure Google OAuth and eventual hosting credentials securely when those milestones begin. For Slack, create an app and provide the five documented optional environment values before OAuth can be used.
- Confirm GitHub repository privacy and reviewer invitations when ready to submit.

This handoff records the verified backend scheduling, rate-limit, and Slack integration implementation. Live Slack credentials were unavailable; no frontend or unrelated integration milestone was started.
