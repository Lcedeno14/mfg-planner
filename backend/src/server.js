const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---------- helpers ----------
function weekPayload(weekId) {
  const week = db.prepare('SELECT * FROM WP_weeks WHERE id = ?').get(weekId);
  if (!week) return null;
  const departments = db.prepare('SELECT * FROM WP_departments ORDER BY sort, id').all();
  const deliverables = db.prepare('SELECT * FROM WP_deliverables WHERE week_id = ? ORDER BY sort, id').all(weekId);
  const serials = db.prepare(`SELECT s.* FROM WP_serials s JOIN WP_deliverables d ON d.id = s.deliverable_id WHERE d.week_id = ? ORDER BY s.id`).all(weekId);
  const dayPlans = db.prepare('SELECT * FROM WP_day_plans WHERE week_id = ? ORDER BY department_id, day').all(weekId);

  const depts = departments.map(dep => {
    const dels = deliverables.filter(d => d.department_id === dep.id).map(d => ({
      ...d,
      serials: serials.filter(s => s.deliverable_id === d.id),
    }));
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
  res.json(db.prepare('SELECT * FROM WP_weeks ORDER BY week_of DESC').all());
});

app.get('/api/weeks/:id', (req, res) => {
  const payload = weekPayload(Number(req.params.id));
  if (!payload) return res.status(404).json({ error: 'Week not found' });
  res.json(payload);
});

// Any date in a week resolves to that week's Monday, so two dates in the
// same Mon-Sun range always collide on the same canonical week_of.
function mondayOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

app.post('/api/weeks', (req, res) => {
  const { week_of, copyFromWeekId } = req.body;
  if (!week_of) return res.status(400).json({ error: 'week_of is required (ISO date)' });
  const monday = mondayOf(week_of);
  if (!monday) return res.status(400).json({ error: 'week_of must be an ISO date (YYYY-MM-DD)' });
  // Normalize existing rows too: weeks created before validation may sit on a
  // non-Monday date but still claim their whole Mon-Sun range.
  const exists = db.prepare('SELECT * FROM WP_weeks').all().find(w => mondayOf(w.week_of) === monday);
  if (exists) {
    return res.status(409).json({
      error: `That date falls in the week of ${monday}, which already exists (${exists.label}). Pick a date in a different week.`,
    });
  }

  const label = 'Wk of ' + monday;
  const weekId = db.prepare('INSERT INTO WP_weeks (week_of, label) VALUES (?,?)').run(monday, label).lastInsertRowid;

  const departments = db.prepare('SELECT id FROM WP_departments').all();
  const insDay = db.prepare('INSERT INTO WP_day_plans (week_id, department_id, day) VALUES (?,?,?)');
  departments.forEach(dep => { for (let d = 0; d < DAYS.length; d++) insDay.run(weekId, dep.id, d); });

  if (copyFromWeekId) {
    const src = db.prepare('SELECT * FROM WP_deliverables WHERE week_id = ?').all(copyFromWeekId);
    const insDel = db.prepare('INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)');
    src.forEach(d => insDel.run(weekId, d.department_id, d.op_code, d.op_name, d.goal, d.sort));
  }
  res.status(201).json(weekPayload(weekId));
});

app.delete('/api/weeks/:id', (req, res) => {
  db.prepare('DELETE FROM WP_weeks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- deliverables ----------
app.post('/api/deliverables', (req, res) => {
  const { week_id, department_id, op_code, op_name, goal = 0 } = req.body;
  if (!week_id || !department_id || !op_code) return res.status(400).json({ error: 'week_id, department_id and op_code are required' });
  const sort = db.prepare('SELECT COALESCE(MAX(sort)+1,0) s FROM WP_deliverables WHERE week_id=? AND department_id=?').get(week_id, department_id).s;
  const id = db.prepare('INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)')
    .run(week_id, department_id, op_code, op_name || '', goal, sort).lastInsertRowid;
  res.status(201).json({ ...db.prepare('SELECT * FROM WP_deliverables WHERE id=?').get(id), serials: [] });
});

app.patch('/api/deliverables/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM WP_deliverables WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { op_code = cur.op_code, op_name = cur.op_name, goal = cur.goal } = req.body;
  db.prepare('UPDATE WP_deliverables SET op_code=?, op_name=?, goal=? WHERE id=?').run(op_code, op_name, goal, cur.id);
  res.json(db.prepare('SELECT * FROM WP_deliverables WHERE id=?').get(cur.id));
});

app.delete('/api/deliverables/:id', (req, res) => {
  db.prepare('DELETE FROM WP_deliverables WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- serials ----------
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
  db.prepare('UPDATE WP_serials SET sn=?, done=? WHERE id=?').run(sn, done ? 1 : 0, cur.id);
  res.json(db.prepare('SELECT * FROM WP_serials WHERE id=?').get(cur.id));
});

app.delete('/api/serials/:id', (req, res) => {
  db.prepare('DELETE FROM WP_serials WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- day plans ----------
app.put('/api/day-plans', (req, res) => {
  const { week_id, department_id, day, goal, actual, goal_note, shift2_plan, shift1_note, shift2_note, comment } = req.body;
  if (week_id == null || department_id == null || day == null) return res.status(400).json({ error: 'week_id, department_id, day are required' });
  const cur = db.prepare('SELECT * FROM WP_day_plans WHERE week_id=? AND department_id=? AND day=?').get(week_id, department_id, day);
  if (cur) {
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
  db.prepare('DELETE FROM WP_op_catalog WHERE department_id=?').run(req.params.id);
  db.prepare('DELETE FROM WP_departments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/ops', (req, res) => {
  res.json(db.prepare(`SELECT o.*, d.name AS department_name FROM WP_op_catalog o JOIN WP_departments d ON d.id=o.department_id ORDER BY o.op_code`).all());
});

app.post('/api/ops', (req, res) => {
  const { department_id, op_code, op_name, avg_labor_hours = 0 } = req.body;
  if (!department_id || !op_code || !op_code.trim()) return res.status(400).json({ error: 'department_id and op_code are required' });
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
  const units = db.prepare('SELECT * FROM WP_active_units').all();
  const ops = db.prepare('SELECT o.*, d.name AS department_name, d.id AS dept_id, d.color FROM WP_op_catalog o JOIN WP_departments d ON d.id=o.department_id').all();
  const byOp = {};
  units.forEach(u => { (byOp[u.current_op_code] = byOp[u.current_op_code] || []).push(u); });

  const WEEK_HOURS = 40;
  const suggestions = ops
    .filter(op => byOp[op.op_code]?.length)
    .map(op => {
      const queued = byOp[op.op_code];
      const capacity = op.avg_labor_hours > 0 ? Math.max(1, Math.floor(WEEK_HOURS / op.avg_labor_hours)) : queued.length;
      const suggestedGoal = Math.min(queued.length, capacity);
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

// Serve the built Angular app if it exists (production mode)
const path = require('path');
const fs = require('fs');
const distDir = path.join(__dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Planner API listening on http://localhost:${PORT}`));
