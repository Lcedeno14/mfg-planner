/**
 * server.js — the REST API and (in production) the static file host.
 *
 * ── System design: where this sits ──────────────────────────────────────────
 * The app is a classic three-layer setup:
 *
 *   Angular SPA  ──HTTP/JSON──▶  this Express server  ──SQL──▶  Microsoft SQL Server
 *
 * The frontend never touches the database; it only speaks HTTP to /api/*.
 * That boundary is what lets the two halves evolve independently.
 *
 * The API follows REST conventions, which map HTTP verbs onto data operations:
 *   GET    read            (no side effects, safe to retry)
 *   POST   create          (201 Created on success)
 *   PATCH  partial update  (send only the fields you're changing)
 *   PUT    replace/upsert  (idempotent: same request twice = same result)
 *   DELETE remove
 * Status codes carry meaning too: 400 = you sent something invalid,
 * 404 = that id doesn't exist, 409 = conflicts with existing data.
 * Errors always return JSON like { error: "human-readable reason" } so the
 * frontend can show the message directly to the user.
 *
 * ── Everything here is async ────────────────────────────────────────────────
 * The database is reached over the network, so every query returns a Promise
 * and every route handler is an `async` function that awaits it. Express 5
 * forwards a rejected promise from a handler to the error middleware at the
 * bottom of this file, so a failed query becomes a clean JSON 500 rather than
 * a hung request.
 *
 * ── Startup order ───────────────────────────────────────────────────────────
 * The pool connects and the schema is verified BEFORE the port opens. If the
 * database is unreachable or the tables are missing, the process exits with an
 * actionable message instead of accepting requests it cannot serve.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
// Middleware runs on every request before the route handlers:
app.use(cors());          // adds CORS headers so a browser on another origin may call us
app.use(express.json());  // parses JSON request bodies into req.body

// Day index convention used everywhere (DB, API, frontend): 0=Mon .. 5=Sat.
// Storing the index instead of the name keeps rows compact and sortable.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------- helpers ----------
/**
 * Builds the complete "board" for one week: every department with its
 * deliverables (each carrying its serials), its six day plans, and computed
 * scorecard totals — plus cross-department day totals for the Andon strip.
 *
 * Design choice: the server assembles this whole nested structure in ONE
 * response instead of making the frontend stitch together four endpoints.
 * One round trip, and every consumer (board page, report page) gets identical
 * numbers because the totals are computed in exactly one place.
 */
async function weekPayload(weekId) {
  const week = await db.get('SELECT * FROM WP_weeks WHERE id = ?', [weekId]);
  if (!week) return null; // caller turns this into a 404

  // Four queries issued together rather than one after another. Each round
  // trip to SQL Server costs network latency, so Promise.all overlaps them —
  // the total wait is the slowest query, not the sum of all four.
  const [departments, deliverables, serials, dayPlans] = await Promise.all([
    db.all('SELECT * FROM WP_departments ORDER BY sort, id'),
    db.all('SELECT * FROM WP_deliverables WHERE week_id = ? ORDER BY sort, id', [weekId]),
    // JOIN because serials don't store week_id — their week is reachable only
    // through their parent deliverable.
    db.all(`SELECT s.* FROM WP_serials s JOIN WP_deliverables d ON d.id = s.deliverable_id
            WHERE d.week_id = ? ORDER BY s.id`, [weekId]),
    db.all('SELECT * FROM WP_day_plans WHERE week_id = ? ORDER BY department_id, day', [weekId]),
  ]);

  const depts = departments.map(dep => {
    // { ...d, serials: [...] } copies the row and attaches its children —
    // spread syntax is the idiomatic "clone + extend" in modern JS.
    const dels = deliverables.filter(d => d.department_id === dep.id).map(d => ({
      ...d,
      serials: serials.filter(s => s.deliverable_id === d.id),
    }));
    // Guarantee exactly one entry per weekday even if the DB row doesn't exist
    // yet (e.g. Saturday on weeks created before Saturday was added). The
    // frontend can then render a fixed six-row table with no special cases,
    // and the first PUT /api/day-plans will create the missing row.
    const days = DAYS.map((name, i) => {
      const dp = dayPlans.find(p => p.department_id === dep.id && p.day === i) || null;
      return dp ? { ...dp, name } : { id: null, week_id: weekId, department_id: dep.id, day: i, name, goal: 0, actual: 0, goal_note: '', shift2_plan: '', shift1_note: '', shift2_note: '', comment: '' };
    });
    // Department scorecard is driven by the daily plan only; deliverable
    // progress is tracked separately through serial-number completion.
    const weekGoal = days.reduce((a, d) => a + d.goal, 0);
    const weekActual = days.reduce((a, d) => a + d.actual, 0);
    return { ...dep, deliverables: dels, days, weekGoal, weekActual };
  });

  // Column totals for the Andon strip: for each day, sum across departments.
  const dayScore = DAYS.map((name, i) => {
    const goal = depts.reduce((a, d) => a + d.days[i].goal, 0);
    const actual = depts.reduce((a, d) => a + d.days[i].actual, 0);
    return { name, day: i, goal, actual };
  });
  // The Week tile is the sum of the day tiles, not of the deliverable goals.
  const overall = {
    goal: dayScore.reduce((a, d) => a + d.goal, 0),
    actual: dayScore.reduce((a, d) => a + d.actual, 0),
  };
  return { ...week, departments: depts, dayScore, overall };
}

