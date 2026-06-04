# Tasks — a minimal personal task manager

A single Cloudflare Worker that serves a clean HTML frontend **and** a JSON API,
backed by Cloudflare **D1** (SQLite). One project, one deploy.

## Stack
- **Frontend:** one static `public/index.html` (no framework, no build step)
- **Backend:** Worker in `src/index.js` (REST API under `/api/tasks`)
- **Database:** Cloudflare D1 (SQLite)

## Run locally

```bash
cd task-manager

# 1. Create the local DB schema
npx wrangler d1 execute task-manager-db --local --file=./schema.sql

# 2. Start the dev server (frontend + API + local SQLite)
npx wrangler dev
```

Open the URL it prints (usually http://localhost:8787).

## Deploy to Cloudflare

```bash
# 1. One-time: create the D1 database, then paste the printed
#    database_id into wrangler.toml
npx wrangler d1 create task-manager-db

# 2. Apply the schema to the remote DB
npx wrangler d1 execute task-manager-db --remote --file=./schema.sql

# 3. Deploy (frontend + backend together)
npx wrangler deploy
```

That's it — Wrangler prints your live `*.workers.dev` URL.

## API

| Method | Path              | Body                                            |
|--------|-------------------|-------------------------------------------------|
| GET    | `/api/tasks`      | —                                               |
| POST   | `/api/tasks`      | `{ title, notes?, status?, priority?, due_date? }` |
| PATCH  | `/api/tasks/:id`  | any subset of the above                         |
| DELETE | `/api/tasks/:id`  | —                                               |

`status`: `backlog` \| `todo` \| `doing` \| `revisit` \| `done` · `priority`: `low` \| `normal` \| `high`

The frontend is a Kanban board: drag cards between **Backlog → To Do → In Progress → To Be Revisited → Done**
(each drag PATCHes the task's `status`). New tasks land in **Backlog**. On touch devices,
where drag-and-drop doesn't fire, each card shows a status dropdown to move it between columns instead.

## Reminder emails

A daily Cron Trigger (07:00 UTC, see `wrangler.toml`) sends two kinds of email via Resend:

- **Due reminders** — any not-`done` task that's due today or overdue, emailed once.
- **Revisit reminders** — any task parked in **To Be Revisited**, emailed once a month:
  the first nudge a month after it entered the column, then again every month it stays
  there. Moving the task out of the column stops and resets the clock.

Emails only send when `RESEND_API_KEY` (and the other reminder secrets) are configured.
