// Cloudflare Worker: JSON API for the task manager.
// Static files (index.html, etc.) are served automatically from /public via the
// [assets] binding; anything under /api/* is handled here.

const VALID_STATUS = ["backlog", "todo", "doing", "revisit", "done", "archived"];
const VALID_PRIORITY = ["low", "normal", "high"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- auth endpoints (always reachable) ---
    if (url.pathname === "/api/login" && request.method === "POST") {
      return login(request, env);
    }
    if (url.pathname === "/api/logout") {
      return logout();
    }

    const authed = await isAuthed(request, env);

    // Page requests: serve the login page if not signed in, else the app.
    if (!url.pathname.startsWith("/api/")) {
      if (!authed && url.pathname !== "/login") {
        return Response.redirect(new URL("/login", url).toString(), 302);
      }
      // Already signed in but sitting on /login → send to the app.
      if (authed && url.pathname === "/login") {
        return Response.redirect(new URL("/", url).toString(), 302);
      }
      // With html_handling="none" we map clean paths to their .html assets.
      if (url.pathname === "/login") {
        return env.ASSETS.fetch(new Request(new URL("/login.html", url), request));
      }
      if (url.pathname === "/") {
        return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
      }
      return env.ASSETS.fetch(request);
    }

    // API requests beyond login/logout require a valid session.
    if (!authed) return json({ error: "Unauthorized" }, 401);

    try {
      return await route(request, env, url);
    } catch (err) {
      return json({ error: err.message || "Internal error" }, 500);
    }
  },

  // Invoked by the Cron Trigger (see [triggers] in wrangler.toml).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.all([sendDueReminders(env), sendRevisitReminders(env), archiveOldDoneTasks(env)])
    );
  },
};

// --- reminders ---------------------------------------------------------------

// Find tasks that are due today or overdue, still active, and not already
// reminded — then email them and stamp reminded_at so we don't repeat.
// 'revisit' tasks are excluded: parked tasks get the monthly nudge instead.
async function sendDueReminders(env) {
  const today = new Date().toISOString().slice(0, 10);

  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     WHERE status NOT IN ('done', 'revisit', 'archived')
       AND due_date IS NOT NULL
       AND due_date <= ?
       AND reminded_at IS NULL
     ORDER BY due_date`
  )
    .bind(today)
    .all();

  if (!results || results.length === 0) return;

  const lines = results.map((t) => {
    const overdue = t.due_date < today;
    const when = overdue ? `OVERDUE (was due ${t.due_date})` : "due today";
    return `• ${t.title} — ${when}${t.priority === "high" ? "  [high]" : ""}`;
  });

  const text =
    `You have ${results.length} task(s) needing attention:\n\n` +
    lines.join("\n") +
    `\n\n— your task manager`;

  const sent = await sendEmail(env, `⏰ ${results.length} task(s) due`, text);
  if (!sent) return;

  // Mark them reminded so the next run doesn't email them again.
  const now = new Date().toISOString();
  const ids = results.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  await env.DB.prepare(
    `UPDATE tasks SET reminded_at = ? WHERE id IN (${placeholders})`
  )
    .bind(now, ...ids)
    .run();

  console.log(`Sent reminder for ${ids.length} task(s).`);
}

// Email tasks parked in 'revisit' once a month: the first nudge lands a month
// after the task entered the column, then again every month it stays there.
async function sendRevisitReminders(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks WHERE status = 'revisit' AND revisit_at IS NOT NULL`
  ).all();

  if (!results || results.length === 0) return;

  const now = new Date();
  // A task is due for a nudge once a month has passed since the later of its
  // last revisit email and the moment it entered the column.
  const due = results.filter((t) => {
    const since = t.revisit_reminded_at || t.revisit_at;
    return now >= addOneMonth(since);
  });

  if (due.length === 0) return;

  const lines = due.map((t) => {
    const since = t.revisit_at.slice(0, 10);
    return `• ${t.title} — to be revisited (parked since ${since})${t.priority === "high" ? "  [high]" : ""}`;
  });

  const text =
    `You have ${due.length} task(s) waiting to be revisited:\n\n` +
    lines.join("\n") +
    `\n\n— your task manager`;

  const sent = await sendEmail(env, `🔁 ${due.length} task(s) to revisit`, text);
  if (!sent) return;

  // Stamp them so the next nudge is a month out from now.
  const nowIso = now.toISOString();
  const ids = due.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  await env.DB.prepare(
    `UPDATE tasks SET revisit_reminded_at = ? WHERE id IN (${placeholders})`
  )
    .bind(nowIso, ...ids)
    .run();

  console.log(`Sent revisit reminder for ${ids.length} task(s).`);
}

