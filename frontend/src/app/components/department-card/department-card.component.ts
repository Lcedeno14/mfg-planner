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

  notesOpen = signal(false);
  notesDay: DayPlan | null = null;

  addingSnFor = signal<number | null>(null);
  newSn = '';

  /** Whole op catalog grouped by department, this card's department first —
   *  a card can plan an op borrowed from another department's catalog. */
  groupedOps = computed(() => {
    const groups = new Map<number, { label: string; items: OpCatalogItem[] }>();
    for (const op of this.ops()) {
      if (!groups.has(op.department_id)) groups.set(op.department_id, { label: op.department_name, items: [] });
      groups.get(op.department_id)!.items.push(op);
    }
    const mine = this.dept().id;
    return [...groups.entries()]
      .sort(([aId, a], [bId, b]) => (aId === mine ? -1 : bId === mine ? 1 : a.label.localeCompare(b.label)))
      .map(([, g]) => ({
        ...g,
        items: g.items.sort((a, b) => a.op_code.localeCompare(b.op_code, undefined, { numeric: true })),
      }));
  });

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
    this.addOpen.set(true);
  }

  confirmAdd() {
    if (!this.newOp) return;
    this.api.addDeliverable({
      week_id: this.dept().days[0].week_id,
      department_id: this.dept().id,
      op_code: this.newOp.op_code,
      op_name: this.newOp.op_name,
    }).subscribe(() => { this.addOpen.set(false); this.changed.emit(); });
  }

  removeDeliverable(d: Deliverable) {
    if (!confirm(`Remove ${d.op_code} ${d.op_name} and its serial numbers?`)) return;
    this.api.deleteDeliverable(d.id).subscribe(() => this.changed.emit());
  }

  // ----- SN drag & drop -----
  /** Custom drag type so day rows and deliverables only react to SN chips. */
  private static readonly SN_DRAG_TYPE = 'text/x-lineboard-sn';

  dayOver: number | null = null;      // day.day currently hovered by an SN drag
  delOver: number | null = null;      // deliverable.id currently hovered

  onSnDragStart(e: DragEvent, s: Serial, d: Deliverable) {
    e.dataTransfer!.setData(DepartmentCardComponent.SN_DRAG_TYPE,
      JSON.stringify({ sn: s.sn, opName: d.op_name, deliverableId: d.id }));
    e.dataTransfer!.effectAllowed = 'copy';
  }

  private isSnDrag(e: DragEvent): boolean {
    return !!e.dataTransfer?.types.includes(DepartmentCardComponent.SN_DRAG_TYPE);
  }

  allowDayDrop(e: DragEvent, day: DayPlan) {
    if (!this.isSnDrag(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    this.dayOver = day.day;
  }

  dayLeave(day: DayPlan) {
    if (this.dayOver === day.day) this.dayOver = null;
  }

  dropOnDay(e: DragEvent, day: DayPlan, field: 'goal_note' | 'shift2_plan' = 'goal_note') {
    e.preventDefault();
    e.stopPropagation();
    this.dayOver = null;
    const raw = e.dataTransfer?.getData(DepartmentCardComponent.SN_DRAG_TYPE);
    if (!raw) return;
    const { sn, opName } = JSON.parse(raw);
    const entry = opName ? `${sn} ${opName}` : sn;
    day[field] = day[field] ? `${day[field]}, ${entry}` : entry;
    this.saveDay(day);
  }

  allowDelDrop(e: DragEvent, d: Deliverable) {
    if (!this.isSnDrag(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    this.delOver = d.id;
  }

  delLeave(d: Deliverable) {
    if (this.delOver === d.id) this.delOver = null;
  }

  /** Copy the dragged SN onto another op — the original chip stays where it was. */
  dropOnDeliverable(e: DragEvent, d: Deliverable) {
    e.preventDefault();
    e.stopPropagation();
    this.delOver = null;
    const raw = e.dataTransfer?.getData(DepartmentCardComponent.SN_DRAG_TYPE);
    if (!raw) return;
    const { sn, deliverableId } = JSON.parse(raw);
    if (d.id === deliverableId || d.serials.some(x => x.sn === sn)) return;
    this.api.addSerial(d.id, sn).subscribe(created => {
      d.serials = [...d.serials, created];
      this.changed.emit();
    });
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
  toggleSecondShift(event: Event) {
    const on = (event.target as HTMLInputElement).checked;
    const d = this.dept();
    d.second_shift = on ? 1 : 0; // optimistic
    this.api.updateDepartment(d.id, { second_shift: d.second_shift }).subscribe();
  }

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
