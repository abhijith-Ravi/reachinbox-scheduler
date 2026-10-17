# ReachInbox Scheduler Project Handoff

Audit date: 2026-10-17 (Asia/Kolkata)

## Backend foundation milestone update (2026-10-17)

This update supersedes the initial starter-state implementation matrix and validation section below.

| Area | Current implementation and actual verification |
|---|---|
| Database | Prisma 6.19 models `Sender`, `Email`, and `EmailOutbox`; unique idempotency/job keys and status/schedule indexes. Migration `20261017000000_initial_scheduler` is recorded as applied. Its first attempt stopped on redundant `_prisma_migrations` DDL after the three app tables had been created; that DDL was removed, all three actual table definitions were inspected, then Prisma marked the migration applied. No data or volumes were reset. `prisma validate`, `migrate status`, `migrate deploy` (no pending work), and schema diff (empty) passed against MySQL at `127.0.0.1:13306`. |
| API | `POST /api/emails/schedule`, `GET /api/emails/scheduled`, `GET /api/emails/sent`, `GET /api/emails/:id`, and preserved `GET /health`. Integration tests cover validation, lists/details, replay/conflict, and concurrent idempotency. Compiled API health probe returned HTTP 200 with `{"status":"ok"}`. |
| Queue and recovery | BullMQ 6 + Redis, stable job ID per Email, SQL transactional outbox, startup reconciliation in API/worker, and same-key enqueue retry. Tests covered Redis enqueue failure recovery and restoration of a missing delayed job. No cron or periodic scheduler. |
| Worker and state | Separate worker entrypoint; configurable concurrency, capped attempts, exponential backoff, conditional transitions `SCHEDULED → PROCESSING → SENT/FAILED`, persisted attempts/errors. Mock-SMTP tests covered accepted status, duplicate job guard, and final retry failure. |
| SMTP | Nodemailer Ethereal transport is implemented and requires credentials before worker startup. Missing-credential check produced the expected clear startup error. No credentials are configured, so real Ethereal delivery and preview URL were not verified. `SENT` means SMTP acceptance, not inbox delivery. |
| Validation | PASS: clean backend `npm ci`, Prisma client generation/validation/migration state, typecheck/build, compiled API health, and all 7 DB/Redis integration tests. Tests use mocked SMTP and targeted cleanup; post-test SQL counts confirmed zero test email/outbox rows. |
| Git and files | Current base commit is `351ab28`. Changes for this milestone are local and uncommitted. Frontend code was not modified. `.env` remains absent and untouched. |

Known boundary: MySQL and Redis cannot share one atomic transaction. Startup reconciliation and same-key retries repair pending work; without a retry or restart, an enqueue failure can leave an outbox row pending. A crash after SMTP acceptance but before MySQL records success remains ambiguous and can lead to a duplicate on retry. Exactly-once SMTP delivery is not claimed.

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

Current stack: React + TypeScript + Vite + Tailwind CSS; Express + TypeScript; Prisma/MySQL; BullMQ/Redis; Nodemailer SMTP transport. Elasticsearch, Google OAuth, Slack, Bull Board, and dashboard functionality are not implemented. The frontend remains a placeholder. The backend exposes schedule/list/detail APIs and `GET /health`.

## Architecture and intended responsibilities

The current architecture is only a starter. The assignment's intended responsibilities, pending implementation, are: React dashboard and compose flow; Express API and OAuth/session endpoints; relational persistence for users, senders, campaigns, recipients, and email status; BullMQ delayed jobs on Redis; worker-managed delivery and atomic quota enforcement; Elasticsearch indexing/search; Slack OAuth connection storage and quota notifications; Bull Board for queue operations. Keep SMTP acceptance distinct from confirmed delivery: an SMTP server accepting a message does not prove inbox delivery. Do not claim exactly-once SMTP delivery; use idempotency and duplicate prevention around job processing while documenting the delivery boundary.

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
| Configurable minimum send delay | No implementation | NOT IMPLEMENTED | Implement later | P1 |
| Configurable hourly quotas | No implementation | NOT IMPLEMENTED | Implement later | P1 |
| Atomic rate limiting across workers | No implementation | NOT IMPLEMENTED | Implement later | P0 |
| Reschedule on quota exhaustion | No quota handling or Slack notification | NOT IMPLEMENTED | Implement later | P1 |
| Duplicate prevention and idempotent requests | Unique idempotency key, stable BullMQ job ID, guarded worker transitions | Implemented; serial and concurrent tests PASS | SMTP acceptance ambiguity remains | P0 |
| Restart recovery | Startup scans scheduled/stale records and reconciles Redis jobs; Redis AOF enabled | Implemented; missing-job recovery test PASS | Full kill/restart with live SMTP not run | P0 |
| Elasticsearch indexing and email search | No dependency/config/code | NOT IMPLEMENTED | Index accepted/sent records and expose search | P1 |
| Live Bull Board dashboard | No dependency/config/route | NOT IMPLEMENTED | Mount authenticated queue UI | P1 |
| Real Slack OAuth and persistent connection management | No OAuth, Slack, or storage code | NOT IMPLEMENTED | OAuth flow, token storage, reconnect/disconnect | P1 |
| Slack quota notifications | No Slack integration | NOT IMPLEMENTED | Send real alerts; handle absent/reconnecting connection safely | P1 |
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
| No fake OAuth/Slack, fabricated tests, or unsupported claims | Current code has no integrations or test claims | Verified in inspected code/docs | Keep claims tied to verified behavior | P0 |

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