// --- archiving ---------------------------------------------------------------

// Tasks that have sat in 'done' for a month move to 'archived': they drop off
// the board but stay in the database (and in the Archive panel) for reference.
// done_at is left intact so the card can still show when it was finished.
async function archiveOldDoneTasks(env) {
  const cutoff = subOneMonth(new Date()).toISOString();

  const { meta } = await env.DB.prepare(
    `UPDATE tasks SET status = 'archived', updated_at = ?
     WHERE status = 'done' AND done_at IS NOT NULL AND done_at <= ?`
  )
    .bind(new Date().toISOString(), cutoff)
    .run();

  if (meta.changes > 0) console.log(`Archived ${meta.changes} done task(s).`);
}

// Calendar-month steps: handle month lengths and year rollover (e.g. Jan 31 → Feb 28).
function addOneMonth(iso) {
  const d = new Date(iso);
  d.setMonth(d.getMonth() + 1);
  return d;
}

function subOneMonth(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() - 1);
  return d;
}

// Send one email via Resend. Returns true on success, false if it was skipped
// (no API key) or the API rejected it — callers use this to decide whether to
// record that the reminder went out.
async function sendEmail(env, subject, text) {
  if (!env.RESEND_API_KEY) {
    console.log(`Email "${subject}" skipped — RESEND_API_KEY is not set.`);
    return false;
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.REMINDER_FROM,
      to: env.REMINDER_TO,
      subject,
      text,
    }),
  });

  if (!resp.ok) {
    console.log(`Resend send failed: ${resp.status} ${await resp.text()}`);
    return false;
  }
  return true;
}

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // /api/tasks
  if (pathname === "/api/tasks") {
    if (method === "GET") return listTasks(env);
    if (method === "POST") return createTask(request, env);
    return json({ error: "Method not allowed" }, 405);
  }

  // /api/tasks/:id
  const match = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === "PATCH") return updateTask(request, env, id);
    if (method === "DELETE") return deleteTask(env, id);
    return json({ error: "Method not allowed" }, 405);
  }

  return json({ error: "Not found" }, 404);
}

async function listTasks(env) {
  // The board groups by status client-side, so we only need each column sorted:
  // high priority first, then soonest due date (nulls last), then newest.
  const { results } = await env.DB.prepare(
    `SELECT * FROM tasks
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       (due_date IS NULL), due_date,
       created_at DESC`
  ).all();
  return json(results);
}

