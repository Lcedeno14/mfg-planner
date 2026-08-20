-- Lineboard (Weekly Planner) — Microsoft SQL Server schema
-- Idempotent: each object is created only if it does not already exist,
-- so this script is safe to run repeatedly (e.g. from npm run db:setup).
--
-- Table map:
--   WP_departments   departments on the production line
--   WP_op_catalog    operation catalog (op code, name, avg labor hours)
--   WP_weeks         one row per planning week (week_of = the Monday, unique)
--   WP_deliverables  ops planned for a week+department, tracked by serial numbers
--   WP_serials       serial numbers attached to a deliverable, done flag
--   WP_day_plans     Mon-Sat daily plan per week+department (day 0=Mon .. 5=Sat)
--   WP_active_units  snapshot of where each active unit sits (feeds suggestions)
--
-- ── Cascade design ──────────────────────────────────────────────────────────
-- Deleting a WEEK cascades, because that is the routine cleanup operation:
--
--   WP_weeks ─cascade▶ WP_deliverables ─cascade▶ WP_serials
--            └cascade▶ WP_day_plans
--
-- The department links are deliberately NO ACTION instead. SQL Server would
-- accept cascading from both parents, but deleting a department erases that
-- department's planned work and daily history from EVERY week — too destructive
-- to happen as a silent side effect of a foreign key. It is done explicitly, in
-- one transaction, in the DELETE /api/departments/:id handler in src/server.js,
-- where the order of removal is visible and the API can report what it did.
-- Trade-off: forget that code and SQL Server raises a foreign-key error rather
-- than quietly destroying rows, which is the failure mode we want.

IF OBJECT_ID(N'dbo.WP_departments', N'U') IS NULL
CREATE TABLE dbo.WP_departments (
  id INT IDENTITY(1,1) PRIMARY KEY,
  name NVARCHAR(100) NOT NULL,
  color NVARCHAR(9) NOT NULL CONSTRAINT DF_WP_departments_color DEFAULT N'#0078a9',
  sort INT NOT NULL CONSTRAINT DF_WP_departments_sort DEFAULT 0,
  second_shift INT NOT NULL CONSTRAINT DF_WP_departments_second_shift DEFAULT 1
);
GO

IF OBJECT_ID(N'dbo.WP_op_catalog', N'U') IS NULL
CREATE TABLE dbo.WP_op_catalog (
  id INT IDENTITY(1,1) PRIMARY KEY,
  -- Single cascade path (departments -> op catalog), so CASCADE is safe here.
  department_id INT NOT NULL
    CONSTRAINT FK_WP_op_catalog_department REFERENCES dbo.WP_departments(id) ON DELETE CASCADE,
  op_code NVARCHAR(20) NOT NULL,
  op_name NVARCHAR(100) NOT NULL,
  avg_labor_hours FLOAT NOT NULL CONSTRAINT DF_WP_op_catalog_hours DEFAULT 0
);
GO

IF OBJECT_ID(N'dbo.WP_weeks', N'U') IS NULL
CREATE TABLE dbo.WP_weeks (
  id INT IDENTITY(1,1) PRIMARY KEY,
  -- ISO date of the week's Monday, stored as text so the API can exchange
  -- yyyy-mm-dd strings without timezone conversion surprises.
  week_of NVARCHAR(10) NOT NULL CONSTRAINT UQ_WP_weeks_week_of UNIQUE,
  label NVARCHAR(60) NOT NULL
);
GO

IF OBJECT_ID(N'dbo.WP_deliverables', N'U') IS NULL
CREATE TABLE dbo.WP_deliverables (
  id INT IDENTITY(1,1) PRIMARY KEY,
  week_id INT NOT NULL
    CONSTRAINT FK_WP_deliverables_week REFERENCES dbo.WP_weeks(id) ON DELETE CASCADE,
  department_id INT NOT NULL
    CONSTRAINT FK_WP_deliverables_department REFERENCES dbo.WP_departments(id), -- NO ACTION, see header
  op_code NVARCHAR(20) NOT NULL,   -- copied from the catalog, not referenced, so
  op_name NVARCHAR(100) NOT NULL,  -- later catalog edits don't rewrite history
  goal INT NOT NULL CONSTRAINT DF_WP_deliverables_goal DEFAULT 0,
  sort INT NOT NULL CONSTRAINT DF_WP_deliverables_sort DEFAULT 0
);
GO

