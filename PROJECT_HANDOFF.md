# ReachInbox Scheduler Project Handoff

Audit date: 2026-10-17 (Asia/Kolkata)

## Environment validation update (2026-10-17)

This follow-up supersedes the earlier blocked install/build/runtime results below. It records checks actually completed after that audit.

| Check | Result |
|---|---|
| System toolchain | Node v18.19.1, npm 9.2.0; Docker 29.7.2; Docker Compose v5.5.0. System Node/npm remain unchanged. |
| Supported local toolchain | PASS: Node v22.23.3 and npm 10.9.9 installed under `/tmp/reachinbox-toolchain` and used for builds. No version manager was available. |
| Frontend dependency install | PASS: `npm ci` from `frontend/package-lock.json`; initial Node 18/npm 9 install had engine warnings and omitted a native optional binding. Reinstall under Node 22/npm 10 succeeded; lockfile unchanged. |
| Backend dependency install | PASS: `npm ci` from `backend/package-lock.json`; lockfile unchanged. |
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

Current tracked stack: React + TypeScript + Vite + Tailwind CSS; Express + TypeScript; Docker Compose definitions for MySQL 8.4 and Redis 7.4. No ORM, BullMQ, SMTP, Elasticsearch, OAuth, Slack, or queue dashboard dependency or implementation is present. The frontend has a single placeholder screen. The backend exposes `GET /health` and listens on port 3000. These are verified from the current tracked files; no runtime behavior was verified.

## Architecture and intended responsibilities

The current architecture is only a starter. The assignment's intended responsibilities, pending implementation, are: React dashboard and compose flow; Express API and OAuth/session endpoints; relational persistence for users, senders, campaigns, recipients, and email status; BullMQ delayed jobs on Redis; worker-managed delivery and atomic quota enforcement; Elasticsearch indexing/search; Slack OAuth connection storage and quota notifications; Bull Board for queue operations. Keep SMTP acceptance distinct from confirmed delivery: an SMTP server accepting a message does not prove inbox delivery. Do not claim exactly-once SMTP delivery; use idempotency and duplicate prevention around job processing while documenting the delivery boundary.

## Requirement status matrix

Legend: **Verified** means supported by current source/config inspection. Validation result **BLOCKED** means a check could not execute; **NOT IMPLEMENTED** means no implementation exists in the inspected repository. Priority: P0 = foundation/critical path, P1 = required feature, P2 = submission/release.

