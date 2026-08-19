-- Lineboard (Weekly Planner) — Microsoft SQL Server schema
-- Idempotent: each table is created only if it does not already exist,
-- so this script is safe to run repeatedly (e.g. from npm run db:setup).
--
-- Table map:
--   WP_departments   departments on the production line
--   WP_op_catalog    operation catalog (op code, name, avg labor hours)
--   WP_weeks         one row per planning week (week_of = the Monday, unique)
--   WP_deliverables  ops planned for a week+department, with a weekly goal
--   WP_serials       serial numbers attached to a deliverable, done flag
--   WP_day_plans     Mon-Sat daily plan per week+department (day 0=Mon .. 5=Sat)
--   WP_active_units  snapshot of where each active unit sits (feeds suggestions)

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
  -- ISO date of the week's Monday; the API exchanges yyyy-mm-dd strings
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
    CONSTRAINT FK_WP_deliverables_department REFERENCES dbo.WP_departments(id) ON DELETE CASCADE,
  op_code NVARCHAR(20) NOT NULL,
  op_name NVARCHAR(100) NOT NULL,
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
  -- NO ACTION (not CASCADE) to avoid SQL Server's multiple-cascade-path error;
  -- deleting a department must first remove its day plans (the API handles this).
  department_id INT NOT NULL
    CONSTRAINT FK_WP_day_plans_department REFERENCES dbo.WP_departments(id),
  day INT NOT NULL, -- 0=Mon .. 5=Sat
  goal INT NOT NULL CONSTRAINT DF_WP_day_plans_goal DEFAULT 0,
  actual INT NOT NULL CONSTRAINT DF_WP_day_plans_actual DEFAULT 0,
  goal_note NVARCHAR(500) NOT NULL CONSTRAINT DF_WP_day_plans_goal_note DEFAULT N'',   -- 1st shift plan
  shift2_plan NVARCHAR(500) NOT NULL CONSTRAINT DF_WP_day_plans_shift2_plan DEFAULT N'',
  shift1_note NVARCHAR(1000) NOT NULL CONSTRAINT DF_WP_day_plans_shift1_note DEFAULT N'',
  shift2_note NVARCHAR(1000) NOT NULL CONSTRAINT DF_WP_day_plans_shift2_note DEFAULT N'',
  comment NVARCHAR(1000) NOT NULL CONSTRAINT DF_WP_day_plans_comment DEFAULT N'',
  CONSTRAINT UQ_WP_day_plans UNIQUE (week_id, department_id, day)
);
GO

IF OBJECT_ID(N'dbo.WP_active_units', N'U') IS NULL
CREATE TABLE dbo.WP_active_units (
  id INT IDENTITY(1,1) PRIMARY KEY,
  sn NVARCHAR(50) NOT NULL,
  current_op_code NVARCHAR(20) NOT NULL,
  hours_at_op FLOAT NOT NULL CONSTRAINT DF_WP_active_units_hours DEFAULT 0,
  last_txn NVARCHAR(40) NOT NULL
);
GO