// ---------- weeks ----------
app.get('/api/weeks', async (req, res) => {
  // Newest first — the board defaults to selecting the first entry.
  res.json(await db.all('SELECT * FROM WP_weeks ORDER BY week_of DESC'));
});

app.get('/api/weeks/:id', async (req, res) => {
  // :id is a route parameter; Express exposes it as req.params.id (a string,
  // hence the Number() conversion before comparing against integer ids).
  const payload = await weekPayload(Number(req.params.id));
  if (!payload) return res.status(404).json({ error: 'Week not found' });
  res.json(payload);
});

// Any date in a week resolves to that week's Monday, so two dates in the
// same Mon-Sun range always collide on the same canonical week_of.
// All math is done in UTC (Date.UTC / getUTCDay) — local-time Date parsing
// can shift a bare date by a day depending on the machine's timezone.
function mondayOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); // JS months are 0-based
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // step back to Monday
  return d.toISOString().slice(0, 10);
}

app.post('/api/weeks', async (req, res) => {
  const { week_of, copyFromWeekId } = req.body;
  // Validate before touching the database — the earlier a bad request is
  // rejected, the simpler every later line gets to be.
  if (!week_of) return res.status(400).json({ error: 'week_of is required (ISO date)' });
  const monday = mondayOf(week_of);
  if (!monday) return res.status(400).json({ error: 'week_of must be an ISO date (YYYY-MM-DD)' });
  // Normalize existing rows too: weeks created before validation may sit on a
  // non-Monday date but still claim their whole Mon-Sun range.
  const weeks = await db.all('SELECT * FROM WP_weeks');
  const exists = weeks.find(w => mondayOf(w.week_of) === monday);
  if (exists) {
    // 409 Conflict — the request is well-formed but collides with existing state.
    return res.status(409).json({
      error: `That date falls in the week of ${monday}, which already exists (${exists.label}). Pick a date in a different week.`,
    });
  }

  // One transaction: a week is only useful with its day-plan grid, so either
  // the week and all its rows are created, or nothing is.
  const weekId = await db.withTransaction(async tx => {
    const id = await db.insert(
      'INSERT INTO WP_weeks (week_of, label) VALUES (?,?)', [monday, 'Wk of ' + monday], tx);

    // Pre-create the six day rows per department so the board is fully editable
    // the moment the week opens.
    const departments = await db.all('SELECT id FROM WP_departments', [], tx);
    for (const dep of departments) {
      for (let d = 0; d < DAYS.length; d++) {
        await db.insert('INSERT INTO WP_day_plans (week_id, department_id, day) VALUES (?,?,?)', [id, dep.id, d], tx);
      }
    }

    // Optional convenience: clone the previous week's deliverables so a new week
    // starts from last week's plan instead of a blank slate.
    if (copyFromWeekId) {
      const src = await db.all('SELECT * FROM WP_deliverables WHERE week_id = ?', [copyFromWeekId], tx);
      for (const d of src) {
        await db.insert(
          'INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)',
          [id, d.department_id, d.op_code, d.op_name, d.goal, d.sort], tx);
      }
    }
    return id;
  });

  // 201 Created + the full board, so the frontend can render without a refetch.
  res.status(201).json(await weekPayload(weekId));
});