| Requirement | Current implementation evidence | Validation result | Remaining work | Priority |
|---|---|---|---|---|
| Node.js, TypeScript, Express backend | `backend/package.json`, `backend/src/index.ts` | Verified by inspection; typecheck/build PASS on Node 22 | Implement API with pinned compatible dependencies | P0 |
| MySQL or PostgreSQL relational schema | Compose MySQL service runs; no schema/migrations | NOT IMPLEMENTED; MySQL runtime PASS | Design schema and migrations | P0 |
| BullMQ backed by Redis | Compose Redis service runs; no BullMQ dependency/code | NOT IMPLEMENTED; Redis runtime PASS | Add queue and worker | P0 |
| Ethereal SMTP delivery | No SMTP dependency/config/code | NOT IMPLEMENTED | Configure test SMTP and delivery path | P1 |
| Persistent delayed scheduling; no cron | No scheduling code; no cron found | NOT IMPLEMENTED | Use BullMQ delayed jobs and recovery | P0 |
| Multiple senders | No sender model or API | NOT IMPLEMENTED | Persist sender configurations and selection | P1 |
| Configurable worker concurrency | No worker | NOT IMPLEMENTED | Add validated worker configuration | P1 |
| Configurable minimum send delay | No worker or settings | NOT IMPLEMENTED | Enforce between sends | P1 |
| Configurable hourly quotas | No quota configuration | NOT IMPLEMENTED | Persist and enforce per sender | P1 |
| Atomic rate limiting across workers | No limiter code | NOT IMPLEMENTED | Redis atomic operation or DB transaction/locking | P0 |
| Reschedule on quota exhaustion | No queue implementation | NOT IMPLEMENTED | Delay/reschedule and notify once per quota event | P1 |
| Duplicate prevention and idempotent requests | No API/job persistence | NOT IMPLEMENTED | Idempotency keys, unique constraints, guarded transitions | P0 |
| Restart recovery | Compose config has named data volumes; application has no queues/workers | NOT IMPLEMENTED; infrastructure runtime PASS | Test delayed-job recovery after process restart | P0 |
| Elasticsearch indexing and email search | No dependency/config/code | NOT IMPLEMENTED | Index accepted/sent records and expose search | P1 |
| Live Bull Board dashboard | No dependency/config/route | NOT IMPLEMENTED | Mount authenticated queue UI | P1 |
| Real Slack OAuth and persistent connection management | No OAuth, Slack, or storage code | NOT IMPLEMENTED | OAuth flow, token storage, reconnect/disconnect | P1 |
| Slack quota notifications | No Slack integration | NOT IMPLEMENTED | Send real alerts; handle absent/reconnecting connection safely | P1 |
| React or Next.js with TypeScript | React + TypeScript + Vite source/config | Verified by inspection; frontend production build PASS | Implement application screens | P0 |
| Tailwind or modern CSS | Tailwind dependency and Vite plugin configured | Verified by inspection; frontend production build PASS | Complete responsive design | P1 |
| Real Google OAuth login/logout/profile | No auth implementation | NOT IMPLEMENTED | OAuth client credentials, callback, session/logout, profile | P0 |
| Scheduled and sent email dashboard | Placeholder `App.tsx` only | NOT IMPLEMENTED | Add data-backed views and status states | P1 |
| Compose fields and lead upload | Placeholder only | NOT IMPLEMENTED | Subject/body, CSV/text parsing, count, schedule, delay, limit | P1 |
| Loading/empty/success/error UI | No application states | NOT IMPLEMENTED | Add accessible async states | P1 |
| Figma-inspired UI | Starter centered card; reference not inspected | NOT IMPLEMENTED / visual comparison not performed | Inspect reference and implement dashboard styling | P2 |
| Private GitHub repo and reviewer invites | No repository visibility/invite evidence in local files | NOT VERIFIED | Confirm remotely; invite `mitrajit`, `Yadav036` | P2 |
| README setup/architecture/limitations/features | README documents starter setup and current health endpoint, not full assignment | Verified partial; runtime claims unverified | Update after behavior is implemented and verified | P2 |
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
| Existing tests | Package scripts and repository file inspection | NOT IMPLEMENTED: no test script or test/spec files |
| Compose syntax/config validation | `docker compose config --quiet` | PASS: configuration parsed; this does not verify services start |
| Docker/runtime services | `docker compose ps` | BLOCKED: permission denied connecting to `/var/run/docker.sock`; no container state verified |
| Toolchain | `node --version; npm --version; docker --version` | Node v18.19.1, npm 9.2.0, Docker 29.7.2; README requires Node 20+ and npm 10+ |
| API health endpoint | Not run | BLOCKED: dependencies absent and current Node is below documented prerequisite |
| MySQL/Redis runtime | Not run | BLOCKED: Docker daemon access denied; no runtime health established |

No dependency installation was attempted. No environment values were read. `.env.example` contains development placeholders; no `.env` contents were inspected or changed. No Docker volumes or databases were altered.

## Git and environment (current update)

