import { Component, EventEmitter, Input, Output, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { ApiService } from '../../api.service';
import { DayPlan, Deliverable, Department, OpCatalogItem, Serial } from '../../models';

@Component({
  selector: 'app-department-card',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, DialogModule, SelectModule, TooltipModule],
  templateUrl: './department-card.component.html',
  styleUrls: ['./department-card.component.scss'],
})
export class DepartmentCardComponent {
  dept = input.required<Department>();
  ops = input.required<OpCatalogItem[]>();
  @Output() changed = new EventEmitter<void>();

  addOpen = signal(false);
  newOp: OpCatalogItem | null = null;
  newGoal = 1;

  notesOpen = signal(false);
  notesDay: DayPlan | null = null;

  addingSnFor = signal<number | null>(null);
  newSn = '';

  deptOps = computed(() => this.ops().filter(o => o.department_id === this.dept().id));

  constructor(private api: ApiService) {}

  pct(): number | null {
    const d = this.dept();
    return d.weekGoal > 0 ? Math.round((d.weekActual / d.weekGoal) * 100) : null;
  }

  pctClass(): string {
    const p = this.pct();
    if (p === null) return 'status-idle';
    return p >= 100 ? 'status-good' : p >= 70 ? 'status-warn' : 'status-bad';
  }

  snDone(d: Deliverable): number {
    return d.serials.filter(s => s.done).length;
  }

  // ----- deliverables -----
  openAdd() {
    this.newOp = null;
    this.newGoal = 1;
    this.addOpen.set(true);
  }

  confirmAdd() {
    if (!this.newOp) return;
    this.api.addDeliverable({
      week_id: this.dept().days[0].week_id,
      department_id: this.dept().id,
      op_code: this.newOp.op_code,
      op_name: this.newOp.op_name,
      goal: this.newGoal,
    }).subscribe(() => { this.addOpen.set(false); this.changed.emit(); });
  }

  saveGoal(d: Deliverable) {
    this.api.updateDeliverable(d.id, { goal: d.goal }).subscribe(() => this.changed.emit());
  }

  removeDeliverable(d: Deliverable) {
    if (!confirm(`Remove ${d.op_code} ${d.op_name} and its serial numbers?`)) return;
    this.api.deleteDeliverable(d.id).subscribe(() => this.changed.emit());
  }

  // ----- serial numbers -----
  toggleSn(s: Serial) {
    s.done = s.done ? 0 : 1; // optimistic
    this.api.updateSerial(s.id, { done: s.done }).subscribe(() => this.changed.emit());
  }

  removeSn(event: MouseEvent, s: Serial, d: Deliverable) {
    event.stopPropagation();
    d.serials = d.serials.filter(x => x.id !== s.id); // optimistic
    this.api.deleteSerial(s.id).subscribe(() => this.changed.emit());
  }

  startAddSn(d: Deliverable) {
    this.newSn = '';
    this.addingSnFor.set(d.id);
  }

  confirmAddSn(d: Deliverable) {
    const sn = this.newSn.trim();
    if (!sn) { this.addingSnFor.set(null); return; }
    this.api.addSerial(d.id, sn).subscribe(created => {
      d.serials = [...d.serials, created];
      this.newSn = '';
      this.addingSnFor.set(null);
      this.changed.emit();
    });
  }

  // ----- daily plan -----
  saveDay(day: DayPlan) {
    this.api.saveDayPlan(day).subscribe(saved => {
      day.id = saved.id;
      this.changed.emit();
    });
  }

  openNotes(day: DayPlan) {
    this.notesDay = day;
    this.notesOpen.set(true);
  }

  saveNotes() {
    if (this.notesDay) this.saveDay(this.notesDay);
    this.notesOpen.set(false);
  }

  hasNotes(day: DayPlan): boolean {
    return !!(day.shift1_note || day.shift2_note || day.comment);
  }

  dayPct(day: DayPlan): string {
    if (!day.goal) return 'status-idle';
    const p = day.actual / day.goal;
    return p >= 1 ? 'status-good' : p >= 0.7 ? 'status-warn' : 'status-bad';
  }
}
