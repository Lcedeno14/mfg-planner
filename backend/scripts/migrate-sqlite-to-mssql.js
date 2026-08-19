/**
 * Copies all Weekly Planner data from the local SQLite database
 * (backend/data/planner.db) into the WP_ tables on Microsoft SQL Server.
 *
 * Usage (from backend/, after npm run db:setup):
 *   npm run db:migrate -- --dry-run   preview row counts, no MSSQL needed
 *   npm run db:migrate                migrate (refuses if WP_ tables have rows)
 *   npm run db:migrate -- --force     wipe WP_ tables on MSSQL first, then migrate
 *
 * IDs are preserved (IDENTITY_INSERT), so serials still point at the right
 * deliverables and day plans at the right weeks. The whole migration runs in
 * one transaction: it either completes fully or leaves MSSQL untouched.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

// Insert order satisfies foreign keys; deletes (--force) run in reverse.
const TABLES = [
  { name: 'WP_departments', cols: ['id', 'name', 'color', 'sort', 'second_shift'] },
  { name: 'WP_op_catalog', cols: ['id', 'department_id', 'op_code', 'op_name', 'avg_labor_hours'] },
  { name: 'WP_weeks', cols: ['id', 'week_of', 'label'] },
  { name: 'WP_deliverables', cols: ['id', 'week_id', 'department_id', 'op_code', 'op_name', 'goal', 'sort'] },
  { name: 'WP_serials', cols: ['id', 'deliverable_id', 'sn', 'done'] },
  { name: 'WP_day_plans', cols: ['id', 'week_id', 'department_id', 'day', 'goal', 'actual', 'goal_note', 'shift2_plan', 'shift1_note', 'shift2_note', 'comment'] },
  { name: 'WP_active_units', cols: ['id', 'sn', 'current_op_code', 'hours_at_op', 'last_txn'] },
];

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

function readSqlite() {
  const dbPath = path.join(__dirname, '..', 'data', 'planner.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No SQLite database found at ${dbPath} — nothing to migrate.`);
    process.exit(1);
  }
  const sqlite = require('better-sqlite3')(dbPath, { readonly: true });
  const data = {};
  for (const t of TABLES) {
    data[t.name] = sqlite.prepare(`SELECT ${t.cols.join(', ')} FROM ${t.name} ORDER BY id`).all();
  }
  sqlite.close();
  return data;
}

async function main() {
  const data = readSqlite();
  console.log('SQLite rows to migrate:');
  for (const t of TABLES) console.log(`  ${t.name.padEnd(18)} ${data[t.name].length}`);
  if (dryRun) {
    console.log('\nDry run — nothing written. Run without --dry-run to migrate.');
    return;
  }

  const missing = ['MSSQL_SERVER', 'MSSQL_DATABASE', 'MSSQL_USER', 'MSSQL_PASSWORD'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`\nMissing environment variables: ${missing.join(', ')}`);
    console.error('Copy backend/.env.example to backend/.env and fill in your database settings.');
    process.exit(1);
  }

  const sql = require('mssql');
  const pool = await sql.connect({
    server: process.env.MSSQL_SERVER,
    port: Number(process.env.MSSQL_PORT || 1433),
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    options: {
      encrypt: process.env.MSSQL_ENCRYPT !== 'false',
      trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
    },
  });

  // Never silently merge into existing data.
  const counts = {};
  for (const t of TABLES) {
    const r = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.${t.name}`);
    counts[t.name] = r.recordset[0].n;
  }
  const nonEmpty = TABLES.filter(t => counts[t.name] > 0);
  if (nonEmpty.length && !force) {
    console.error('\nThese MSSQL tables already contain rows:');
    for (const t of nonEmpty) console.error(`  ${t.name.padEnd(18)} ${counts[t.name]}`);
    console.error('Re-run with --force to wipe them and migrate fresh.');
    await pool.close();
    process.exit(1);
  }

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    if (nonEmpty.length) {
      for (const t of [...TABLES].reverse()) {
        await new sql.Request(tx).query(`DELETE FROM dbo.${t.name}`);
      }
      console.log('\nCleared existing MSSQL rows (--force).');
    }

    for (const t of TABLES) {
      const rows = data[t.name];
      if (!rows.length) continue;
      await new sql.Request(tx).batch(`SET IDENTITY_INSERT dbo.${t.name} ON`);
      for (const row of rows) {
        const req = new sql.Request(tx);
        t.cols.forEach(c => req.input(c, row[c]));
        await req.query(
          `INSERT INTO dbo.${t.name} (${t.cols.join(', ')}) VALUES (${t.cols.map(c => '@' + c).join(', ')})`
        );
      }
      await new sql.Request(tx).batch(`SET IDENTITY_INSERT dbo.${t.name} OFF`);
      console.log(`  migrated ${t.name.padEnd(18)} ${rows.length} rows`);
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    console.error(`\nMigration failed and was rolled back — MSSQL is unchanged.\n${err.message}`);
    await pool.close();
    process.exit(1);
  }

  // Verify counts landed.
  let ok = true;
  for (const t of TABLES) {
    const r = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.${t.name}`);
    if (r.recordset[0].n !== data[t.name].length) {
      console.error(`  count mismatch on ${t.name}: expected ${data[t.name].length}, found ${r.recordset[0].n}`);
      ok = false;
    }
  }
  await pool.close();
  if (!ok) process.exit(1);
  console.log('\nMigration complete — row counts verified for every table.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