- **Verified at follow-up:** current directory `/home/nmit/reachinbox-scheduler`; branch `main`, HEAD `1e65c5b`, tracking `origin/main`; only `PROJECT_HANDOFF.md` is an untracked project file. Frontend/backend sources and lockfiles are unchanged.
- **Verified:** dependencies are installed from both lockfiles. Ignored `node_modules`, `dist`, and TypeScript build-info artifacts are present locally and excluded from Git.
- **Verified:** root `.env` is absent; `.env.example` remains the placeholder configuration. No credential values were read or written.
- **Verified:** Node 22.23.3/npm 10.9.9 are available at `/tmp/reachinbox-toolchain` without changing system Node 18.19.1/npm 9.2.0. Docker Compose works with elevated socket access. MySQL and Redis are running with named volumes intact.
- **Runtime constraint:** host port 3306 is occupied, so this Compose project uses host port 13306 for MySQL. Docker API access is denied without elevation in this managed environment.
- **Still requires setup:** Google OAuth, Ethereal SMTP, Slack OAuth, Elasticsearch, and GitHub/deployment credentials have not been configured or verified. Never put real credentials in tracked files.

## Risks and engineering decisions

- There is no persistence model yet; queue payload/state and relational records must have a defined source of truth before a worker is added.
- A Redis counter must be atomic across workers and account for window rollover; quota exhaustion must persist a future due time and avoid hot retry loops.
- BullMQ persistence supports delayed-job recovery only if Redis persistence and job options are appropriate; verify restart behavior against actual services.
- SMTP acceptance is not confirmed delivery. Retries after uncertain SMTP outcomes can duplicate mail. Record this limitation and use stable message/job identifiers and conservative retry policy; exactly-once delivery is not guaranteed.
- OAuth secrets and Slack tokens require secure environment configuration and protected storage. Missing Slack connections and expired/revoked tokens must not block email processing.
- `latest` dependency ranges are used in package manifests; lockfile installs and builds passed with Node 22/npm 10, but future dependency updates may change compatibility. Pinning can be addressed alongside feature implementation if reproducibility becomes a problem.
- No tests exist, so behavior currently has no automated regression protection.

## Recommended implementation order and next milestone

1. **Completed:** establish a usable local toolchain and dependencies; frontend/backend builds pass.
2. Implement the persistence and queue foundation with one end-to-end scheduled email path.
3. Add quotas, sender controls, restart/idempotency guarantees, then search and Slack.
4. Add Google OAuth and complete dashboard flows; validate against the visual reference.
5. Finish README, private repository access, deployment, demo video, and submission.

**Highest-value next milestone (approval required before implementation):** establish the minimum verifiable backend scheduling vertical slice: supported Node/npm and dependencies; relational migration for a scheduled email; Redis/BullMQ delayed job; worker using Ethereal SMTP; API to create/query a scheduled email; idempotency guard; health/readiness checks. Keep worker and API configuration explicit. This exercises the required persistence and queue foundation before adding quota complexity.

**Dependencies:** the local Node 22/npm 10 toolchain and MySQL/Redis are now available; Docker commands require elevated socket access here, and MySQL is mapped to host port 13306 because 3306 is occupied. An Ethereal SMTP account/configuration and agreed application environment variables are still required. Do not invent credentials.

**Acceptance criteria:** clean frontend/backend dependency install; backend typecheck/build; migration creates the schema; API accepts a valid scheduled request idempotently and rejects invalid input; delayed job survives worker/API restart; worker sends through configured Ethereal SMTP and records SMTP acceptance separately from confirmed delivery; duplicate request/job does not intentionally send a second message; status query exposes scheduled/sending/accepted/failure states; documented integration check uses real configured services and reports exact outcomes. This milestone does not claim the remaining assignment requirements are complete.

## Manual actions needed

- Use `PATH=/tmp/reachinbox-toolchain/node_modules/.bin:$PATH` for Node 22/npm 10 in this environment; request elevated Docker access for Compose commands. Use `MYSQL_PORT=13306` when starting this Compose project while host port 3306 remains occupied.
- Configure real OAuth, Ethereal, Slack, and eventual hosting credentials securely when those milestones are approved.
- Confirm GitHub repository privacy and reviewer invitations when ready to submit.

No implementation beyond this audit and handoff has been performed. Await approval before starting the milestone above.
