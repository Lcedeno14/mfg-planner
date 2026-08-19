/**
 * department-card.component.ts — one department's card on the weekly board:
 * its deliverables (ops with serial-number chips) and its Mon-Sat daily plan.
 *
 * This is the most interactive component in the app, so it demonstrates the
 * most patterns:
 *   - signal inputs + an EventEmitter output (data down, events up)
 *   - computed() for derived state (the grouped op picker)
 *   - optimistic UI updates (flip the pixel first, save in the background)
 *   - native HTML5 drag & drop with a custom data type
 *
 * ── The (changed) contract ──────────────────────────────────────────────────
 * This card edits data but does NOT own the board. After any successful save
 * it emits `changed`; the board page responds by refetching the whole week so
 * server-computed totals (card headers, Andon strip) stay consistent
 * everywhere. Cards never recompute totals locally — one source of truth.
 */
import { Component, EventEmitter, Output, computed, input, signal } from '@angular/core';
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
  // Template and styles in separate files (the alternative to the inline
  // style used by smaller components in this app).
  templateUrl: './department-card.component.html',
  styleUrls: ['./department-card.component.scss'],
})
export class DepartmentCardComponent {
  // Signal inputs from the board page. NOTE: `dept` is a reference to an
  // object owned by the parent's board — methods below mutate fields on it
  // (optimistic updates) and then persist via the API.
  dept = input.required<Department>();
  ops = input.required<OpCatalogItem[]>(); // the whole catalog, all departments

  // The output half of the contract: parent listens with (changed)="refresh()".
  @Output() changed = new EventEmitter<void>();

  // --- Add-op dialog state ---
  addOpen = signal(false);
  newOp: OpCatalogItem | null = null;

  // --- Notes dialog state ---
  notesOpen = signal(false);
  notesDay: DayPlan | null = null;

  // --- Inline "+ SN" input state: which deliverable is being typed into ---
  addingSnFor = signal<number | null>(null);
  newSn = '';

  /** Whole op catalog grouped by department, this card's department first —
   *  a card can plan an op borrowed from another department's catalog. */
  groupedOps = computed(() => {
    // Map preserves insertion order and allows any key type — the natural
    // pick for a group-by keyed on numeric department ids.
    const groups = new Map<number, { label: string; items: OpCatalogItem[] }>();
    for (const op of this.ops()) {
      if (!groups.has(op.department_id)) groups.set(op.department_id, { label: op.department_name, items: [] });
      groups.get(op.department_id)!.items.push(op); // ! = "trust me, it exists" (just set above)
    }
    const mine = this.dept().id;
    return [...groups.entries()]
      // Own department first, then the rest alphabetically. localeCompare
      // returns 0 on ties, so || falls through to the next criterion.
      .sort(([aId, a], [bId, b]) => (aId === mine ? -1 : bId === mine ? 1 : a.label.localeCompare(b.label)))
      .map(([, g]) => ({
        ...g,
        // { numeric: true } sorts "Op 9" before "Op 105" (string sort wouldn't)
        items: g.items.sort((a, b) => a.op_code.localeCompare(b.op_code, undefined, { numeric: true })),
      }));
  });

  constructor(private api: ApiService) {}

  // ----- header scorecard (server-computed day-plan totals) -----
  pct(): number | null {
    const d = this.dept();
    return d.weekGoal > 0 ? Math.round((d.weekActual / d.weekGoal) * 100) : null;
  }

  /** Same 100/70 thresholds as the scoreboard — the app's one grading scale. */
  pctClass(): string {
    const p = this.pct();
    if (p === null) return 'status-idle';
    return p >= 100 ? 'status-good' : p >= 70 ? 'status-warn' : 'status-bad';
  }

