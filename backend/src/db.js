/**
 * db.js — the data layer: one connection pool to Microsoft SQL Server, plus a
 * small query helper the routes use.
 *
 * ── System design: why this file exists ─────────────────────────────────────
 * Everything database-related lives here so the rest of the backend (server.js)
 * never worries about *where* data is stored or how connections are managed —
 * only what queries to run. Swap the engine and this is the file that changes.
 *
 * ── Connection pooling ──────────────────────────────────────────────────────
 * Unlike a file-based database, SQL Server lives across a network and every
 * connection costs a TCP handshake plus authentication. Opening one per request
 * would be slow and would exhaust the server's connection limit under load.
 * Instead we open a POOL once at startup: a small set of reusable connections
 * that requests borrow and return. `mssql` handles the borrowing internally —
 * each `pool.request()` takes a free connection and releases it when done.
 *
 * ── Async, and what that means for callers ──────────────────────────────────
 * Network I/O cannot be synchronous, so every function here returns a Promise
 * and callers must `await` it. That is the single biggest difference from an
 * embedded database, and it is why every route in server.js is an `async`
 * function.
 *
 * ── Parameter binding ───────────────────────────────────────────────────────
 * Queries are written with `?` placeholders and an array of values, and
 * `toNamed()` below rewrites them into SQL Server's `@p0, @p1, ...` form. The
 * values are sent to the server separately from the SQL text, so a value like
 * "'; DROP TABLE--" is treated as data, never as code. Never build SQL by
 * concatenating user input.
 */
const sql = require('mssql');

// ---------- configuration ----------
// Read from the environment (see .env.example). Nothing is hardcoded, so the
// same build runs against a developer's container and a production server.
const REQUIRED_ENV = ['MSSQL_SERVER', 'MSSQL_DATABASE', 'MSSQL_USER', 'MSSQL_PASSWORD'];

/**
 * Builds the driver config from environment variables.
 *
 * Exported so the setup, seed and migration scripts connect exactly the same
 * way the server does — one place to get connection details right, so a
 * setting that works for `npm run db:setup` also works for `npm start`.
 *
 * Corporate SQL Server installations usually differ from a plain localhost in
 * one of three ways, all handled here:
 *   - a NAMED INSTANCE (SERVER\SQLEXPRESS) rather than a port — set MSSQL_INSTANCE
 *   - WINDOWS/domain accounts rather than SQL logins — set MSSQL_DOMAIN
 *   - encryption with an internal certificate — set MSSQL_TRUST_SERVER_CERTIFICATE=true
 */