async function createTask(request, env) {
  const body = await readJson(request);
  const title = (body.title || "").trim();
  if (!title) return json({ error: "Title is required" }, 400);

  const now = new Date().toISOString();
  const task = {
    title,
    notes: (body.notes || "").trim(),
    status: VALID_STATUS.includes(body.status) ? body.status : "backlog",
    priority: VALID_PRIORITY.includes(body.priority) ? body.priority : "normal",
    due_date: body.due_date || null,
  };
  // Start the monthly-revisit clock if the task is created straight into 'revisit',
  // and the archive clock if it's created already done.
  const revisitAt = task.status === "revisit" ? now : null;
  const doneAt = task.status === "done" ? now : null;

  const { meta } = await env.DB.prepare(
    `INSERT INTO tasks (title, notes, status, priority, due_date, revisit_at, done_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      task.title,
      task.notes,
      task.status,
      task.priority,
      task.due_date,
      revisitAt,
      doneAt,
      now,
      now
    )
    .run();

  const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?")
    .bind(meta.last_row_id)
    .first();
  return json(row, 201);
}

async function updateTask(request, env, id) {
  const body = await readJson(request);

  // Build a partial update from only the fields supplied.
  const fields = [];
  const values = [];

  if (typeof body.title === "string") {
    const title = body.title.trim();
    if (!title) return json({ error: "Title cannot be empty" }, 400);
    fields.push("title = ?");
    values.push(title);
  }
  if (typeof body.notes === "string") {
    fields.push("notes = ?");
    values.push(body.notes.trim());
  }
  if (VALID_STATUS.includes(body.status)) {
    if (body.status === "revisit") {
      // Entering 'revisit' starts the monthly clock; re-saving an already-parked
      // task leaves its existing timestamps untouched (CASE reads the old row).
      fields.push("revisit_at = CASE WHEN status = 'revisit' THEN revisit_at ELSE ? END");
      values.push(new Date().toISOString());
      fields.push(
        "revisit_reminded_at = CASE WHEN status = 'revisit' THEN revisit_reminded_at ELSE NULL END"
      );
    } else {
      // Leaving 'revisit' stops and resets the clock.
      fields.push("revisit_at = NULL");
      fields.push("revisit_reminded_at = NULL");
    }

    if (body.status === "done") {
      // Entering 'done' starts the one-month archive clock; re-saving a task
      // that's already done keeps its original completion time.
      fields.push("done_at = CASE WHEN status = 'done' THEN done_at ELSE ? END");
      values.push(new Date().toISOString());
    } else if (body.status !== "archived") {
      // Moving back to an active column clears it. Archiving keeps done_at so
      // the archived card can still say when it was finished.
      fields.push("done_at = NULL");
    }

    fields.push("status = ?");
    values.push(body.status);
  }
  if (VALID_PRIORITY.includes(body.priority)) {
    fields.push("priority = ?");
    values.push(body.priority);
  }
  if ("due_date" in body) {
    fields.push("due_date = ?");
    values.push(body.due_date || null);
    // New due date → allow a fresh reminder for it.
    fields.push("reminded_at = NULL");
  }

  if (fields.length === 0) return json({ error: "Nothing to update" }, 400);

  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);

  const { meta } = await env.DB.prepare(
    `UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`
  )
    .bind(...values)
    .run();

  if (meta.changes === 0) return json({ error: "Task not found" }, 404);

  const row = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?")
    .bind(id)
    .first();
  return json(row);
}

async function deleteTask(env, id) {
  const { meta } = await env.DB.prepare("DELETE FROM tasks WHERE id = ?")
    .bind(id)
    .run();
  if (meta.changes === 0) return json({ error: "Task not found" }, 404);
  return json({ ok: true });
}

// --- auth ----------------------------------------------------------------

const COOKIE = "tm_session";
const SESSION_DAYS = 30;

async function login(request, env) {
  const body = await readJson(request);
  const user = (body.username || "").trim();
  const pass = body.password || "";

  if (user !== env.AUTH_USER || pass !== env.AUTH_PASS) {
    return json({ error: "Wrong username or password" }, 401);
  }

  const token = await signSession(env.AUTH_USER, env);
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    },
  });
}

function logout() {
  // Clear the cookie and bounce to the login page.
  return new Response(null, {
    status: 302,
    headers: {
      location: "/login",
      "set-cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
    },
  });
}

async function isAuthed(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token) return false;
  return verifySession(token, env);
}

// Session token = base64(user) . hexHmac(user). Signed with AUTH_SECRET so it
// can't be forged; no server-side storage needed.
async function signSession(user, env) {
  const payload = btoa(user);
  const sig = await hmac(payload, env);
  return `${payload}.${sig}`;
}

async function verifySession(token, env) {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(payload, env);
  // Constant-time-ish compare.
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return false;
  try {
    return atob(payload) === env.AUTH_USER;
  } catch {
    return false;
  }
}

async function hmac(data, env) {
  const secret = env.AUTH_SECRET || "dev-insecure-secret-change-me";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// --- helpers ---

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
