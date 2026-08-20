/**
 * models.ts — TypeScript interfaces describing every shape of data the API returns.
 *
 * ── TypeScript: what an interface is ────────────────────────────────────────
 * An interface is a compile-time contract: "an object of this type has these
 * properties with these types." It generates NO JavaScript — it exists purely
 * so the compiler (and your editor) can catch mistakes like `serial.snn` or
 * passing a Week where a Department is expected, before the code ever runs.
 *
 * ── System design: mirroring the API ────────────────────────────────────────
 * These interfaces deliberately mirror the JSON the Express backend sends,
 * column names and all (snake_case like week_id comes straight from the
 * database schema). Keeping one file of shared shapes means a backend change
 * gets caught here first: update the interface, and the compiler points at
 * every component that needs to catch up. In a bigger system this contract
 * might be generated from an OpenAPI spec — same idea, automated.
 *
 * Note the number-as-boolean pattern: the database stores flags like `done`
 * and `second_shift` as INT columns holding 0 or 1, so they arrive as numbers.
 * TypeScript types them `number` and code tests them with truthiness
 * (`if (s.done)`) rather than `=== true`.
 */

/** One serial number chip under a deliverable. */
export interface Serial {
  id: number;
  deliverable_id: number; // foreign key to the owning Deliverable
  sn: string;             // the serial number text itself, e.g. "SN 1006"
  done: number;           // 0 | 1 — clicked green or not
}

/** An operation planned on a department's card for one week. */
export interface Deliverable {
  id: number;
  week_id: number;
  department_id: number;
  op_code: string;   // snapshot of the catalog op at planning time
  op_name: string;   // (kept even if the catalog entry is later edited/deleted)
  goal: number;      // legacy; progress is now serials done / serials added
  sort: number;      // manual ordering within the card
  serials: Serial[]; // children, attached by the server's weekPayload
}

/** One row of a department's Mon-Sat daily plan grid. */
export interface DayPlan {
  // `number | null` is a union type: the id is null when the row doesn't exist
  // in the DB yet (the server fabricates blank rows so the grid is always 6
  // days) — the first save creates it and fills the id in.
  id: number | null;
  week_id: number;
  department_id: number;
  day: number;         // 0=Mon .. 5=Sat, same convention as the backend
  name: string;        // "Monday".. supplied by the server for display
  goal: number;        // these two drive every scorecard in the app
  actual: number;
  goal_note: string;   // 1st shift plan (historic column name)
  shift2_plan: string;
  shift1_note: string; // what actually happened, per shift
  shift2_note: string;
  comment: string;
}

/** Bare department row, as stored — no board data attached. */
export interface DepartmentInfo {
  id: number;
  name: string;
  color: string;        // hex color used for the card accent and op chips
  sort: number;
  second_shift: number; // 0 | 1 — whether the board shows 2nd-shift plan rows
}

/**
 * A department as it appears inside a week board: the stored row PLUS its
 * deliverables, day plans, and server-computed totals. Same fields as
 * DepartmentInfo by design — the extra properties are what weekPayload adds.
 */
export interface Department {
  id: number;
  name: string;
  color: string;
  sort: number;
  second_shift: number;
  deliverables: Deliverable[];
  days: DayPlan[];
  weekGoal: number;   // sum of the six days' goals (computed server-side)
  weekActual: number; // sum of the six days' actuals
}

/** One column of the Andon scoreboard: a day's totals across all departments. */
export interface DayScore {
  name: string;
  day: number;
  goal: number;
  actual: number;
}

/** A week as listed in the picker — just identity, no board data. */
export interface Week {
  id: number;
  week_of: string; // ISO date of the Monday, e.g. "2026-08-17"
  label: string;   // display text, e.g. "Wk of 2026-08-17"
}

/**
 * The full board for one week — the app's central data structure.
 * `extends Week` means: everything Week has, plus these fields. This matches
 * the server literally spreading the week row into the payload.
 */
export interface WeekBoard extends Week {
  departments: Department[];
  dayScore: DayScore[];
  overall: { goal: number; actual: number }; // inline object type for a one-off shape
}

/** A catalog operation, with its department's name joined on by the server. */
export interface OpCatalogItem {
  id: number;
  department_id: number;
  department_name: string; // denormalized via SQL JOIN — saves a lookup client-side
  op_code: string;
  op_name: string;
  avg_labor_hours: number; // feeds the suggestion engine's capacity math
}

/** A unit queued at an op, as reported by the (~80% accurate) snapshot. */
export interface SuggestionQueuedUnit {
  sn: string;
  hours_at_op: number;
  last_txn: string; // human-readable recency, e.g. "2d ago"
}

/** One card on the Suggested Plan page: an op with queued units and proposed goal. */
export interface Suggestion {
  department_id: number;
  department_name: string;
  color: string;
  op_code: string;
  op_name: string;
  avg_labor_hours: number;
  queued: SuggestionQueuedUnit[];
  suggested_goal: number; // min(queued, weekly capacity at avg labor hours)
  est_hours: number;
  verify: string[];       // SNs with no recent transactions — confirm before trusting
}

/** Envelope for GET /api/suggestions — data plus honest caveats about it. */
export interface SuggestionResponse {
  generated_at: string;
  accuracy_note: string;        // the server states its data quality up front
  week_hours_assumption: number;
  suggestions: Suggestion[];
}
