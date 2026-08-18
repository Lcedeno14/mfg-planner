export interface Serial {
  id: number;
  deliverable_id: number;
  sn: string;
  done: number;
}

export interface Deliverable {
  id: number;
  week_id: number;
  department_id: number;
  op_code: string;
  op_name: string;
  goal: number;
  sort: number;
  serials: Serial[];
}

export interface DayPlan {
  id: number | null;
  week_id: number;
  department_id: number;
  day: number;
  name: string;
  goal: number;
  actual: number;
  goal_note: string;
  shift1_note: string;
  shift2_note: string;
  comment: string;
}

export interface Department {
  id: number;
  name: string;
  color: string;
  sort: number;
  deliverables: Deliverable[];
  days: DayPlan[];
  weekGoal: number;
  weekActual: number;
}

export interface DayScore {
  name: string;
  day: number;
  goal: number;
  actual: number;
}

export interface Week {
  id: number;
  week_of: string;
  label: string;
}

export interface WeekBoard extends Week {
  departments: Department[];
  dayScore: DayScore[];
  overall: { goal: number; actual: number };
}

export interface OpCatalogItem {
  id: number;
  department_id: number;
  department_name: string;
  op_code: string;
  op_name: string;
  avg_labor_hours: number;
}

export interface SuggestionQueuedUnit {
  sn: string;
  hours_at_op: number;
  last_txn: string;
}

export interface Suggestion {
  department_id: number;
  department_name: string;
  color: string;
  op_code: string;
  op_name: string;
  avg_labor_hours: number;
  queued: SuggestionQueuedUnit[];
  suggested_goal: number;
  est_hours: number;
  verify: string[];
}

export interface SuggestionResponse {
  generated_at: string;
  accuracy_note: string;
  week_hours_assumption: number;
  suggestions: Suggestion[];
}
