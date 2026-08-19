/**
 * server.js — the REST API and (in production) the static file host.
 *
 * ── System design: where this sits ──────────────────────────────────────────
 * The app is a classic three-layer setup:
 *
 *   Angular SPA  ──HTTP/JSON──▶  this Express server  ──SQL──▶  database (db.js)
 *
 * The frontend never touches the database; it only speaks HTTP to /api/*.
 * That boundary is what lets the two halves evolve independently — the
 * database can move from SQLite to SQL Server without the frontend noticing.
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
 * In development, the Angular dev server (port 4200) proxies /api requests
 * here (see frontend/proxy.conf.json) — that avoids browser CORS issues and
 * mirrors how production works, where this server serves the built frontend
 * itself (see the bottom of this file).
 */
const express = require('express');
const cors = require('cors');
const db = require('./db'); // opening db.js runs schema setup + seed on first require

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
function weekPayload(weekId) {
  const week = db.prepare('SELECT * FROM WP_weeks WHERE id = ?').get(weekId);
  if (!week) return null; // caller turns this into a 404

  // Four flat queries, then joined in JS. With SQLite in-process this is
  // effectively free; it also keeps each query trivially readable.
  const departments = db.prepare('SELECT * FROM WP_departments ORDER BY sort, id').all();
  const deliverables = db.prepare('SELECT * FROM WP_deliverables WHERE week_id = ? ORDER BY sort, id').all(weekId);
  // JOIN because serials don't store week_id — their week is reachable only
  // through their parent deliverable.
  const serials = db.prepare(`SELECT s.* FROM WP_serials s JOIN WP_deliverables d ON d.id = s.deliverable_id WHERE d.week_id = ? ORDER BY s.id`).all(weekId);
  const dayPlans = db.prepare('SELECT * FROM WP_day_plans WHERE week_id = ? ORDER BY department_id, day').all(weekId);

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
app.get('/api/weeks', (req, res) => {
  // Newest first — the board defaults to selecting the first entry.
  res.json(db.prepare('SELECT * FROM WP_weeks ORDER BY week_of DESC').all());
});

app.get('/api/weeks/:id', (req, res) => {
  // :id is a route parameter; Express exposes it as req.params.id (a string,
  // hence the Number() conversion before comparing against integer ids).
  const payload = weekPayload(Number(req.params.id));
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

app.post('/api/weeks', (req, res) => {
  const { week_of, copyFromWeekId } = req.body;
  // Validate before touching the database — the earlier a bad request is
  // rejected, the simpler every later line gets to be.
  if (!week_of) return res.status(400).json({ error: 'week_of is required (ISO date)' });
  const monday = mondayOf(week_of);
  if (!monday) return res.status(400).json({ error: 'week_of must be an ISO date (YYYY-MM-DD)' });
  // Normalize existing rows too: weeks created before validation may sit on a
  // non-Monday date but still claim their whole Mon-Sun range.
  const exists = db.prepare('SELECT * FROM WP_weeks').all().find(w => mondayOf(w.week_of) === monday);
  if (exists) {
    // 409 Conflict — the request is well-formed but collides with existing state.
    return res.status(409).json({
      error: `That date falls in the week of ${monday}, which already exists (${exists.label}). Pick a date in a different week.`,
    });
  }

  const label = 'Wk of ' + monday;
  const weekId = db.prepare('INSERT INTO WP_weeks (week_of, label) VALUES (?,?)').run(monday, label).lastInsertRowid;

  // Pre-create the six day rows per department so the board is fully editable
  // the moment the week opens.
  const departments = db.prepare('SELECT id FROM WP_departments').all();
  const insDay = db.prepare('INSERT INTO WP_day_plans (week_id, department_id, day) VALUES (?,?,?)');
  departments.forEach(dep => { for (let d = 0; d < DAYS.length; d++) insDay.run(weekId, dep.id, d); });

  // Optional convenience: clone the previous week's deliverables so a new week
  // starts from last week's plan instead of a blank slate.
  if (copyFromWeekId) {
    const src = db.prepare('SELECT * FROM WP_deliverables WHERE week_id = ?').all(copyFromWeekId);
    const insDel = db.prepare('INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)');
    src.forEach(d => insDel.run(weekId, d.department_id, d.op_code, d.op_name, d.goal, d.sort));
  }
  // 201 Created + the full board, so the frontend can render without a refetch.
  res.status(201).json(weekPayload(weekId));
});

app.delete('/api/weeks/:id', (req, res) => {
  // ON DELETE CASCADE (db.js) removes the week's deliverables, serials and
  // day plans automatically — one statement cleans up the whole tree.
  db.prepare('DELETE FROM WP_weeks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- deliverables ----------
app.post('/api/deliverables', (req, res) => {
  // Destructuring with a default (goal = 0) — absent fields get sane values.
  const { week_id, department_id, op_code, op_name, goal = 0 } = req.body;
  if (!week_id || !department_id || !op_code) return res.status(400).json({ error: 'week_id, department_id and op_code are required' });
  // New rows go to the end of their card: next sort = MAX(sort)+1, with
  // COALESCE turning the NULL from an empty table into 0.
  const sort = db.prepare('SELECT COALESCE(MAX(sort)+1,0) s FROM WP_deliverables WHERE week_id=? AND department_id=?').get(week_id, department_id).s;
  const id = db.prepare('INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)')
    .run(week_id, department_id, op_code, op_name || '', goal, sort).lastInsertRowid;
  // Return the row as stored (re-selected, not echoed from input) plus an
  // empty serials array so it matches the shape weekPayload produces.
  res.status(201).json({ ...db.prepare('SELECT * FROM WP_deliverables WHERE id=?').get(id), serials: [] });
});

app.patch('/api/deliverables/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM WP_deliverables WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  // The PATCH pattern: default every field to its current value, so the
  // client sends only what changed and everything else survives untouched.
  const { op_code = cur.op_code, op_name = cur.op_name, goal = cur.goal } = req.body;
  db.prepare('UPDATE WP_deliverables SET op_code=?, op_name=?, goal=? WHERE id=?').run(op_code, op_name, goal, cur.id);
  res.json(db.prepare('SELECT * FROM WP_deliverables WHERE id=?').get(cur.id));
});

app.delete('/api/deliverables/:id', (req, res) => {
  db.prepare('DELETE FROM WP_deliverables WHERE id=?').run(req.params.id); // cascades to its serials
  res.json({ ok: true });
});

// ---------- serials ----------
// Nested route: a serial can't exist without a deliverable, and the URL
// encodes that ownership — POST /api/deliverables/42/serials.
app.post('/api/deliverables/:id/serials', (req, res) => {
  const { sn } = req.body;
  if (!sn) return res.status(400).json({ error: 'sn is required' });
  const id = db.prepare('INSERT INTO WP_serials (deliverable_id, sn, done) VALUES (?,?,0)').run(req.params.id, sn).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM WP_serials WHERE id=?').get(id));
});

app.patch('/api/serials/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM WP_serials WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { sn = cur.sn, done = cur.done } = req.body;
  // done ? 1 : 0 normalizes any truthy input (true, 1, "yes") to the 0/1 the
  // schema stores — never trust client input to already be in storage form.
  db.prepare('UPDATE WP_serials SET sn=?, done=? WHERE id=?').run(sn, done ? 1 : 0, cur.id);
  res.json(db.prepare('SELECT * FROM WP_serials WHERE id=?').get(cur.id));
});

app.delete('/api/serials/:id', (req, res) => {
  db.prepare('DELETE FROM WP_serials WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- day plans ----------
// PUT rather than POST because the client addresses a cell by its natural key
// (week + department + day), not by row id — the UNIQUE constraint in db.js
// guarantees at most one row per cell, and this handler updates-or-inserts
// ("upsert"). Saving the same cell twice is harmless: PUT is idempotent.
app.put('/api/day-plans', (req, res) => {
  const { week_id, department_id, day, goal, actual, goal_note, shift2_plan, shift1_note, shift2_note, comment } = req.body;
  // == null catches both null and undefined but lets 0 through — important
  // here because day 0 (Monday) and goal 0 are perfectly valid values.
  if (week_id == null || department_id == null || day == null) return res.status(400).json({ error: 'week_id, department_id, day are required' });
  const cur = db.prepare('SELECT * FROM WP_day_plans WHERE week_id=? AND department_id=? AND day=?').get(week_id, department_id, day);
  if (cur) {
    // ?? (nullish coalescing) keeps the stored value when a field wasn't sent:
    // goal ?? cur.goal means "use the new goal unless it's null/undefined".
    // A plain || would wrongly discard legitimate 0s and empty strings.
    db.prepare(`UPDATE WP_day_plans SET goal=?, actual=?, goal_note=?, shift2_plan=?, shift1_note=?, shift2_note=?, comment=? WHERE id=?`)
      .run(goal ?? cur.goal, actual ?? cur.actual, goal_note ?? cur.goal_note, shift2_plan ?? cur.shift2_plan,
        shift1_note ?? cur.shift1_note, shift2_note ?? cur.shift2_note, comment ?? cur.comment, cur.id);
    return res.json(db.prepare('SELECT * FROM WP_day_plans WHERE id=?').get(cur.id));
  }
  const id = db.prepare(`INSERT INTO WP_day_plans (week_id, department_id, day, goal, actual, goal_note, shift2_plan, shift1_note, shift2_note, comment)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(week_id, department_id, day, goal ?? 0, actual ?? 0, goal_note ?? '', shift2_plan ?? '', shift1_note ?? '', shift2_note ?? '', comment ?? '').lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM WP_day_plans WHERE id=?').get(id));
});

// ---------- departments & op catalog ----------
app.get('/api/departments', (req, res) => {
  res.json(db.prepare('SELECT * FROM WP_departments ORDER BY sort, id').all());
});

app.post('/api/departments', (req, res) => {
  const { name, color } = req.body;
  // .trim() twice over: reject names that are only whitespace, and store
  // without stray spaces.
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  const sort = db.prepare('SELECT COALESCE(MAX(sort)+1,0) s FROM WP_departments').get().s;
  const id = db.prepare('INSERT INTO WP_departments (name, color, sort) VALUES (?,?,?)')
    .run(name.trim(), color || '#0078a9', sort).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM WP_departments WHERE id=?').get(id));
});

app.patch('/api/departments/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM WP_departments WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { name = cur.name, color = cur.color, sort = cur.sort, second_shift = cur.second_shift } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  db.prepare('UPDATE WP_departments SET name=?, color=?, sort=?, second_shift=? WHERE id=?')
    .run(name.trim(), color, sort, second_shift ? 1 : 0, cur.id);
  res.json(db.prepare('SELECT * FROM WP_departments WHERE id=?').get(cur.id));
});

app.delete('/api/departments/:id', (req, res) => {
  // The catalog delete is explicit only for clarity — the cascade would get it.
  // The department's deliverables and day plans across every week cascade too,
  // which is why the frontend shows a strong confirmation first.
  db.prepare('DELETE FROM WP_op_catalog WHERE department_id=?').run(req.params.id);
  db.prepare('DELETE FROM WP_departments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/ops', (req, res) => {
  // The JOIN denormalizes department_name onto each op so the frontend can
  // label and group without a second lookup.
  res.json(db.prepare(`SELECT o.*, d.name AS department_name FROM WP_op_catalog o JOIN WP_departments d ON d.id=o.department_id ORDER BY o.op_code`).all());
});

app.post('/api/ops', (req, res) => {
  const { department_id, op_code, op_name, avg_labor_hours = 0 } = req.body;
  if (!department_id || !op_code || !op_code.trim()) return res.status(400).json({ error: 'department_id and op_code are required' });
  // Referential check with a friendly 400 — otherwise a bad department_id
  // would surface as an opaque SQL foreign-key error.
  const dept = db.prepare('SELECT id FROM WP_departments WHERE id=?').get(department_id);
  if (!dept) return res.status(400).json({ error: 'Unknown department' });
  const id = db.prepare('INSERT INTO WP_op_catalog (department_id, op_code, op_name, avg_labor_hours) VALUES (?,?,?,?)')
    .run(department_id, op_code.trim(), (op_name || '').trim(), avg_labor_hours).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT o.*, d.name AS department_name FROM WP_op_catalog o JOIN WP_departments d ON d.id=o.department_id WHERE o.id=?').get(id));
});

app.patch('/api/ops/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM WP_op_catalog WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { department_id = cur.department_id, op_code = cur.op_code, op_name = cur.op_name, avg_labor_hours = cur.avg_labor_hours } = req.body;
  if (!op_code || !op_code.trim()) return res.status(400).json({ error: 'op_code is required' });
  const dept = db.prepare('SELECT id FROM WP_departments WHERE id=?').get(department_id);
  if (!dept) return res.status(400).json({ error: 'Unknown department' });
  db.prepare('UPDATE WP_op_catalog SET department_id=?, op_code=?, op_name=?, avg_labor_hours=? WHERE id=?')
    .run(department_id, op_code.trim(), (op_name || '').trim(), avg_labor_hours, cur.id);
  res.json(db.prepare('SELECT o.*, d.name AS department_name FROM WP_op_catalog o JOIN WP_departments d ON d.id=o.department_id WHERE o.id=?').get(cur.id));
});

app.delete('/api/ops/:id', (req, res) => {
  // Only removes the catalog entry. Deliverables copied the op's code/name at
  // planning time (snapshot pattern — see db.js), so existing boards keep it.
  db.prepare('DELETE FROM WP_op_catalog WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- active units + suggestion engine (v1: heuristic; data ~80% accurate) ----------
app.get('/api/active-units', (req, res) => {
  res.json(db.prepare('SELECT * FROM WP_active_units ORDER BY sn').all());
});

app.get('/api/suggestions', (req, res) => {
  // Groups active units by their current op, then proposes a weekly goal per op
  // based on average labor hours vs a 40h/week single-resource capacity per department.
  // This is deliberately a transparent heuristic, not a black box — planners
  // can check its math, which builds the trust needed to act on it.
  const units = db.prepare('SELECT * FROM WP_active_units').all();
  const ops = db.prepare('SELECT o.*, d.name AS department_name, d.id AS dept_id, d.color FROM WP_op_catalog o JOIN WP_departments d ON d.id=o.department_id').all();
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
app.post('/api/suggestions/apply', (req, res) => {
  const { week_id, department_id, op_code, op_name, goal, sns = [] } = req.body;
  if (!week_id || !department_id || !op_code) return res.status(400).json({ error: 'week_id, department_id, op_code required' });
  const sort = db.prepare('SELECT COALESCE(MAX(sort)+1,0) s FROM WP_deliverables WHERE week_id=? AND department_id=?').get(week_id, department_id).s;
  const id = db.prepare('INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)')
    .run(week_id, department_id, op_code, op_name || '', goal || sns.length, sort).lastInsertRowid;
  const insSn = db.prepare('INSERT INTO WP_serials (deliverable_id, sn, done) VALUES (?,?,0)');
  sns.forEach(sn => insSn.run(id, sn));
  res.status(201).json({ ok: true, deliverable_id: id });
});

// ---------- static hosting (production mode) ----------
// After `ng build`, the compiled frontend lands in frontend/dist. If that
// folder exists, this server does double duty as the web host — one process
// serves both the API and the app, so deployment is just "run node".
const path = require('path');
const fs = require('fs');
const distDir = path.join(__dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir)); // serves JS/CSS/images by filename
  // SPA fallback: any non-/api URL returns index.html, because routes like
  // /settings exist only in Angular's router, not as files on disk. Without
  // this, refreshing the browser on /settings would 404.
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

// PORT from the environment (see backend/.env.example) with a dev default —
// configuration lives outside the code, per twelve-factor practice.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Planner API listening on http://localhost:${PORT}`));
