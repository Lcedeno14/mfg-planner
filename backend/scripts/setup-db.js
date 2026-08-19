/**
 * Creates the Weekly Planner (WP_*) tables on Microsoft SQL Server.
 *
 * Usage:  npm run db:setup      (from backend/, after filling in backend/.env)
 *
 * Reads connection settings from backend/.env — see .env.example. Safe to run
 * repeatedly: create-tables.sql only creates tables that don't exist yet.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const sql = require('mssql');

const EXPECTED_TABLES = [
  'WP_departments', 'WP_op_catalog', 'WP_weeks', 'WP_deliverables',
  'WP_serials', 'WP_day_plans', 'WP_active_units',
];

const REQUIRED_ENV = ['MSSQL_SERVER', 'MSSQL_DATABASE', 'MSSQL_USER', 'MSSQL_PASSWORD'];

async function main() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Copy backend/.env.example to backend/.env and fill in your database settings.');
    process.exit(1);
  }

  const config = {
    server: process.env.MSSQL_SERVER,
    port: Number(process.env.MSSQL_PORT || 1433),
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    options: {
      encrypt: process.env.MSSQL_ENCRYPT !== 'false', // default on (required by Azure SQL)
      trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
    },
  };

  console.log(`Connecting to ${config.server}:${config.port} / ${config.database} as ${config.user} ...`);
  let pool;
  try {
    pool = await sql.connect(config);
  } catch (err) {
    console.error(`Could not connect: ${err.message}`);
    console.error('Check backend/.env, that the server allows SQL logins, and that the database exists.');
    process.exit(1);
  }

  const before = await listTables(pool);

  // create-tables.sql is split on GO (a client-side batch separator, not T-SQL).
  const ddl = fs.readFileSync(path.join(__dirname, 'create-tables.sql'), 'utf8');
  const batches = ddl.split(/^\s*GO\s*$/m).map(b => b.trim()).filter(Boolean);
  for (const batch of batches) {
    await pool.request().batch(batch);
  }

  const after = await listTables(pool);
  console.log('');
  for (const t of EXPECTED_TABLES) {
    const status = !after.includes(t) ? 'MISSING?!' : before.includes(t) ? 'already existed' : 'created';
    console.log(`  ${t.padEnd(18)} ${status}`);
  }

  const stillMissing = EXPECTED_TABLES.filter(t => !after.includes(t));
  await pool.close();
  if (stillMissing.length) {
    console.error(`\nSomething went wrong — missing tables: ${stillMissing.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll Weekly Planner tables are in place.');
}

async function listTables(pool) {
  const r = await pool.request().query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_NAME LIKE 'WP\\_%' ESCAPE '\\'"
  );
  return r.recordset.map(row => row.TABLE_NAME);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
