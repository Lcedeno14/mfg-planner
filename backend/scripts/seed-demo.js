/**
 * Inserts a realistic sample week (departments, op catalog, deliverables,
 * serial numbers, daily plans, and a mock active-unit snapshot) so a fresh
 * database is demonstrable.
 *
 * Usage:  npm run db:seed
 *
 * This is deliberately NOT automatic. The app points at a real SQL Server
 * database, and quietly inserting invented departments into a plant database
 * would be the wrong default. Run it only when you want demo data.
 *
 * It refuses to run if any departments already exist, so it can never dilute
 * real data. All op codes, departments and serial numbers are made up.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const db = require('../src/db');

async function main() {
  await db.connect();
  await db.verifySchema();

  const existing = await db.get('SELECT COUNT(*) AS c FROM WP_departments');
  if (existing.c > 0) {
    console.error(`Refusing to seed: WP_departments already has ${existing.c} row(s).`);
    console.error('Seeding is only for an empty database, so it cannot mix demo data into real data.');
    await db.close();
    process.exit(1);
  }

  // One transaction: either the whole sample week lands, or nothing does.
  await db.withTransaction(async tx => {
    const insDept = (name, color, sort) =>
      db.insert('INSERT INTO WP_departments (name, color, sort) VALUES (?,?,?)', [name, color, sort], tx);
    const fab = await insDept('Fabrication', '#0E7C86', 0);
    const mach = await insDept('Machining', '#2456E6', 1);
    const coat = await insDept('Coatings Lab', '#7C3AED', 2);
    const qf = await insDept('Quality & Finishing', '#B45309', 3);

    const ops = [
      [fab, 'Op 105', 'Mold Prep', 6], [fab, 'Op 130', 'Casting Pour', 4], [fab, 'Op 165', 'Demold & Trim', 3],
      [mach, 'Op 210', 'Rough Machining', 5], [mach, 'Op 260', 'Fine Machining', 8], [mach, 'Op 285', 'Deburr', 2],
      [coat, 'Op 405', 'Surface Prep', 3], [coat, 'Op 430', 'Base Coat', 4], [coat, 'Op 465', 'Top Coat', 4],
      [qf, 'Op 505', 'Optical Polish', 6], [qf, 'Op 550', 'Final Cleanup', 2], [qf, 'Op 610', 'Final Inspection', 3],
    ];
    for (const o of ops) {
      await db.insert(
        'INSERT INTO WP_op_catalog (department_id, op_code, op_name, avg_labor_hours) VALUES (?,?,?,?)', o, tx);
    }

    // The current week (Monday of today), in UTC to avoid timezone drift.
    const now = new Date();
    const monday = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const iso = monday.toISOString().slice(0, 10);
    const weekId = await db.insert(
      'INSERT INTO WP_weeks (week_of, label) VALUES (?,?)', [iso, 'Wk of ' + iso], tx);

    const mk = async (dept, code, name, goal, sns, sort) => {
      const id = await db.insert(
        'INSERT INTO WP_deliverables (week_id, department_id, op_code, op_name, goal, sort) VALUES (?,?,?,?,?,?)',
        [weekId, dept, code, name, goal, sort], tx);
      for (const [sn, done] of sns) {
        await db.insert('INSERT INTO WP_serials (deliverable_id, sn, done) VALUES (?,?,?)', [id, sn, done ? 1 : 0], tx);
      }
    };
    await mk(fab, 'Op 130', 'Casting Pour', 2, [['SN 1006', 1], ['SN 1007', 0]], 0);
    await mk(fab, 'Op 165', 'Demold & Trim', 1, [['SN 1005', 1]], 1);
    await mk(mach, 'Op 210', 'Rough Machining', 2, [['SN 1003', 1], ['SN 1004', 0]], 0);
    await mk(mach, 'Op 260', 'Fine Machining', 2, [['SN 1001', 1], ['SN 1002', 1]], 1);
    await mk(coat, 'Op 430', 'Base Coat', 2, [['SN 0988', 1], ['SN 0991', 0]], 0);
    await mk(coat, 'Op 465', 'Top Coat', 3, [['SN 0985', 1], ['SN 0986', 1], ['SN 0987', 0]], 1);
    await mk(qf, 'Op 505', 'Optical Polish', 2, [['SN 0979', 1], ['SN 0981', 0]], 0);
    await mk(qf, 'Op 610', 'Final Inspection', 2, [['SN 0975', 1], ['SN 0976', 1]], 1);

    // [goal, actual, plan, 1st-shift note, 2nd-shift note, comment] per weekday
    const dayPlan = {
      [fab]: [
        [1, 1, 'SN 1006 pour', 'Pour completed 1st shift', '', ''],
        [1, 1, 'SN 1007 pour', '', 'Mold issue, re-prep', 'SN 1007 slipped to Wed'],
        [1, 2, 'SN 1007 pour, SN 1005 demold', 'Both done', '', ''],
        [0, 0, '', '', '', ''], [0, 0, '', '', '', ''],
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
      for (let i = 0; i < days.length; i++) {
        const d = days[i];
        await db.insert(
          `INSERT INTO WP_day_plans (week_id, department_id, day, goal, actual, goal_note, shift1_note, shift2_note, comment)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [weekId, Number(dept), i, d[0], d[1], d[2], d[3], d[4], d[5]], tx);
      }
      // Saturday (day 5) is left absent on purpose — the API fabricates blank
      // rows for missing days, which is the same path older weeks take.
    }

    // Mock active-unit snapshot (the "80% accurate" transaction data).
    // SN 1004 and WS 2101 are stale on purpose so the engine flags them "verify".
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
    for (const u of units) {
      await db.insert(
        'INSERT INTO WP_active_units (sn, current_op_code, hours_at_op, last_txn) VALUES (?,?,?,?)', u, tx);
    }
  });

  const counts = {};
  for (const t of ['WP_departments', 'WP_op_catalog', 'WP_weeks', 'WP_deliverables', 'WP_serials', 'WP_day_plans', 'WP_active_units']) {
    counts[t] = (await db.get(`SELECT COUNT(*) AS c FROM ${t}`)).c;
  }
  console.log('Seeded demo data:');
  for (const [t, c] of Object.entries(counts)) console.log(`  ${t.padEnd(18)} ${c}`);
  await db.close();
}

main().catch(async err => {
  console.error(err.message || err);
  await db.close().catch(() => {});
  process.exit(1);
});
