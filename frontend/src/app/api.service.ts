import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  DayPlan, Deliverable, DepartmentInfo, OpCatalogItem, Serial, SuggestionResponse, Week, WeekBoard,
} from './models';

const BASE = '/api';

@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(private http: HttpClient) {}

  weeks(): Observable<Week[]> {
    return this.http.get<Week[]>(`${BASE}/weeks`);
  }

  week(id: number): Observable<WeekBoard> {
    return this.http.get<WeekBoard>(`${BASE}/weeks/${id}`);
  }

  createWeek(week_of: string, copyFromWeekId?: number): Observable<WeekBoard> {
    return this.http.post<WeekBoard>(`${BASE}/weeks`, { week_of, copyFromWeekId });
  }

  addDeliverable(body: Partial<Deliverable>): Observable<Deliverable> {
    return this.http.post<Deliverable>(`${BASE}/deliverables`, body);
  }

  updateDeliverable(id: number, body: Partial<Deliverable>): Observable<Deliverable> {
    return this.http.patch<Deliverable>(`${BASE}/deliverables/${id}`, body);
  }

  deleteDeliverable(id: number): Observable<unknown> {
    return this.http.delete(`${BASE}/deliverables/${id}`);
  }

  addSerial(deliverableId: number, sn: string): Observable<Serial> {
    return this.http.post<Serial>(`${BASE}/deliverables/${deliverableId}/serials`, { sn });
  }

  updateSerial(id: number, body: Partial<Serial>): Observable<Serial> {
    return this.http.patch<Serial>(`${BASE}/serials/${id}`, body);
  }

  deleteSerial(id: number): Observable<unknown> {
    return this.http.delete(`${BASE}/serials/${id}`);
  }

  saveDayPlan(body: Partial<DayPlan>): Observable<DayPlan> {
    return this.http.put<DayPlan>(`${BASE}/day-plans`, body);
  }

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

  suggestions(): Observable<SuggestionResponse> {
    return this.http.get<SuggestionResponse>(`${BASE}/suggestions`);
  }

  applySuggestion(body: {
    week_id: number; department_id: number; op_code: string; op_name: string; goal: number; sns: string[];
  }): Observable<unknown> {
    return this.http.post(`${BASE}/suggestions/apply`, body);
  }
}
