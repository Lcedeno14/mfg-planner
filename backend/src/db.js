/**
 * db.js — the data layer: opens the database, defines the schema, and seeds demo data.
 *
 * ── System design: why this file exists ─────────────────────────────────────
 * Everything database-related lives here so the rest of the backend (server.js)
 * never worries about *where* data is stored, only *what* queries to run.
 * That separation is what will make swapping SQLite for SQL Server a contained
 * change: this module's exports stay the same shape, only its internals change.
 *
 * SQLite is an "embedded" database — the whole thing is one file on disk
 * (data/planner.db), no separate database server process to install or run.
 * That makes it perfect for local development. The tradeoff: it's single-file
 * and single-machine, which is why production points at SQL Server instead
 * (see scripts/create-tables.sql — same tables, same WP_ names).
 *
 * This module runs top-to-bottom exactly once, on the first require('./db'):
 *   1. open/create the database file
 *   2. rename legacy tables (migration)
 *   3. create any missing tables (schema)
 *   4. add any missing columns (migration)
 *   5. seed demo data if the DB is brand new
 * Node caches modules, so every other file that does require('./db') gets the
 * same already-initialized connection — a simple singleton pattern.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// __dirname is the folder THIS file lives in (backend/src), so the data
// directory resolves to backend/data no matter where node was started from.
// Never build paths with string concatenation — path.join handles separators.
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'planner.db'));

// PRAGMAs are SQLite configuration commands.
// WAL (write-ahead logging) lets reads happen while a write is in progress —
// important because every HTTP request hits this one connection.
// foreign_keys must be switched on per-connection in SQLite (off by default
// for historical reasons); without it, ON DELETE CASCADE below would be ignored.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Migration #1: table renames ─────────────────────────────────────────────
// Databases created before the WP_ naming convention used bare table names;
// rename in place so existing data carries over. This is the core idea of a
// "migration": code changes ship to machines that already hold real data, so
// the schema must be upgraded *in place*, never dropped and recreated.
// sqlite_master is SQLite's built-in catalog of every table/index in the file.
const LEGACY_TABLES = ['departments', 'op_catalog', 'weeks', 'deliverables', 'serials', 'day_plans', 'active_units'];
const hasTable = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
for (const t of LEGACY_TABLES) {
  if (hasTable(t) && !hasTable('WP_' + t)) db.exec(`ALTER TABLE ${t} RENAME TO WP_${t}`);
}

// ── Schema ──────────────────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS makes this idempotent: safe to run on every boot.
// On an existing database it's a no-op; on a fresh one it builds everything.
//
// The data model, top-down:
//   WP_departments 1──* WP_op_catalog     (a department owns catalog ops)
//   WP_weeks       1──* WP_deliverables   (a week plans ops per department)
//   WP_deliverables 1──* WP_serials       (each planned op tracks serial numbers)
//   WP_weeks       1──* WP_day_plans      (one row per week+department+day)
//   WP_active_units                        (standalone snapshot, feeds suggestions)
//
// REFERENCES ... ON DELETE CASCADE means "when the parent row is deleted,
// delete these children automatically" — deleting a week removes its
// deliverables, whose serials are removed in turn. Cascades keep integrity
// logic in the database, where it can't be forgotten by an API handler.
db.exec(`
CREATE TABLE IF NOT EXISTS WP_departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0078a9',      -- hex color for the department's card/chips
  sort INTEGER NOT NULL DEFAULT 0,            -- manual display order on the board
  second_shift INTEGER NOT NULL DEFAULT 1     -- 1/0 flag: show 2nd-shift plan rows (SQLite has no BOOLEAN type)
);

CREATE TABLE IF NOT EXISTS WP_op_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL REFERENCES WP_departments(id) ON DELETE CASCADE,
  op_code TEXT NOT NULL,                      -- e.g. "Op 130"
  op_name TEXT NOT NULL,                      -- e.g. "Casting Pour"
  avg_labor_hours REAL NOT NULL DEFAULT 0     -- drives the suggestion engine's capacity math
);

CREATE TABLE IF NOT EXISTS WP_weeks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_of TEXT NOT NULL UNIQUE, -- ISO date of the Monday; UNIQUE enforces one week per date at the DB level
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS WP_deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL REFERENCES WP_weeks(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES WP_departments(id) ON DELETE CASCADE,
  op_code TEXT NOT NULL,   -- copied from the catalog, not referenced — so later
  op_name TEXT NOT NULL,   -- catalog edits don't rewrite history ("snapshot" pattern)
  goal INTEGER NOT NULL DEFAULT 0,  -- legacy column; progress now = serials done / serials added
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS WP_serials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deliverable_id INTEGER NOT NULL REFERENCES WP_deliverables(id) ON DELETE CASCADE,
  sn TEXT NOT NULL,                           -- serial number as free text, e.g. "SN 1006"
  done INTEGER NOT NULL DEFAULT 0             -- 1 once the chip is clicked green
);

CREATE TABLE IF NOT EXISTS WP_day_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL REFERENCES WP_weeks(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES WP_departments(id) ON DELETE CASCADE,
  day INTEGER NOT NULL, -- 0=Mon .. 5=Sat
  goal INTEGER NOT NULL DEFAULT 0,            -- these two drive every scorecard in the app
  actual INTEGER NOT NULL DEFAULT 0,
  goal_note TEXT NOT NULL DEFAULT '',      -- 1st shift plan (kept its old name through migration)
  shift2_plan TEXT NOT NULL DEFAULT '',
  shift1_note TEXT NOT NULL DEFAULT '',       -- what actually happened, per shift
  shift2_note TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  UNIQUE(week_id, department_id, day)         -- one row per cell of the board; enables upsert in server.js
);

-- Mock of the (80% accurate) part-transaction database: where each active unit sits today.
-- In production this becomes a view over the plant's real transaction system;
-- the suggestion endpoint reads it through the same query either way.
CREATE TABLE IF NOT EXISTS WP_active_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sn TEXT NOT NULL,
  current_op_code TEXT NOT NULL,
  hours_at_op REAL NOT NULL DEFAULT 0,
  last_txn TEXT NOT NULL                      -- human-readable recency, e.g. "2d ago"
);
`);

// ── Migration #2: added columns ─────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS won't touch tables that already exist, so columns
// added after the first release need their own upgrade path. PRAGMA table_info
// lists a table's current columns; anything missing gets ALTER TABLE'd in.
// Every column added this way needs a DEFAULT so existing rows stay valid.
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('WP_departments', 'second_shift', 'second_shift INTEGER NOT NULL DEFAULT 1');
ensureColumn('WP_day_plans', 'shift2_plan', "shift2_plan TEXT NOT NULL DEFAULT ''");

// ── Seed data ───────────────────────────────────────────────────────────────
// Fills a brand-new database with a realistic sample week so the app is
// demonstrable on first run. The count check makes it run at most once —
// deleting data/planner.db is the "factory reset".
function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM WP_departments').get().c;
  if (count > 0) return;

  // db.prepare compiles a statement once; .run executes it with values bound
  // to the ? placeholders. Besides being faster on repeat use, placeholders
  // are the defense against SQL injection: values are never spliced into the
  // SQL string, so "'; DROP TABLE--" is just data, not code.
  const insDept = db.prepare('INSERT INTO WP_departments (name, color, sort) VALUES (?,?,?)');
  // .lastInsertRowid returns the auto-generated id, which we keep to link children.
  const fab = insDept.run('Fabrication', '#0E7C86', 0).lastInsertRowid;
  const mach = insDept.run('Machining', '#2456E6', 1).lastInsertRowid;
  const coat = insDept.run('Coatings Lab', '#7C3AED', 2).lastInsertRowid;
  const qf = insDept.run('Quality & Finishing', '#B45309', 3).lastInsertRowid;

  const insOp = db.prepare('INSERT INTO WP_op_catalog (department_id, op_code, op_name, avg_labor_hours) VALUES (?,?,?,?)');
  const ops = [
    [fab, 'Op 105', 'Mold Prep', 6],
    [fab, 'Op 130', 'Casting Pour', 4],
    [fab, 'Op 165', 'Demold & Trim', 3],
    [mach, 'Op 210', 'Rough Machining', 5],
    [mach, 'Op 260', 'Fine Machining', 8],
    [mach, 'Op 285', 'Deburr', 2],
    [coat, 'Op 405', 'Surface Prep', 3],
    [coat, 'Op 430', 'Base Coat', 4],
    [coat, 'Op 465', 'Top Coat', 4],
    [qf, 'Op 505', 'Optical Polish', 6],
    [qf, 'Op 550', 'Final Cleanup', 2],
    [qf, 'Op 610', 'Final Inspection', 3],
  ];
  ops.forEach(o => insOp.run(...o)); // ...o spreads the array into the 4 placeholders

  // Current week (Monday of today). getDay() returns 0=Sun..6=Sat; the
  // (day+6)%7 trick converts that to 0=Mon..6=Sun so we can step back to Monday.
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const iso = monday.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const label = 'Wk of ' + iso;
  const weekId = db.prepare('INSERT INTO WP_weeks (week_of, label) VALUES (?,?)').run(iso, label).lastInsertRowid;

  const insDel = db.prepare('INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)');
  const insSn = db.prepare('INSERT INTO WP_serials (deliverable_id, sn, done) VALUES (?,?,?)');

  // Small helper to keep the sample data below readable: one line per
  // deliverable, with its serial numbers and their done flags inline.
  const mk = (dept, code, name, goal, sns, sort) => {
    const id = insDel.run(weekId, dept, code, name, goal, sort).lastInsertRowid;
    sns.forEach(([sn, done]) => insSn.run(id, sn, done ? 1 : 0));
  };

  mk(fab, 'Op 130', 'Casting Pour', 2, [['SN 1006', 1], ['SN 1007', 0]], 0);
  mk(fab, 'Op 165', 'Demold & Trim', 1, [['SN 1005', 1]], 1);
  mk(mach, 'Op 210', 'Rough Machining', 2, [['SN 1003', 1], ['SN 1004', 0]], 0);
  mk(mach, 'Op 260', 'Fine Machining', 2, [['SN 1001', 1], ['SN 1002', 1]], 1);
  mk(coat, 'Op 430', 'Base Coat', 2, [['SN 0988', 1], ['SN 0991', 0]], 0);
  mk(coat, 'Op 465', 'Top Coat', 3, [['SN 0985', 1], ['SN 0986', 1], ['SN 0987', 0]], 1);
  mk(qf, 'Op 505', 'Optical Polish', 2, [['SN 0979', 1], ['SN 0981', 0]], 0);
  mk(qf, 'Op 610', 'Final Inspection', 2, [['SN 0975', 1], ['SN 0976', 1]], 1);

  // Five seeded days per department (Mon-Fri); Saturday rows are filled in
  // lazily by server.js when missing, which is also how older weeks gained
  // Saturday without a migration.
  const insDay = db.prepare(`INSERT INTO WP_day_plans (week_id, department_id, day, goal, actual, goal_note, shift1_note, shift2_note, comment)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  // Keys here are department ids; [fab] is a "computed property name".
  // Each row: [goal, actual, plan, 1st-shift note, 2nd-shift note, comment].
  const dayPlan = {
    [fab]: [
      [1, 1, 'SN 1006 pour', 'Pour completed 1st shift', '', ''],
      [1, 1, 'SN 1007 pour', '', 'Mold issue, re-prep', 'SN 1007 slipped to Wed'],
      [1, 2, 'SN 1007 pour, SN 1005 demold', 'Both done', '', ''],
      [0, 0, '', '', '', ''],
      [0, 0, '', '', '', ''],
    ],
    [mach]: [
      [1, 1, 'SN 1001 fine mach', '', '', ''],
      [1, 1, 'SN 1002 fine mach', '', '', ''],
      [1, 2, 'SN 1003 rough, any WS', 'Pulled SN 1003 ahead', '', ''],
      [1, 0, 'SN 1004 rough', '', '', 'Tooling down until Fri AM'],
      [0, 0, '', '', '', ''],
    ],
    [coat]: [
      [1, 1, 'SN 0985 topcoat', '', '', ''],
      [1, 1, 'SN 0986 topcoat', '', '', ''],
      [1, 2, 'SN 0988 basecoat', 'Also ran SN 0991 prep', '', ''],
      [1, 0, 'SN 0987 topcoat', '', '', ''],
      [1, 0, 'SN 0991 basecoat', '', '', ''],
    ],
    [qf]: [
      [1, 1, 'SN 0975 inspection', '', '', ''],
      [1, 1, 'SN 0976 inspection', '', '', ''],
      [1, 1, 'SN 0979 polish', '', '', ''],
      [1, 1, 'SN 0981 polish start', 'Carrying to Fri', '', ''],
      [1, 0, 'SN 0981 polish finish', '', '', ''],
    ],
  };
  for (const [dept, days] of Object.entries(dayPlan)) {
    // Object keys are always strings in JS, so the id needs Number() back.
    days.forEach((d, i) => insDay.run(weekId, Number(dept), i, d[0], d[1], d[2], d[3], d[4], d[5]));
  }

  // Mock active-unit snapshot (the "80% accurate" transaction data).
  // Note SN 1004 "5d ago" and WS 2101 "12d ago" — stale on purpose, so the
  // suggestion engine has something to flag as "verify".
  const insUnit = db.prepare('INSERT INTO WP_active_units (sn, current_op_code, hours_at_op, last_txn) VALUES (?,?,?,?)');
  const units = [
    ['SN 1001', 'Op 260', 6, '2d ago'], ['SN 1002', 'Op 260', 7, '1d ago'],
    ['SN 1003', 'Op 210', 4, '3h ago'], ['SN 1004', 'Op 210', 1, '5d ago'],
    ['SN 1005', 'Op 165', 2, '1d ago'], ['SN 1006', 'Op 130', 3, '2h ago'],
    ['SN 1007', 'Op 105', 5, '6h ago'], ['SN 1008', 'Op 105', 1, '4d ago'],
    ['SN 0985', 'Op 465', 3, '1d ago'], ['SN 0986', 'Op 465', 2, '3d ago'],
    ['SN 0987', 'Op 430', 4, '2d ago'], ['SN 0988', 'Op 430', 3, '1d ago'],
    ['SN 0991', 'Op 405', 2, '8d ago'], ['SN 0975', 'Op 610', 1, '4h ago'],
    ['SN 0976', 'Op 610', 2, '1d ago'], ['SN 0979', 'Op 505', 5, '2d ago'],
    ['SN 0981', 'Op 505', 6, '1d ago'], ['WS 2101', 'Op 210', 0, '12d ago'],
  ];
  units.forEach(u => insUnit.run(...u));
}

seed();

// Exporting the connection object itself — server.js does db.prepare(...) directly.
module.exports = db;
