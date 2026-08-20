# Lineboard — Weekly Production Planner

A weekly planning board for a multi-department manufacturing line, replacing the Excel weekly plan. Angular 19 + PrimeNG frontend, Node/Express + Microsoft SQL Server backend.

## What it does

- **Weekly board** — one card per department (Fabrication, Machining, Coatings Lab, Quality & Finishing), each with:
  - **Deliverables**: operations (from the op catalog) with a weekly goal and serial numbers. Click an SN chip to mark it complete (turns green) — same habit as highlighting cells in the sheet.
  - **Daily plan**: Mon–Sat rows with a 1st/2nd shift plan, goal, and actual, plus shift notes and comments behind the note icon. The 2nd-shift rows can be hidden per department.
- **Andon scoreboard** — week total plus per-day actual/goal/% tiles, colored green/amber/red, computed live from the department daily actuals. Today's tile is marked when viewing the current week.
- **Weeks** — create a new week (optionally copying operations from the selected week), switch between weeks like sheet tabs.
- **Suggested plan** — v1 of the automation: reads the active-unit snapshot (mocked stand-in for the part-transaction SQL database), groups queued units by their current op, proposes a weekly goal per op based on average labor hours vs. a 40 h capacity assumption, and lets you push a suggestion straight into a week's plan. Units with no recent transactions are flagged **verify**, since the source data runs ~80% accurate.

All op codes, departments, and serial numbers are made-up examples.

## Setting up on a new machine

Everything the app needs comes from `backend/.env`. Nothing else is machine-specific — no Docker, no local database file, no build tools.

```bash
git clone <this repo>
cd mfg-planner

# 1. Backend deps + your database connection
cd backend
npm install
cp .env.example .env          # fill in server, database, user, password
npm run db:setup              # creates the WP_ tables in that database
npm run db:seed               # OPTIONAL — sample data; skip on a real database

# 2. Frontend deps
cd ../frontend
npm install
```

Then run it in whichever mode you want (below). A few things worth knowing:

- **The database must already exist.** `db:setup` creates the *tables*, not the database — ask your DBA for an empty database, or `CREATE DATABASE Lineboard;` if you have rights.
- **Skip `db:seed` on a real database.** It inserts invented departments; it refuses to run once any departments exist, and the app is perfectly usable empty — add your departments and ops on the **Setup** page.
- **`better-sqlite3` is an optional dependency** and is not used at runtime. It compiles native code, so if a locked-down machine can't build it, `npm install` still succeeds and the app runs fine. Only `npm run db:migrate` needs it.
- **Common connection settings** — named instances, Windows/domain logins and self-signed certificates are all covered in the comments in `.env.example`.

## Run it

Requires Node 20+ and a reachable Microsoft SQL Server database (see the setup above).

**Development** — two terminals, live reload on save:

```bash
# Terminal 1 — API (port 3000)
cd backend && npm start

# Terminal 2 — Angular dev server (port 4200, proxies /api to 3000)
cd frontend && npx ng serve
```

Open http://localhost:4200.

**Production** — one process serves everything:

```bash
cd frontend && npx ng build     # compiles the UI into frontend/dist
cd ../backend && npm start      # serves the UI *and* the API on :3000
```

Open http://localhost:**3000** (not :4200). Re-run `ng build` after any frontend change — production serves the compiled files, not your source.

The API checks its connection and schema at startup, so misconfiguration fails immediately with a message telling you what to fix, rather than surfacing as broken requests later:

| Message at startup | Fix |
|---|---|
| `Missing environment variables: ...` | `cp .env.example .env` and fill it in |
| `Login failed for user '...'` | wrong username/password in `.env` |
| `Failed to connect to ...` | wrong server/port, or the instance needs `MSSQL_INSTANCE` |
| `self signed certificate` | set `MSSQL_TRUST_SERVER_CERTIFICATE=true` |
| `Missing tables: WP_...` | run `npm run db:setup` |

### How the two servers fit together

In development there are two processes, and the browser only ever talks to the first one:

```
browser ──▶ :4200  ng serve   UI files, rebuilds on save
                │
                │  requests starting with /api are forwarded
                ▼
            :3000  Express     the API and the database
```

The frontend asks for `/api/...` — a relative URL with no host or port (see `BASE` in `frontend/src/app/api.service.ts`). On its own that would hit :4200, which holds no data. `frontend/proxy.conf.json` tells the dev server to forward anything under `/api` to the backend:

```json
{ "/api": { "target": "http://localhost:3000", "secure": false } }
```

That keeps the port out of the frontend code, so the same code works in production — where there is only **one** server: `ng build` compiles the UI into `frontend/dist`, Express serves those files alongside the API, `/api` is same-origin, and the proxy is never used.

Three things that bite people:

