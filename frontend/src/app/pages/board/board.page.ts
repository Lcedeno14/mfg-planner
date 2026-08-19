/**
 * board.page.ts — the home page: week picker, Andon scoreboard, and the grid
 * of department cards.
 *
 * ── System design: container vs presentational ──────────────────────────────
 * This is the "container" (smart) component: it owns the page's state (which
 * week is selected, the loaded board) and talks to the API. The scoreboard
 * and department cards are "presentational" — they receive data via inputs
 * and report changes via outputs, never fetching anything themselves.
 * One owner of truth per page keeps data flow easy to trace.
 *
 * Data flow in one line:
 *   API ─▶ board (signal) ─▶ [inputs] ─▶ cards ─▶ (changed) event ─▶ refresh() ─▶ API
 */
import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { CheckboxModule } from 'primeng/checkbox';
import { ApiService } from '../../api.service';
import { OpCatalogItem, Week, WeekBoard } from '../../models';
import { ScoreboardComponent } from '../../components/scoreboard/scoreboard.component';
import { DepartmentCardComponent } from '../../components/department-card/department-card.component';

@Component({
  selector: 'app-board-page',
  standalone: true,
  imports: [
    CommonModule, FormsModule, ButtonModule, DialogModule, SelectModule,
    DatePickerModule, CheckboxModule, ScoreboardComponent, DepartmentCardComponent,
  ],
  template: `
    <div class="toolbar">
      <!-- [ngModel]/(ngModelChange) split instead of [(ngModel)] because
           selecting a week has a side effect (loading its board), not just a
           value assignment -->
      <p-select [options]="weeks()" [ngModel]="selectedWeek()" (ngModelChange)="selectWeek($event)"
                optionLabel="label" placeholder="Pick a week" styleClass="week-select" />
      <p-button icon="pi pi-plus" label="New week" size="small" outlined (onClick)="newWeekOpen.set(true)" />
      @if (selectedWeek()) {
        <p-button icon="pi pi-print" label="Report" size="small" text (onClick)="openReport()" />
      }
      <span class="spacer"></span>
      @if (board(); as b) {
        <span class="review-hint">Daily review — click a serial number when it's completed.</span>
      }
    </div>

    <!-- "@if (board(); as b)" guards the whole section until the HTTP response
         lands AND names the unwrapped value b — no repeated null checks -->
    @if (board(); as b) {
      <app-scoreboard [dayScore]="b.dayScore" [overall]="b.overall" [isCurrentWeek]="isCurrentWeek()" />
      <div class="dept-grid">
        @for (dept of b.departments; track dept.id) {
          <!-- [dept]/[ops] flow data down; (changed) bubbles edits up so this
               page can refetch and keep every card's totals consistent -->
          <app-department-card [dept]="dept" [ops]="ops()" (changed)="refresh()" />
        }
      </div>
    } @else {
      <p class="empty">No week selected. Create one to start planning.</p>
    }

    <!-- New-week dialog. PrimeNG's p-dialog stays in the DOM; [visible]
         controls whether it's shown. -->
    <p-dialog [visible]="newWeekOpen()" (visibleChange)="newWeekOpen.set($event)" [modal]="true"
              header="New week" [style]="{ width: '26rem' }">
      <div class="dialog-form">
        <label>Week of</label>
        <p-datepicker [(ngModel)]="newWeekDate" dateFormat="yy-mm-dd" [showIcon]="true" appendTo="body" />
        <small class="hint">Pick any date — the week is anchored to its Monday. Only one week per Mon–Sat range.</small>
        <label class="chk">
          <p-checkbox [(ngModel)]="copyPrevious" [binary]="true" inputId="copyPrev" />
          Copy operations from the selected week
        </label>
      </div>
      <ng-template #footer>
        <p-button label="Cancel" text (onClick)="newWeekOpen.set(false)" />
        <p-button label="Create week" [disabled]="!newWeekDate" (onClick)="createWeek()" />
      </ng-template>
    </p-dialog>
  `,
  styles: [`
    .toolbar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.9rem; flex-wrap: wrap; }
    .spacer { flex: 1; } /* pushes the hint to the right edge */
    .review-hint { color: var(--ink-soft); font-size: 0.8rem; }
    /* ::ng-deep pierces view encapsulation to style PrimeNG's inner elements —
       use sparingly; scoped to this component by the :host prefix */
    :host ::ng-deep .week-select { min-width: 13rem; }
    /* auto-fill + minmax = as many 430px-plus columns as fit the viewport;
       cards wrap responsively with no media queries needed */
    .dept-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(430px, 1fr));
      gap: 1rem; margin-top: 1rem; align-items: start;
    }
    @media (max-width: 500px) { .dept-grid { grid-template-columns: 1fr; } }
    .empty { color: var(--ink-soft); margin-top: 2rem; text-align: center; }
    .dialog-form { display: flex; flex-direction: column; gap: 0.5rem; }
    .dialog-form label {
      font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--ink-soft);
    }
    .dialog-form .chk { display: flex; align-items: center; gap: 0.5rem; text-transform: none;
      letter-spacing: 0; font-size: 0.85rem; font-weight: 500; margin-top: 0.5rem; }
    .dialog-form .hint { color: var(--ink-soft); font-size: 0.78rem; text-transform: none; letter-spacing: 0; }
  `],
})
export class BoardPage implements OnInit {
  // signal<T>(initial) creates reactive state: read with weeks(), write with
  // weeks.set(...). Templates reading a signal re-render when it changes —
  // no manual change-detection bookkeeping.
  weeks = signal<Week[]>([]);
  selectedWeek = signal<Week | null>(null);
  board = signal<WeekBoard | null>(null);
  ops = signal<OpCatalogItem[]>([]); // passed to every card for the Add Op picker