  /** Serials clicked green — the numerator of the "1/2 done" counter. */
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
      // Every day row carries week_id, so days[0] is a handy place to read it.
      week_id: this.dept().days[0].week_id,
      department_id: this.dept().id, // lands on THIS card even for a borrowed op
      op_code: this.newOp.op_code,
      op_name: this.newOp.op_name,
    }).subscribe(() => { this.addOpen.set(false); this.changed.emit(); });
  }

  removeDeliverable(d: Deliverable) {
    // Destructive + cascades to its serials → confirm first.
    if (!confirm(`Remove ${d.op_code} ${d.op_name} and its serial numbers?`)) return;
    this.api.deleteDeliverable(d.id).subscribe(() => this.changed.emit());
  }

  // ----- SN drag & drop -----
  // Native HTML5 DnD: dragstart stamps a payload onto the DataTransfer object,
  // targets opt in by calling preventDefault() on dragover, and drop reads the
  // payload back. The DataTransfer travels between component instances, which
  // is how a chip dragged from Fabrication can drop onto Machining's card.

  /** Custom drag type so day rows and deliverables only react to SN chips. */
  private static readonly SN_DRAG_TYPE = 'text/x-lineboard-sn';

  // Plain properties driving [class.drop-target] hover highlights.
  dayOver: number | null = null;      // day.day currently hovered by an SN drag
  delOver: number | null = null;      // deliverable.id currently hovered

  onSnDragStart(e: DragEvent, s: Serial, d: Deliverable) {
    // DataTransfer only carries strings, so the payload is JSON-encoded.
    e.dataTransfer!.setData(DepartmentCardComponent.SN_DRAG_TYPE,
      JSON.stringify({ sn: s.sn, opName: d.op_name, deliverableId: d.id }));
    e.dataTransfer!.effectAllowed = 'copy'; // cursor shows copy, not move
  }

  private isSnDrag(e: DragEvent): boolean {
    // During dragover the payload VALUE is hidden (browser privacy rule) but
    // the TYPE list is readable — checking it keeps text selections and file
    // drags from lighting up drop targets.
    return !!e.dataTransfer?.types.includes(DepartmentCardComponent.SN_DRAG_TYPE);
  }

  allowDayDrop(e: DragEvent, day: DayPlan) {
    if (!this.isSnDrag(e)) return;
    // preventDefault on dragover is the HTML5 handshake for "drops welcome" —
    // without it the browser suppresses the drop event entirely.
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    this.dayOver = day.day;
  }

  dayLeave(day: DayPlan) {
    if (this.dayOver === day.day) this.dayOver = null;
  }

  /**
   * Drop an SN on a day row: append "SN 223 Casting Pour" to that day's plan,
   * comma-separated when text is already there. The optional `field` lets the
   * 2nd-shift input route the same drop into shift2_plan (its own handler
   * calls with 'shift2_plan' and stops propagation before this row-level
   * handler would write to the 1st-shift plan).
   */
  dropOnDay(e: DragEvent, day: DayPlan, field: 'goal_note' | 'shift2_plan' = 'goal_note') {
    e.preventDefault();  // also stops the browser's default "insert text into input"
    e.stopPropagation();
    this.dayOver = null;
    const raw = e.dataTransfer?.getData(DepartmentCardComponent.SN_DRAG_TYPE);
    if (!raw) return;
    const { sn, opName } = JSON.parse(raw);
    const entry = opName ? `${sn} ${opName}` : sn;
    day[field] = day[field] ? `${day[field]}, ${entry}` : entry;
    this.saveDay(day); // persists via the same upsert as typed edits
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
    // Guards: dropping back onto the same op, or onto an op that already has
    // this SN, is a silent no-op rather than a duplicate.
    if (d.id === deliverableId || d.serials.some(x => x.sn === sn)) return;
    this.api.addSerial(d.id, sn).subscribe(created => {
      d.serials = [...d.serials, created];
      this.changed.emit();
    });
  }

  // ----- serial numbers -----
  toggleSn(s: Serial) {
    // Optimistic update: flip the chip color NOW, then tell the server.
    // The UI feels instant; the (changed) refetch reconciles real state.
    // (Tradeoff: if the PATCH failed, the chip would briefly show the wrong
    // state until that refetch — acceptable for a low-stakes toggle.)
    s.done = s.done ? 0 : 1; // optimistic
    this.api.updateSerial(s.id, { done: s.done }).subscribe(() => this.changed.emit());
  }

  removeSn(event: MouseEvent, s: Serial, d: Deliverable) {
    // The × sits INSIDE the chip button — without stopPropagation the click
    // would bubble up and also toggle done.
    event.stopPropagation();
    d.serials = d.serials.filter(x => x.id !== s.id); // optimistic
    this.api.deleteSerial(s.id).subscribe(() => this.changed.emit());
  }

  startAddSn(d: Deliverable) {
    this.newSn = '';
    this.addingSnFor.set(d.id); // template swaps the "+ SN" button for an input
  }

  confirmAddSn(d: Deliverable) {
    const sn = this.newSn.trim();
    if (!sn) { this.addingSnFor.set(null); return; } // empty = cancel
    this.api.addSerial(d.id, sn).subscribe(created => {
      // New array (not push) so anything comparing references sees the change.
      d.serials = [...d.serials, created];
      this.newSn = '';
      this.addingSnFor.set(null);
      this.changed.emit();
    });
  }

  // ----- daily plan -----
  toggleSecondShift(event: Event) {
    // DOM events are loosely typed; the cast tells TS this target is a checkbox.
    const on = (event.target as HTMLInputElement).checked;
    const d = this.dept();
    d.second_shift = on ? 1 : 0; // optimistic
    // Hiding is presentation-only: shift2 data is retained and comes back
    // when the toggle is re-enabled. Persisted per department, so it sticks
    // across weeks and reloads.
    this.api.updateDepartment(d.id, { second_shift: d.second_shift }).subscribe();
  }

  saveDay(day: DayPlan) {
    // The server upserts by (week, department, day); a fabricated blank row
    // (id null) gains its real id on first save.
    this.api.saveDayPlan(day).subscribe(saved => {
      day.id = saved.id;
      this.changed.emit();
    });
  }

  openNotes(day: DayPlan) {
    // The dialog binds directly to this row object; Save persists it.
    this.notesDay = day;
    this.notesOpen.set(true);
  }

  saveNotes() {
    if (this.notesDay) this.saveDay(this.notesDay);
    this.notesOpen.set(false);
  }

  /** Drives the comment icon: filled when the day has any note text. */
  hasNotes(day: DayPlan): boolean {
    return !!(day.shift1_note || day.shift2_note || day.comment);
  }

  /** Row status class for the day-name color (same thresholds as everywhere). */
  dayPct(day: DayPlan): string {
    if (!day.goal) return 'status-idle';
    const p = day.actual / day.goal;
    return p >= 1 ? 'status-good' : p >= 0.7 ? 'status-warn' : 'status-bad';
  }
}
