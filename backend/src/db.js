const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'planner.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Databases created before the WP_ naming convention used bare table names;
// rename in place so existing data carries over.
const LEGACY_TABLES = ['departments', 'op_catalog', 'weeks', 'deliverables', 'serials', 'day_plans', 'active_units'];
const hasTable = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n);
for (const t of LEGACY_TABLES) {
  if (hasTable(t) && !hasTable('WP_' + t)) db.exec(`ALTER TABLE ${t} RENAME TO WP_${t}`);
}

db.exec(`
CREATE TABLE IF NOT EXISTS WP_departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0078a9',
  sort INTEGER NOT NULL DEFAULT 0,
  second_shift INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS WP_op_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER NOT NULL REFERENCES WP_departments(id) ON DELETE CASCADE,
  op_code TEXT NOT NULL,
  op_name TEXT NOT NULL,
  avg_labor_hours REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS WP_weeks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_of TEXT NOT NULL UNIQUE, -- ISO date of the Monday
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS WP_deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL REFERENCES WP_weeks(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES WP_departments(id) ON DELETE CASCADE,
  op_code TEXT NOT NULL,
  op_name TEXT NOT NULL,
  goal INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS WP_serials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deliverable_id INTEGER NOT NULL REFERENCES WP_deliverables(id) ON DELETE CASCADE,
  sn TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS WP_day_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL REFERENCES WP_weeks(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES WP_departments(id) ON DELETE CASCADE,
  day INTEGER NOT NULL, -- 0=Mon .. 5=Sat
  goal INTEGER NOT NULL DEFAULT 0,
  actual INTEGER NOT NULL DEFAULT 0,
  goal_note TEXT NOT NULL DEFAULT '',      -- 1st shift plan
  shift2_plan TEXT NOT NULL DEFAULT '',
  shift1_note TEXT NOT NULL DEFAULT '',
  shift2_note TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  UNIQUE(week_id, department_id, day)
);

-- Mock of the (80% accurate) part-transaction database: where each active unit sits today.
CREATE TABLE IF NOT EXISTS WP_active_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sn TEXT NOT NULL,
  current_op_code TEXT NOT NULL,
  hours_at_op REAL NOT NULL DEFAULT 0,
  last_txn TEXT NOT NULL
);
`);

// Columns added after the first release — bring old databases up to date.
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('WP_departments', 'second_shift', 'second_shift INTEGER NOT NULL DEFAULT 1');
ensureColumn('WP_day_plans', 'shift2_plan', "shift2_plan TEXT NOT NULL DEFAULT ''");

function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM WP_departments').get().c;
  if (count > 0) return;

  const insDept = db.prepare('INSERT INTO WP_departments (name, color, sort) VALUES (?,?,?)');
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
  ops.forEach(o => insOp.run(...o));

  // Current week (Monday of today)
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const iso = monday.toISOString().slice(0, 10);
  const label = 'Wk of ' + iso;
  const weekId = db.prepare('INSERT INTO WP_weeks (week_of, label) VALUES (?,?)').run(iso, label).lastInsertRowid;

  const insDel = db.prepare('INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)');
  const insSn = db.prepare('INSERT INTO WP_serials (deliverable_id, sn, done) VALUES (?,?,?)');

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

  const insDay = db.prepare(`INSERT INTO WP_day_plans (week_id, department_id, day, goal, actual, goal_note, shift1_note, shift2_note, comment)
    VALUES (?,?,?,?,?,?,?,?,?)`);
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
    days.forEach((d, i) => insDay.run(weekId, Number(dept), i, d[0], d[1], d[2], d[3], d[4], d[5]));
  }

  // Mock active-unit snapshot (the "80% accurate" transaction data)
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
module.exports = db;