app.delete('/api/weeks/:id', async (req, res) => {
  // ON DELETE CASCADE (see scripts/create-tables.sql) removes the week's
  // deliverables, their serials, and its day plans — one statement, whole tree.
  await db.run('DELETE FROM WP_weeks WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- deliverables ----------
app.post('/api/deliverables', async (req, res) => {
  // Destructuring with a default (goal = 0) — absent fields get sane values.
  const { week_id, department_id, op_code, op_name, goal = 0 } = req.body;
  if (!week_id || !department_id || !op_code) return res.status(400).json({ error: 'week_id, department_id and op_code are required' });
  // New rows go to the end of their card: next sort = MAX(sort)+1, with
  // COALESCE turning the NULL from an empty table into 0.
  const { s: sort } = await db.get(
    'SELECT COALESCE(MAX(sort)+1,0) AS s FROM WP_deliverables WHERE week_id=? AND department_id=?',
    [week_id, department_id]);
  const id = await db.insert(
    'INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)',
    [week_id, department_id, op_code, op_name || '', goal, sort]);
  // Return the row as stored (re-selected, not echoed from input) plus an
  // empty serials array so it matches the shape weekPayload produces.
  const row = await db.get('SELECT * FROM WP_deliverables WHERE id=?', [id]);
  res.status(201).json({ ...row, serials: [] });
});

app.patch('/api/deliverables/:id', async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM WP_deliverables WHERE id=?', [id]);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  // The PATCH pattern: default every field to its current value, so the
  // client sends only what changed and everything else survives untouched.
  const { op_code = cur.op_code, op_name = cur.op_name, goal = cur.goal } = req.body;
  await db.run('UPDATE WP_deliverables SET op_code=?, op_name=?, goal=? WHERE id=?', [op_code, op_name, goal, id]);
  res.json(await db.get('SELECT * FROM WP_deliverables WHERE id=?', [id]));
});

app.delete('/api/deliverables/:id', async (req, res) => {
  await db.run('DELETE FROM WP_deliverables WHERE id=?', [Number(req.params.id)]); // cascades to its serials
  res.json({ ok: true });
});

// ---------- serials ----------
// Nested route: a serial can't exist without a deliverable, and the URL
// encodes that ownership — POST /api/deliverables/42/serials.
app.post('/api/deliverables/:id/serials', async (req, res) => {
  const { sn } = req.body;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const id = await db.insert(
    'INSERT INTO WP_serials (deliverable_id, sn, done) VALUES (?,?,0)', [Number(req.params.id), sn]);
  res.status(201).json(await db.get('SELECT * FROM WP_serials WHERE id=?', [id]));
});

app.patch('/api/serials/:id', async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM WP_serials WHERE id=?', [id]);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { sn = cur.sn, done = cur.done } = req.body;
  // done ? 1 : 0 normalizes any truthy input (true, 1, "yes") to the 0/1 the
  // schema stores — never trust client input to already be in storage form.
  await db.run('UPDATE WP_serials SET sn=?, done=? WHERE id=?', [sn, done ? 1 : 0, id]);
  res.json(await db.get('SELECT * FROM WP_serials WHERE id=?', [id]));
});

app.delete('/api/serials/:id', async (req, res) => {
  await db.run('DELETE FROM WP_serials WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- day plans ----------
// PUT rather than POST because the client addresses a cell by its natural key
// (week + department + day), not by row id — the UNIQUE constraint in the
// schema guarantees at most one row per cell, and this handler updates-or-
// inserts ("upsert"). Saving the same cell twice is harmless: PUT is idempotent.
app.put('/api/day-plans', async (req, res) => {
  const { week_id, department_id, day, goal, actual, goal_note, shift2_plan, shift1_note, shift2_note, comment } = req.body;
  // == null catches both null and undefined but lets 0 through — important
  // here because day 0 (Monday) and goal 0 are perfectly valid values.
  if (week_id == null || department_id == null || day == null) return res.status(400).json({ error: 'week_id, department_id, day are required' });
  const cur = await db.get(
    'SELECT * FROM WP_day_plans WHERE week_id=? AND department_id=? AND day=?', [week_id, department_id, day]);
  if (cur) {
    // ?? (nullish coalescing) keeps the stored value when a field wasn't sent:
    // goal ?? cur.goal means "use the new goal unless it's null/undefined".
    // A plain || would wrongly discard legitimate 0s and empty strings.
    await db.run(
      `UPDATE WP_day_plans SET goal=?, actual=?, goal_note=?, shift2_plan=?, shift1_note=?, shift2_note=?, comment=? WHERE id=?`,
      [goal ?? cur.goal, actual ?? cur.actual, goal_note ?? cur.goal_note, shift2_plan ?? cur.shift2_plan,
       shift1_note ?? cur.shift1_note, shift2_note ?? cur.shift2_note, comment ?? cur.comment, cur.id]);
    return res.json(await db.get('SELECT * FROM WP_day_plans WHERE id=?', [cur.id]));
  }
  const id = await db.insert(
    `INSERT INTO WP_day_plans (week_id, department_id, day, goal, actual, goal_note, shift2_plan, shift1_note, shift2_note, comment)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [week_id, department_id, day, goal ?? 0, actual ?? 0, goal_note ?? '', shift2_plan ?? '',
     shift1_note ?? '', shift2_note ?? '', comment ?? '']);
  res.status(201).json(await db.get('SELECT * FROM WP_day_plans WHERE id=?', [id]));
});

// ---------- departments & op catalog ----------
app.get('/api/departments', async (req, res) => {
  res.json(await db.all('SELECT * FROM WP_departments ORDER BY sort, id'));
});

app.post('/api/departments', async (req, res) => {
  const { name, color } = req.body;
  // .trim() twice over: reject names that are only whitespace, and store
  // without stray spaces.
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const { s: sort } = await db.get('SELECT COALESCE(MAX(sort)+1,0) AS s FROM WP_departments');
  const id = await db.insert(
    'INSERT INTO WP_departments (name, color, sort) VALUES (?,?,?)', [name.trim(), color || '#0078a9', sort]);
  res.status(201).json(await db.get('SELECT * FROM WP_departments WHERE id=?', [id]));
});

app.patch('/api/departments/:id', async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM WP_departments WHERE id=?', [id]);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { name = cur.name, color = cur.color, sort = cur.sort, second_shift = cur.second_shift } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  await db.run('UPDATE WP_departments SET name=?, color=?, sort=?, second_shift=? WHERE id=?',
    [name.trim(), color, sort, second_shift ? 1 : 0, id]);
  res.json(await db.get('SELECT * FROM WP_departments WHERE id=?', [id]));
});

app.delete('/api/departments/:id', async (req, res) => {
  const id = Number(req.params.id);
  // The department foreign keys are intentionally NO ACTION (see the cascade
  // note in scripts/create-tables.sql), so the department's rows are removed
  // here, in order, inside one transaction: children before parents, and the
  // whole thing rolls back if any step fails. Serials go via their deliverables'
  // cascade. The frontend confirms loudly before calling this.
  const removed = await db.withTransaction(async tx => {
    const dayPlans = await db.run('DELETE FROM WP_day_plans WHERE department_id=?', [id], tx);
    const deliverables = await db.run('DELETE FROM WP_deliverables WHERE department_id=?', [id], tx);
    const ops = await db.run('DELETE FROM WP_op_catalog WHERE department_id=?', [id], tx);
    await db.run('DELETE FROM WP_departments WHERE id=?', [id], tx);
    return { dayPlans: dayPlans.rowsAffected, deliverables: deliverables.rowsAffected, ops: ops.rowsAffected };
  });
  res.json({ ok: true, removed });
});

app.get('/api/ops', async (req, res) => {
  // The JOIN denormalizes department_name onto each op so the frontend can
  // label and group without a second lookup.
  res.json(await db.all(
    `SELECT o.*, d.name AS department_name FROM WP_op_catalog o
     JOIN WP_departments d ON d.id=o.department_id ORDER BY o.op_code`));
});

app.post('/api/ops', async (req, res) => {
  const { department_id, op_code, op_name, avg_labor_hours = 0 } = req.body;
  if (!department_id || !op_code || !op_code.trim()) return res.status(400).json({ error: 'department_id and op_code are required' });
  // Referential check with a friendly 400 — otherwise a bad department_id
  // would surface as an opaque SQL foreign-key error.
  const dept = await db.get('SELECT id FROM WP_departments WHERE id=?', [department_id]);
  if (!dept) return res.status(400).json({ error: 'Unknown department' });
  const id = await db.insert(
    'INSERT INTO WP_op_catalog (department_id, op_code, op_name, avg_labor_hours) VALUES (?,?,?,?)',
    [department_id, op_code.trim(), (op_name || '').trim(), avg_labor_hours]);
  res.status(201).json(await db.get(
    `SELECT o.*, d.name AS department_name FROM WP_op_catalog o
     JOIN WP_departments d ON d.id=o.department_id WHERE o.id=?`, [id]));
});

app.patch('/api/ops/:id', async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.get('SELECT * FROM WP_op_catalog WHERE id=?', [id]);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { department_id = cur.department_id, op_code = cur.op_code, op_name = cur.op_name, avg_labor_hours = cur.avg_labor_hours } = req.body;
  if (!op_code || !op_code.trim()) return res.status(400).json({ error: 'op_code is required' });
  const dept = await db.get('SELECT id FROM WP_departments WHERE id=?', [department_id]);
  if (!dept) return res.status(400).json({ error: 'Unknown department' });
  await db.run('UPDATE WP_op_catalog SET department_id=?, op_code=?, op_name=?, avg_labor_hours=? WHERE id=?',
    [department_id, op_code.trim(), (op_name || '').trim(), avg_labor_hours, id]);
  res.json(await db.get(
    `SELECT o.*, d.name AS department_name FROM WP_op_catalog o
     JOIN WP_departments d ON d.id=o.department_id WHERE o.id=?`, [id]));
});

app.delete('/api/ops/:id', async (req, res) => {
  // Only removes the catalog entry. Deliverables copied the op's code/name at
  // planning time (snapshot pattern), so existing boards keep it.
  await db.run('DELETE FROM WP_op_catalog WHERE id=?', [Number(req.params.id)]);
  res.json({ ok: true });
});

// ---------- active units + suggestion engine (v1: heuristic; data ~80% accurate) ----------
app.get('/api/active-units', async (req, res) => {
  res.json(await db.all('SELECT * FROM WP_active_units ORDER BY sn'));
});

app.get('/api/suggestions', async (req, res) => {
  // Groups active units by their current op, then proposes a weekly goal per op
  // based on average labor hours vs a 40h/week single-resource capacity per department.
  // This is deliberately a transparent heuristic, not a black box — planners
  // can check its math, which builds the trust needed to act on it.
  const [units, ops] = await Promise.all([
    db.all('SELECT * FROM WP_active_units'),
    db.all(`SELECT o.*, d.name AS department_name, d.id AS dept_id, d.color
            FROM WP_op_catalog o JOIN WP_departments d ON d.id=o.department_id`),
  ]);
  // Classic group-by-key build: byOp['Op 130'] = [unit, unit, ...].
  const byOp = {};
  units.forEach(u => { (byOp[u.current_op_code] = byOp[u.current_op_code] || []).push(u); });

  const WEEK_HOURS = 40;
  const suggestions = ops
    .filter(op => byOp[op.op_code]?.length) // ?. = optional chaining: safe when no units queue at this op
    .map(op => {
      const queued = byOp[op.op_code];
      // How many units fit in a 40h week at this op's average labor hours;
      // the guards handle avg_labor_hours of 0 and always allow at least 1.
      const capacity = op.avg_labor_hours > 0 ? Math.max(1, Math.floor(WEEK_HOURS / op.avg_labor_hours)) : queued.length;
      // Suggest no more than is actually queued.
      const suggestedGoal = Math.min(queued.length, capacity);
      // Units whose last transaction is >= 4 days old probably moved on
      // without being scanned (the data is ~80% accurate) — flag, don't hide.
      const stale = queued.filter(u => /(\d+)d/.test(u.last_txn) && Number(u.last_txn.match(/(\d+)d/)[1]) >= 4);
      return {
        department_id: op.dept_id,
        department_name: op.department_name,
        color: op.color,
        op_code: op.op_code,
        op_name: op.op_name,
        avg_labor_hours: op.avg_labor_hours,
        queued: queued.map(u => ({ sn: u.sn, hours_at_op: u.hours_at_op, last_txn: u.last_txn })),
        suggested_goal: suggestedGoal,
        est_hours: suggestedGoal * op.avg_labor_hours,
        verify: stale.map(u => u.sn), // no recent transaction — likely already moved; confirm with the floor
      };
    })
    // Two-level sort: by department, then op code. || works because
    // localeCompare returns 0 (falsy) on a tie, letting the next key decide.
    .sort((a, b) => a.department_name.localeCompare(b.department_name) || a.op_code.localeCompare(b.op_code));

  res.json({
    generated_at: new Date().toISOString(),
    accuracy_note: 'Built from the transaction snapshot (~80% accurate). Units flagged "verify" have no recent transactions — confirm location with the floor before committing goals.',
    week_hours_assumption: WEEK_HOURS,
    suggestions,
  });
});

// Apply a suggestion to a week as a deliverable (with its queued SNs)
app.post('/api/suggestions/apply', async (req, res) => {
  const { week_id, department_id, op_code, op_name, goal, sns = [] } = req.body;
  if (!week_id || !department_id || !op_code) return res.status(400).json({ error: 'week_id, department_id, op_code required' });
  // Transaction: a deliverable without its serial numbers would be a
  // half-applied suggestion, so both land together or neither does.
  const id = await db.withTransaction(async tx => {
    const { s: sort } = await db.get(
      'SELECT COALESCE(MAX(sort)+1,0) AS s FROM WP_deliverables WHERE week_id=? AND department_id=?',
      [week_id, department_id], tx);
    const delId = await db.insert(
      'INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)',
      [week_id, department_id, op_code, op_name || '', goal || sns.length, sort], tx);
    for (const sn of sns) {
      await db.insert('INSERT INTO WP_serials (deliverable_id, sn, done) VALUES (?,?,0)', [delId, sn], tx);
    }
    return delId;
  });
  res.status(201).json({ ok: true, deliverable_id: id });
});

// ---------- static hosting (production mode) ----------
// After `ng build`, the compiled frontend lands in frontend/dist. If that
// folder exists, this server does double duty as the web host — one process
// serves both the API and the app, so deployment is just "run node".
const fs = require('fs');
const distDir = path.join(__dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir)); // serves JS/CSS/images by filename
  // SPA fallback: any non-/api URL returns index.html, because routes like
  // /settings exist only in Angular's router, not as files on disk. Without
  // this, refreshing the browser on /settings would 404.
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

// ---------- error handling ----------
// Express 5 routes a rejected promise from an async handler to here. Without
// this, a database failure would leave the request hanging until it timed out.
// The client always gets JSON, and the full error goes to the server log.
app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) return next(err);
  // Not every error is ours: body-parser rejects malformed JSON with its own
  // 4xx status, and echoing that back is more useful to the caller than a
  // blanket 500. Only genuinely unexpected failures become 500.
  const status = err.status || err.statusCode || 500;
  const message = status === 400
    ? 'Malformed request body — expected valid JSON.'
    : 'Server error — check the server log for details.';
  res.status(status).json({ error: message });
});

// ---------- startup ----------
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await db.connect();       // fail fast if the database is unreachable
    await db.verifySchema();  // ...or if the tables were never created
  } catch (err) {
    console.error('\nCould not start: ' + (err.message || err));
    console.error('\nCheck backend/.env, that SQL Server is reachable, and that "npm run db:setup" has been run.\n');
    process.exit(1);
  }
  const empty = await db.get('SELECT COUNT(*) AS c FROM WP_departments');
  if (empty.c === 0) {
    console.log('Note: no departments yet. Add them on the Setup page, or run "npm run db:seed" for demo data.');
  }
  app.listen(PORT, () => console.log(`Planner API listening on http://localhost:${PORT}`));
}

// Close the pool cleanly on Ctrl-C so SQL Server isn't left holding connections.
process.on('SIGINT', async () => { await db.close().catch(() => {}); process.exit(0); });
process.on('SIGTERM', async () => { await db.close().catch(() => {}); process.exit(0); });

start();