function buildConfig() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing environment variables: ${missing.join(', ')}\n` +
      'Copy backend/.env.example to backend/.env and fill in your database settings.'
    );
  }

  const options = {
    // Encryption defaults ON: required by Azure SQL and by most modern
    // on-prem servers. Set MSSQL_ENCRYPT=false only if the server refuses TLS.
    encrypt: process.env.MSSQL_ENCRYPT !== 'false',
    // Needed when the server presents a self-signed/internal certificate,
    // which is the norm for on-prem SQL Server.
    trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
  };

  // Named instance (e.g. MSSQL_SERVER=SQLPROD01, MSSQL_INSTANCE=SQLEXPRESS).
  // The SQL Browser service resolves the instance to its port, so a port must
  // NOT also be supplied — passing both makes the driver ignore the instance.
  if (process.env.MSSQL_INSTANCE) options.instanceName = process.env.MSSQL_INSTANCE;

  const config = {
    server: process.env.MSSQL_SERVER,
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    options,
    // Corporate networks and VPNs are slower than localhost; 15s beats the
    // driver's default so a slow first connection isn't mistaken for a failure.
    connectionTimeout: Number(process.env.MSSQL_CONNECTION_TIMEOUT || 15000),
    requestTimeout: Number(process.env.MSSQL_REQUEST_TIMEOUT || 15000),
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };

  if (!process.env.MSSQL_INSTANCE) config.port = Number(process.env.MSSQL_PORT || 1433);
  // Windows/Active Directory account: DOMAIN\user authenticates over NTLM.
  if (process.env.MSSQL_DOMAIN) config.domain = process.env.MSSQL_DOMAIN;

  return config;
}

/** Human-readable description of what we're connecting to (never logs the password). */
function describeTarget() {
  const where = process.env.MSSQL_INSTANCE
    ? `${process.env.MSSQL_SERVER}\\${process.env.MSSQL_INSTANCE}`
    : `${process.env.MSSQL_SERVER}:${process.env.MSSQL_PORT || 1433}`;
  const who = process.env.MSSQL_DOMAIN
    ? `${process.env.MSSQL_DOMAIN}\\${process.env.MSSQL_USER}`
    : process.env.MSSQL_USER;
  return `${where} / ${process.env.MSSQL_DATABASE} as ${who}`;
}

let pool = null;

/** Opens the pool once. Safe to call repeatedly; later calls reuse it. */
async function connect() {
  if (pool) return pool;
  pool = await new sql.ConnectionPool(buildConfig()).connect();
  return pool;
}

/** Closes the pool (used by tests and graceful shutdown). */
async function close() {
  if (pool) { await pool.close(); pool = null; }
}

// ---------- query helpers ----------

/**
 * Rewrites `?` placeholders into SQL Server's named parameters.
 *   toNamed('WHERE id = ? AND day = ?')  ->  'WHERE id = @p0 AND day = @p1'
 * Values are bound positionally by the callers below, matching the same order.
 */
function toNamed(text) {
  let i = 0;
  return text.replace(/\?/g, () => `@p${i++}`);
}

/** Binds an array of values as @p0..@pN on a request object. */
function bind(request, params) {
  params.forEach((value, i) => request.input(`p${i}`, value));
  return request;
}

/**
 * Runs a query and returns all rows.
 * `tx` (optional) runs the query inside an existing transaction — see withTransaction.
 */
async function all(text, params = [], tx = null) {
  const request = tx ? new sql.Request(tx) : (await connect()).request();
  const result = await bind(request, params).query(toNamed(text));
  return result.recordset || [];
}

/** Runs a query and returns the first row, or undefined. */
async function get(text, params = [], tx = null) {
  const rows = await all(text, params, tx);
  return rows[0];
}

/** Runs a statement that returns no rows (UPDATE/DELETE/INSERT without OUTPUT). */
async function run(text, params = [], tx = null) {
  const request = tx ? new sql.Request(tx) : (await connect()).request();
  const result = await bind(request, params).query(toNamed(text));
  return { rowsAffected: result.rowsAffected?.[0] ?? 0 };
}

/**
 * Runs an INSERT and returns the new row's id.
 *
 * There is no "last inserted id" call to make afterwards, so the INSERT itself
 * must ask for the generated key. `OUTPUT INSERTED.id` is the safe way:
 * it is scoped to this exact statement, unlike @@IDENTITY (which can pick up an
 * id created by a trigger) or SCOPE_IDENTITY() (which needs a second round trip).
 * Callers pass the INSERT without the OUTPUT clause; it is spliced in here.
 */
async function insert(text, params = [], tx = null) {
  const withOutput = text.replace(/\)\s*VALUES/i, ') OUTPUT INSERTED.id VALUES');
  const row = await get(withOutput, params, tx);
  return row?.id;
}

/**
 * Runs `work` inside a transaction, committing on success and rolling back on
 * any error. Used where one API call performs several writes that must not be
 * left half-applied — creating a week, or deleting a department.
 *
 *   await withTransaction(async tx => {
 *     await run('DELETE ...', [id], tx);
 *     await insert('INSERT ...', [x], tx);
 *   });
 */
async function withTransaction(work) {
  const p = await connect();
  const tx = new sql.Transaction(p);
  await tx.begin();
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch { /* rollback can fail if the tx already aborted */ }
    throw err;
  }
}

// ---------- startup checks ----------
const EXPECTED_TABLES = [
  'WP_departments', 'WP_op_catalog', 'WP_weeks', 'WP_deliverables',
  'WP_serials', 'WP_day_plans', 'WP_active_units',
];

/**
 * Verifies the schema exists before the API starts serving. Failing loudly at
 * boot with an actionable message beats every request failing mysteriously.
 */
async function verifySchema() {
  const rows = await all(
    "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_NAME LIKE 'WP\\_%' ESCAPE '\\'"
  );
  const present = rows.map(r => r.name);
  const missing = EXPECTED_TABLES.filter(t => !present.includes(t));
  if (missing.length) {
    throw new Error(
      `Missing tables: ${missing.join(', ')}\n` +
      'Run "npm run db:setup" to create the Weekly Planner tables.'
    );
  }
}

module.exports = {
  sql, connect, close, all, get, run, insert, withTransaction, verifySchema,
  buildConfig, describeTarget, EXPECTED_TABLES,
};
