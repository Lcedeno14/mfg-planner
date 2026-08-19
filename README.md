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

**Production:** `cd frontend && npx ng build`, then run the backend — Express serves the built app at http://localhost:3000.

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

Local development currently runs on SQLite with the same `WP_` table names and schema; the Express data layer swaps to the MSSQL connection as the next step once credentials are in place.

## Structure

```
backend/
  src/db.js        # schema + seed (departments, op catalog, sample week, active-unit mock)
  src/server.js    # REST API + suggestion engine + static hosting
  scripts/create-tables.sql  # SQL Server DDL for all WP_ tables (idempotent)
  scripts/setup-db.js        # npm run db:setup — creates missing tables, verifies
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