- **Verified at follow-up:** current directory `/home/nmit/reachinbox-scheduler`; branch `main`, HEAD `351ab28`, tracking `origin/main`; backend milestone changes are local and uncommitted.
- **Verified:** dependencies are installed from both lockfiles. Ignored `node_modules`, `dist`, and TypeScript build-info artifacts are present locally and excluded from Git.
- **Verified:** root `.env` is absent and untouched; `.env.example` was extended with placeholder backend configuration. No credential values were read or written.
- **Verified:** Node 22.23.3/npm 10.9.9 are available at `/tmp/reachinbox-toolchain` without changing system Node 18.19.1/npm 9.2.0. Docker Compose works with elevated socket access. MySQL and Redis are running with named volumes intact.
- **Runtime constraint:** host port 3306 is occupied, so this Compose project uses host port 13306 for MySQL. Docker API access is denied without elevation in this managed environment.
- **Still requires setup:** Google OAuth, Ethereal SMTP, Slack OAuth, Elasticsearch, and GitHub/deployment credentials have not been configured or verified. Never put real credentials in tracked files.

## Risks and engineering decisions

- The transactional outbox closes the normal MySQL-to-Redis enqueue failure window; MySQL and Redis still cannot share one atomic transaction.
- A Redis counter must be atomic across workers and account for window rollover; quota exhaustion must persist a future due time and avoid hot retry loops.
- BullMQ persistence supports delayed-job recovery only if Redis persistence and job options are appropriate; verify restart behavior against actual services.
- SMTP acceptance is not confirmed delivery. Retries after uncertain SMTP outcomes can duplicate mail. Record this limitation and use stable message/job identifiers and conservative retry policy; exactly-once delivery is not guaranteed.
- OAuth secrets and Slack tokens require secure environment configuration and protected storage. Missing Slack connections and expired/revoked tokens must not block email processing.
- Starter Express/TypeScript dependency ranges remain `latest`; new scheduling dependencies are lockfile-backed. `npm install` reported four high-severity audit findings; no forced audit fix or broad dependency upgrade was run.
- Actual SMTP delivery was not tested because no Ethereal credentials are configured. Mock transport tests cover worker state and retry behavior.

## Remaining work after backend foundation

1. Configure Ethereal SMTP credentials and verify one real test send and preview link.
2. Continue remaining assignment requirements as separate milestones: quotas/rate limiting, Slack, search/Bull Board, Google OAuth, and the frontend dashboard.
3. Complete hosting, reviewer access, demo video, and submission after required features are implemented and verified.

**Dependencies:** the local Node 22/npm 10 toolchain and MySQL/Redis are now available; Docker commands require elevated socket access here, and MySQL is mapped to host port 13306 because 3306 is occupied. An Ethereal SMTP account/configuration and agreed application environment variables are still required. Do not invent credentials.

## Manual actions needed

- Configure `SMTP_USER` and `SMTP_PASS` with actual Ethereal credentials to run the worker and verify real SMTP acceptance.
- Use `PATH=/tmp/reachinbox-toolchain/node_modules/.bin:$PATH` for Node 22/npm 10 in this environment; request elevated Docker access for Compose commands. MySQL is mapped to host port 13306 because 3306 is occupied.
- Configure Google OAuth, Slack, and eventual hosting credentials securely when those later milestones begin.
- Confirm GitHub repository privacy and reviewer invitations when ready to submit.

This handoff records the verified backend foundation milestone; no frontend or later integration milestone was started.
