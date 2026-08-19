/**
 * api.service.ts — the frontend's single gateway to the backend.
 *
 * ── System design: why one service ──────────────────────────────────────────
 * Every HTTP call the app makes goes through this class. Components never
 * build URLs or touch HttpClient directly — they call typed methods like
 * `api.week(3)`. That gives three things:
 *   1. one place to change if an endpoint moves or auth headers appear,
 *   2. compile-time types on every request and response,
 *   3. components that read as intent ("save the day plan"), not plumbing.
 *
 * ── Angular: dependency injection (DI) ──────────────────────────────────────
 * @Injectable({ providedIn: 'root' }) registers this class with Angular's
 * injector as an app-wide singleton. Any component declaring a constructor
 * parameter `private api: ApiService` receives the shared instance — nobody
 * ever writes `new ApiService(...)`. DI is what makes swapping a real service
 * for a mock in tests trivial.
 *
 * ── RxJS: what an Observable is ─────────────────────────────────────────────
 * HttpClient methods don't return data — they return Observable<T>, a lazy
 * stream. NOTHING is sent until someone calls .subscribe(callback); the
 * callback then fires with the parsed JSON when the response lands. The <T>
 * generic (e.g. Observable<Week[]>) tells the compiler what that JSON will
 * look like, so a typo like `week.labell` is caught at build time.
 */
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  DayPlan, Deliverable, DepartmentInfo, OpCatalogItem, Serial, SuggestionResponse, Week, WeekBoard,
} from './models';

// Relative base path — no host or port. In development the Angular dev server
// proxies /api to the Express backend (frontend/proxy.conf.json); in
// production Express serves the app itself so /api is simply the same origin.
// Either way, this file never needs to know where the backend lives.
const BASE = '/api';

@Injectable({ providedIn: 'root' })
export class ApiService {
  // `private http: HttpClient` in the constructor is shorthand that declares
  // AND assigns a class property — Angular injects the instance.
  constructor(private http: HttpClient) {}

  // ----- weeks -----

  /** List all weeks, newest first (drives the week picker). */
  weeks(): Observable<Week[]> {
    // Template literal `${BASE}/weeks` — string interpolation, not concatenation.
    return this.http.get<Week[]>(`${BASE}/weeks`);
  }

  /** Fetch the full board for one week: departments, deliverables, day plans, scores. */
  week(id: number): Observable<WeekBoard> {
    return this.http.get<WeekBoard>(`${BASE}/weeks/${id}`);
  }

  /**
   * Create a week (any date — the server anchors it to that week's Monday),
   * optionally copying deliverables from another week. The `?` marks the
   * parameter optional; omitted means "start blank".
   */
  createWeek(week_of: string, copyFromWeekId?: number): Observable<WeekBoard> {
    return this.http.post<WeekBoard>(`${BASE}/weeks`, { week_of, copyFromWeekId });
  }

  // ----- deliverables -----

  /**
   * Partial<Deliverable> is a TypeScript utility type: "any subset of
   * Deliverable's fields". It fits REST create/update bodies exactly —
   * send only what you have, the server defaults or preserves the rest.
   */
  addDeliverable(body: Partial<Deliverable>): Observable<Deliverable> {
    return this.http.post<Deliverable>(`${BASE}/deliverables`, body);
  }

  updateDeliverable(id: number, body: Partial<Deliverable>): Observable<Deliverable> {
    // PATCH = partial update; fields you don't send keep their stored values.
    return this.http.patch<Deliverable>(`${BASE}/deliverables/${id}`, body);
  }

  deleteDeliverable(id: number): Observable<unknown> {
    // `unknown` — the response body ({ ok: true }) carries nothing we use.
    // Callers subscribe purely for the completion signal.
    return this.http.delete(`${BASE}/deliverables/${id}`);
  }

  // ----- serial numbers -----

  /** Nested route mirrors ownership: a serial is created *under* a deliverable. */
  addSerial(deliverableId: number, sn: string): Observable<Serial> {
    return this.http.post<Serial>(`${BASE}/deliverables/${deliverableId}/serials`, { sn });
  }

  /** Used mainly to flip `done` when an SN chip is clicked. */
  updateSerial(id: number, body: Partial<Serial>): Observable<Serial> {
    return this.http.patch<Serial>(`${BASE}/serials/${id}`, body);
  }

  deleteSerial(id: number): Observable<unknown> {
    return this.http.delete(`${BASE}/serials/${id}`);
  }

  // ----- day plans -----

  /**
   * PUT because a day-plan cell is addressed by natural key (week+dept+day)
   * and the server upserts — saving the same cell twice is safe (idempotent).
   */
  saveDayPlan(body: Partial<DayPlan>): Observable<DayPlan> {
    return this.http.put<DayPlan>(`${BASE}/day-plans`, body);
  }

  // ----- departments (Setup page) -----

  departments(): Observable<DepartmentInfo[]> {
    return this.http.get<DepartmentInfo[]>(`${BASE}/departments`);
  }

  createDepartment(body: { name: string; color?: string }): Observable<DepartmentInfo> {
    return this.http.post<DepartmentInfo>(`${BASE}/departments`, body);
  }

  updateDepartment(id: number, body: Partial<DepartmentInfo>): Observable<DepartmentInfo> {
    return this.http.patch<DepartmentInfo>(`${BASE}/departments/${id}`, body);
  }

  deleteDepartment(id: number): Observable<unknown> {
    return this.http.delete(`${BASE}/departments/${id}`);
  }

  // ----- op catalog (Setup page) -----

  ops(): Observable<OpCatalogItem[]> {
    return this.http.get<OpCatalogItem[]>(`${BASE}/ops`);
  }

  createOp(body: Partial<OpCatalogItem>): Observable<OpCatalogItem> {
    return this.http.post<OpCatalogItem>(`${BASE}/ops`, body);
  }

  updateOp(id: number, body: Partial<OpCatalogItem>): Observable<OpCatalogItem> {
    return this.http.patch<OpCatalogItem>(`${BASE}/ops/${id}`, body);
  }

  deleteOp(id: number): Observable<unknown> {
    return this.http.delete(`${BASE}/ops/${id}`);
  }

  // ----- suggestion engine -----

  suggestions(): Observable<SuggestionResponse> {
    return this.http.get<SuggestionResponse>(`${BASE}/suggestions`);
  }

  /** Push one suggestion onto a week's board as a deliverable with its SNs. */
  applySuggestion(body: {
    week_id: number; department_id: number; op_code: string; op_name: string; goal: number; sns: string[];
  }): Observable<unknown> {
    return this.http.post(`${BASE}/suggestions/apply`, body);
  }
}
