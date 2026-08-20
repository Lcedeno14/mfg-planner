/**
 * Creates the Weekly Planner (WP_*) tables on Microsoft SQL Server.
 *
 * Usage:  npm run db:setup      (from backend/, after filling in backend/.env)
 *
 * Connection settings come from backend/.env via the same buildConfig() the
 * server uses (src/db.js), so anything that connects here will connect when
 * you run `npm start`. Safe to run repeatedly: create-tables.sql only creates
 * objects that don't exist yet.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const sql = require('mssql');
const db = require('../src/db');

async function main() {
  let config;
  try {
    config = db.buildConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Connecting to ${db.describeTarget()} ...`);
  let pool;
  try {
    pool = await new sql.ConnectionPool(config).connect();
  } catch (err) {
    console.error(`\nCould not connect: ${err.message}`);
    console.error('\nThings to check:');
    console.error('  - the values in backend/.env (server, database, user, password)');
    console.error('  - the database exists — this script creates TABLES, not the database itself');
    console.error('  - for a named instance, set MSSQL_INSTANCE and leave MSSQL_PORT unset');
    console.error('  - for an internal/self-signed certificate, set MSSQL_TRUST_SERVER_CERTIFICATE=true');
    console.error('  - that the login has permission to create tables in this database\n');
    process.exit(1);
  }

  const before = await listTables(pool);

  // create-tables.sql is split on GO (a client-side batch separator, not T-SQL).
  const ddl = fs.readFileSync(path.join(__dirname, 'create-tables.sql'), 'utf8');
  const batches = ddl.split(/^\s*GO\s*$/m).map(b => b.trim()).filter(Boolean);
  try {
    for (const batch of batches) {
      await pool.request().batch(batch);
    }
  } catch (err) {
    console.error(`\nFailed while creating tables: ${err.message}`);
    console.error('If this mentions permissions, the login needs CREATE TABLE rights on this database.\n');
    await pool.close();
    process.exit(1);
  }

  const after = await listTables(pool);
  console.log('');
  for (const t of db.EXPECTED_TABLES) {
    const status = !after.includes(t) ? 'MISSING?!' : before.includes(t) ? 'already existed' : 'created';
    console.log(`  ${t.padEnd(18)} ${status}`);
  }

  const stillMissing = db.EXPECTED_TABLES.filter(t => !after.includes(t));
  await pool.close();
  if (stillMissing.length) {
    console.error(`\nSomething went wrong — missing tables: ${stillMissing.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll Weekly Planner tables are in place.');
  console.log('Next: "npm run db:seed" for sample data (optional), then "npm start".');
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
