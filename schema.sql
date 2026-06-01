-- Task manager schema. Apply with:
--   local:  npx wrangler d1 execute task-manager-db --local --file=./schema.sql
--   remote: npx wrangler d1 execute task-manager-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  notes       TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'backlog', -- backlog | todo | doing | done
  priority    TEXT    NOT NULL DEFAULT 'normal', -- low | normal | high
  due_date    TEXT,                              -- ISO date (YYYY-MM-DD) or NULL
  reminded_at TEXT,                              -- when a due-reminder email was last sent, or NULL
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due    ON tasks(due_date);
