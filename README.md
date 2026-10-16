# ReachInbox Email Scheduler

A minimal full-stack foundation for the ReachInbox email scheduler assignment.

## Local infrastructure: MySQL and Redis

Milestone 2 adds only local MySQL and Redis services. The frontend and backend are not built or started by Docker Compose yet.

Create a local environment file from the safe example, then start both services from the repository root:

```sh
cp .env.example .env
docker compose up -d
```

On PowerShell, use `Copy-Item .env.example .env` for the first command. The values in `.env.example` are development-only placeholders. Replace all passwords with strong, private values before any deployment; keep `.env` out of version control.

Inspect service state and health:

```sh
docker compose ps
docker compose logs --follow mysql redis
```

Stop the containers while preserving data:

```sh
docker compose stop
```

Restart stopped containers:

```sh
docker compose restart
```

To remove the containers and network while preserving data, run `docker compose down`. MySQL and Redis store their data in named volumes, so it remains when containers are stopped, restarted, or recreated. **Do not run `docker compose down -v` unless you intend to permanently delete both named volumes and all database/cache data.**

MySQL is published on `127.0.0.1:3306` and Redis on `127.0.0.1:6379` by default. Change `MYSQL_PORT` or `REDIS_PORT` in `.env` to use different local host ports. Redis is bound to localhost and is not exposed publicly.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- Docker Desktop with Docker Compose v2

## Install

```sh
cd frontend && npm install
cd ../backend && npm install
```

## Development

Run each application in a separate terminal:

```sh
cd frontend && npm run dev
```

```sh
cd backend && npm run dev
```

The frontend runs on Vite's local development URL. The backend listens on port 3000 by default and exposes `GET /health`.

## Type-check and production builds

```sh
cd frontend && npm run build
cd ../backend && npm run typecheck && npm run build
```

The backend production output is written to `backend/dist`; run it with `node backend/dist/index.js` from the repository root.

## Folder structure

```text
reachinbox-scheduler/
├── frontend/          # React, Vite, TypeScript, and Tailwind CSS
│   └── src/
├── backend/           # Express and TypeScript API
│   └── src/
├── docker-compose.yml # Local MySQL and Redis services only
├── .env.example       # Placeholder configuration only
├── .gitignore
└── README.md
```