  newWeekOpen = signal(false);
  // Plain properties (not signals) are fine for dialog form fields — ngModel
  // reads/writes them directly and nothing derives from them reactively.
  newWeekDate: Date | null = null;
  copyPrevious = true;

  constructor(private api: ApiService, private router: Router) {}

  openReport() {
    const w = this.selectedWeek();
    if (w) this.router.navigate(['/report', w.id]); // → /report/3
  }

  // Angular calls ngOnInit once after constructing the component — the
  // conventional place for initial data loads (constructors stay trivial).
  ngOnInit() {
    this.api.ops().subscribe(o => this.ops.set(o));
    this.api.weeks().subscribe(ws => {
      this.weeks.set(ws);
      if (ws.length) this.selectWeek(ws[0]); // default to the newest week
    });
  }

  selectWeek(w: Week) {
    this.selectedWeek.set(w);
    // Two-step render: the picker updates instantly, the board fills in when
    // the (fast, local) fetch completes.
    this.api.week(w.id).subscribe(b => this.board.set(b));
  }

  /**
   * Refetch the current board. Called after any edit inside a card, because a
   * change in one cell moves numbers elsewhere (card header, Andon strip).
   * Refetching from the server — the single place totals are computed — keeps
   * every view consistent for the price of one cheap local request.
   */
  refresh() {
    const w = this.selectedWeek();
    if (w) this.api.week(w.id).subscribe(b => this.board.set(b));
  }

  /** True when the selected week is the real-world current week (drives the "today" marker). */
  isCurrentWeek(): boolean {
    const w = this.selectedWeek();
    if (!w) return false;
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // back to Monday
    return w.week_of === monday.toISOString().slice(0, 10);
  }

  createWeek() {
    if (!this.newWeekDate) return;
    const d = this.newWeekDate;
    // Format as local YYYY-MM-DD by hand — toISOString() converts to UTC,
    // which can land on the wrong calendar day depending on timezone.
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const copyFrom = this.copyPrevious ? this.selectedWeek()?.id : undefined;
    // subscribe({ next, error }): success and failure handled separately.
    this.api.createWeek(iso, copyFrom).subscribe({
      next: board => {
        this.newWeekOpen.set(false);
        this.newWeekDate = null;
        // Re-list weeks so the picker includes the new one, then select it.
        this.api.weeks().subscribe(ws => {
          this.weeks.set(ws);
          const created = ws.find(x => x.id === board.id) ?? ws[0];
          this.selectWeek(created);
        });
      },
      // The server's error JSON ({ error: "..." }) is written for humans —
      // e.g. the duplicate-week 409 — so show it as-is.
      error: err => alert(err?.error?.error ?? 'Could not create the week'),
    });
  }
}
