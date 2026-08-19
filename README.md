# Lineboard — Weekly Production Planner

A weekly planning board for a multi-department manufacturing line, replacing the Excel weekly plan. Angular 19 + PrimeNG frontend, Node/Express + SQLite backend.

## What it does

- **Weekly board** — one card per department (Fabrication, Machining, Coatings Lab, Quality & Finishing), each with:
  - **Deliverables**: operations (from the op catalog) with a weekly goal and serial numbers. Click an SN chip to mark it complete (turns green) — same habit as highlighting cells in the sheet.
  - **Daily plan**: Mon–Fri rows with a plan note, goal, and actual, plus 1st/2nd shift notes and comments behind the note icon.
- **Andon scoreboard** — week total plus per-day actual/goal/% tiles, colored green/amber/red, computed live from the department daily actuals. Today's tile is marked when viewing the current week.
- **Weeks** — create a new week (optionally copying operations from the selected week), switch between weeks like sheet tabs.
- **Suggested plan** — v1 of the automation: reads the active-unit snapshot (mocked stand-in for the part-transaction SQL database), groups queued units by their current op, proposes a weekly goal per op based on average labor hours vs. a 40 h capacity assumption, and lets you push a suggestion straight into a week's plan. Units with no recent transactions are flagged **verify**, since the source data runs ~80% accurate.

All op codes, departments, and serial numbers are made-up examples.

## Run it

Requires Node 20+.

```bash
# Terminal 1 — API (port 3000)
cd backend
npm install
node src/server.js

# Terminal 2 — Angular dev server (port 4200, proxies /api to 3000)
cd frontend
npm install
npx ng serve
```

Open http://localhost:4200. The SQLite database is created and seeded at `backend/data/planner.db` on first run (delete it to re-seed).

**Production:** `cd frontend && npx ng build`, then run the backend — Express serves the built app at http://localhost:3000. Open **:3000**, not :4200, and re-run `ng build` after any frontend change (production serves the compiled files, not your source).

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

Azure SQL note: keep `MSSQL_ENCRYPT=true` (default). For a local SQL Server with a self-signed certificate, also set `MSSQL_TRUST_SERVER_CERTIFICATE=true`.

### Migrating your SQLite data

Local development runs on SQLite (`backend/data/planner.db`) with the same `WP_` table names and schema, so moving your existing weeks into SQL Server is one command:

```bash
cd backend
npm run db:migrate -- --dry-run   # preview what would be copied (no MSSQL needed)
npm run db:migrate                # copy everything into the WP_ tables
```

- IDs are preserved, so every serial number, deliverable, and day plan keeps its links.
- The whole migration runs in a single transaction — it either completes fully or leaves SQL Server untouched.
- It refuses to run into non-empty `WP_` tables; add `--force` to wipe them and migrate fresh.
- Safe order of operations: `npm run db:setup` first (creates tables), then `npm run db:migrate`.

After migrating, the remaining step is switching the Express data layer from `better-sqlite3` to the `mssql` connection (both packages are already installed; the queries and table names are identical).

## Structure

```
backend/
  src/db.js        # schema + seed (departments, op catalog, sample week, active-unit mock)
  src/server.js    # REST API + suggestion engine + static hosting
  scripts/create-tables.sql  # SQL Server DDL for all WP_ tables (idempotent)
  scripts/setup-db.js        # npm run db:setup — creates missing tables, verifies
  scripts/migrate-sqlite-to-mssql.js  # npm run db:migrate — SQLite data -> MSSQL
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
2. **Labor-hour planning** — `op_catalog.avg_labor_hours` already drives suggested goals; extend with per-day capacity and headcount to auto-fill the Mon–Fri goals.
3. **Auto-actuals** — derive daily actuals from operation-complete transactions instead of manual entry, with a manual override for the 20% the data gets wrong.
4. **History & trends** — weekly % over time per department (data model already keeps every week).