- **The backend must be running**, or the UI loads with every panel empty — the data requests are forwarded into nothing. Start it first.
- **`proxy.conf.json` is read once, when `ng serve` starts.** Editing it while the dev server is running changes nothing until you restart it.
- **Its target must match the port the backend is actually on.** They are both 3000 by default; change one and you must change the other.

## Microsoft SQL Server setup

All tables use the `WP_` (Weekly Planner) prefix: `WP_departments`, `WP_op_catalog`, `WP_weeks`, `WP_deliverables`, `WP_serials`, `WP_day_plans`, `WP_active_units`. The full schema lives in [backend/scripts/create-tables.sql](backend/scripts/create-tables.sql).

1. Create an empty database on your SQL Server (e.g. `CREATE DATABASE Lineboard;`) and a SQL login the app can use.
2. Copy the env template and fill in your connection details — `.env` is gitignored, so secrets never land in the repo:
   ```bash
   cp backend/.env.example backend/.env
   ```
3. Create the tables (safe to run repeatedly — it only creates what's missing, and prints a per-table `created` / `already existed` checklist):
   ```bash
   cd backend
   npm install
   npm run db:setup
   ```
4. Optionally load a sample week so the board has something to show:
   ```bash
   npm run db:seed
   ```
   Seeding is **not** automatic and refuses to run once any departments exist, so it can never mix invented departments into real data. On an empty database the app is still usable — add your departments and ops on the Setup page.

Azure SQL note: keep `MSSQL_ENCRYPT=true` (default). For a local SQL Server with a self-signed certificate, also set `MSSQL_TRUST_SERVER_CERTIFICATE=true`.

### Notes on the data layer

- **Connection pooling.** The API opens one pool at startup and reuses those connections; it never opens a connection per request.
- **Transactions.** Multi-step writes — creating a week, applying a suggestion, deleting a department — run inside a transaction, so a failure part-way leaves nothing half-applied.
- **Deleting a week** cascades in the database to its deliverables, serials and day plans. **Deleting a department** does not cascade by design; the API removes its rows explicitly in one transaction and reports what it deleted. See the cascade note at the top of [create-tables.sql](backend/scripts/create-tables.sql).
- **Parameterized queries everywhere.** Values are bound as parameters, never concatenated into SQL.

### Migrating data from the old SQLite build

Earlier versions stored data in a local SQLite file (`backend/data/planner.db`). If you have one, move it across in one command — the table names and schema are identical:

```bash
cd backend
npm install                       # better-sqlite3 is a devDependency, used only by this script
npm run db:migrate -- --dry-run   # preview what would be copied (no SQL Server needed)
npm run db:migrate                # copy everything into the WP_ tables
```

- IDs are preserved, so every serial number, deliverable, and day plan keeps its links.
- The whole migration runs in a single transaction — it either completes fully or leaves SQL Server untouched.
- It refuses to run into non-empty `WP_` tables; add `--force` to wipe them and migrate fresh.
- Safe order of operations: `npm run db:setup` first (creates tables), then `npm run db:migrate`.

The runtime no longer uses SQLite at all — this script is the only thing that reads it.

## Structure

```
backend/
  src/db.js        # SQL Server connection pool + query/transaction helpers
  src/server.js    # REST API + suggestion engine + static hosting
  scripts/create-tables.sql  # SQL Server DDL for all WP_ tables (idempotent)
  scripts/setup-db.js        # npm run db:setup — creates missing tables, verifies
  scripts/seed-demo.js       # npm run db:seed — optional sample week
  scripts/migrate-sqlite-to-mssql.js  # npm run db:migrate — old SQLite file -> MSSQL
  .env.example     # SQL Server connection template (copy to .env)
frontend/
  src/app/
    pages/board/            # weekly board (week picker, scoreboard, dept grid)
    pages/suggestions/      # suggested plan from active-unit data
    components/scoreboard/  # andon strip
    components/department-card/
    api.service.ts, models.ts
```

## API sketch

- `GET/POST /api/weeks`, `GET /api/weeks/:id` (full board with computed scorecards)
- `POST/PATCH/DELETE /api/deliverables`, `POST /api/deliverables/:id/serials`, `PATCH/DELETE /api/serials/:id`
- `PUT /api/day-plans` (upsert by week/department/day)
- `GET /api/departments`, `GET /api/ops`
- `GET /api/active-units`, `GET /api/suggestions`, `POST /api/suggestions/apply`

## Roadmap (hooks already in place)

1. **Real transaction data** — replace the `active_units` mock with a view over the plant SQL database; the suggestion endpoint stays the same.
2. **Labor-hour planning** — `op_catalog.avg_labor_hours` already drives suggested goals; extend with per-day capacity and headcount to auto-fill the Mon–Sat goals.
3. **Auto-actuals** — derive daily actuals from operation-complete transactions instead of manual entry, with a manual override for the 20% the data gets wrong.
4. **History & trends** — weekly % over time per department (data model already keeps every week).