IF OBJECT_ID(N'dbo.WP_serials', N'U') IS NULL
CREATE TABLE dbo.WP_serials (
  id INT IDENTITY(1,1) PRIMARY KEY,
  deliverable_id INT NOT NULL
    CONSTRAINT FK_WP_serials_deliverable REFERENCES dbo.WP_deliverables(id) ON DELETE CASCADE,
  sn NVARCHAR(50) NOT NULL,
  done INT NOT NULL CONSTRAINT DF_WP_serials_done DEFAULT 0
);
GO

IF OBJECT_ID(N'dbo.WP_day_plans', N'U') IS NULL
CREATE TABLE dbo.WP_day_plans (
  id INT IDENTITY(1,1) PRIMARY KEY,
  week_id INT NOT NULL
    CONSTRAINT FK_WP_day_plans_week REFERENCES dbo.WP_weeks(id) ON DELETE CASCADE,
  department_id INT NOT NULL
    CONSTRAINT FK_WP_day_plans_department REFERENCES dbo.WP_departments(id), -- NO ACTION, see header
  day INT NOT NULL, -- 0=Mon .. 5=Sat
  goal INT NOT NULL CONSTRAINT DF_WP_day_plans_goal DEFAULT 0,
  actual INT NOT NULL CONSTRAINT DF_WP_day_plans_actual DEFAULT 0,
  goal_note NVARCHAR(500) NOT NULL CONSTRAINT DF_WP_day_plans_goal_note DEFAULT N'',   -- 1st shift plan
  shift2_plan NVARCHAR(500) NOT NULL CONSTRAINT DF_WP_day_plans_shift2_plan DEFAULT N'',
  shift1_note NVARCHAR(1000) NOT NULL CONSTRAINT DF_WP_day_plans_shift1_note DEFAULT N'',
  shift2_note NVARCHAR(1000) NOT NULL CONSTRAINT DF_WP_day_plans_shift2_note DEFAULT N'',
  comment NVARCHAR(1000) NOT NULL CONSTRAINT DF_WP_day_plans_comment DEFAULT N'',
  -- One row per cell of the board; this is what makes PUT /api/day-plans an upsert.
  CONSTRAINT UQ_WP_day_plans UNIQUE (week_id, department_id, day)
);
GO

IF OBJECT_ID(N'dbo.WP_active_units', N'U') IS NULL
CREATE TABLE dbo.WP_active_units (
  id INT IDENTITY(1,1) PRIMARY KEY,
  sn NVARCHAR(50) NOT NULL,
  current_op_code NVARCHAR(20) NOT NULL,
  hours_at_op FLOAT NOT NULL CONSTRAINT DF_WP_active_units_hours DEFAULT 0,
  last_txn NVARCHAR(40) NOT NULL   -- human-readable recency, e.g. "2d ago"
);
GO

-- Indexes on the foreign keys the board query filters by. SQL Server indexes
-- primary keys automatically but not foreign keys, and loading a week reads
-- deliverables/serials/day plans by week — worth the index once real weeks pile up.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_WP_deliverables_week' AND object_id = OBJECT_ID(N'dbo.WP_deliverables'))
CREATE INDEX IX_WP_deliverables_week ON dbo.WP_deliverables(week_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_WP_serials_deliverable' AND object_id = OBJECT_ID(N'dbo.WP_serials'))
CREATE INDEX IX_WP_serials_deliverable ON dbo.WP_serials(deliverable_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_WP_day_plans_week' AND object_id = OBJECT_ID(N'dbo.WP_day_plans'))
CREATE INDEX IX_WP_day_plans_week ON dbo.WP_day_plans(week_id);
GO
