/**
 * report.page.ts — the printable weekly report at /report/:id.
 *
 * The trick to "print a web page well" is that this is just a normal page
 * with a second, print-only stylesheet: @media print rules (bottom of the
 * styles, plus globals in styles.scss) hide the buttons, strip the chrome,
 * zero the browser's page margins (which suppresses its title/URL
 * header/footer), and keep sections from splitting across sheets
 * (break-inside: avoid). window.print() opens the dialog; "Save as PDF"
 * comes free.
 *
 * It reuses the same GET /api/weeks/:id payload as the board — no dedicated
 * report endpoint, so board and report can never disagree.
 *
 * Also shown here: reading a route parameter (ActivatedRoute) and setting
 * the document title per page (Title service) — which becomes the printed
 * PDF's default filename.
 */
import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ApiService } from '../../api.service';
import { DayPlan, Department, WeekBoard } from '../../models';

@Component({
  selector: 'app-report-page',
  standalone: true,
  imports: [CommonModule, ButtonModule],
  template: `
    <div class="actions no-print">
      <p-button icon="pi pi-arrow-left" label="Back to board" text (onClick)="back()" />
      <p-button icon="pi pi-print" label="Print" (onClick)="print()" />
    </div>

    @if (board(); as b) {
      <div class="report">
        <header class="rep-head">
          <div>
            <h1>Weekly Production Report</h1>
            <div class="rep-meta">{{ b.label }} &middot; printed {{ now | date:'MMM d, y, h:mm a' }}</div>
          </div>
          <div class="rep-total">
            <span class="big">{{ b.overall.actual }}/{{ b.overall.goal }}</span>
            <span class="pct">{{ pct(b.overall.actual, b.overall.goal) }}</span>
          </div>
        </header>

        <!-- Scoreboard -->
        <table class="score-table">
          <thead>
            <tr>
              <th></th>
              @for (d of b.dayScore; track d.day) { <th>{{ d.name }}</th> }
              <th class="wk">Week</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Goal</th>
              @for (d of b.dayScore; track d.day) { <td>{{ d.goal }}</td> }
              <td class="wk">{{ b.overall.goal }}</td>
            </tr>
            <tr>
              <th>Actual</th>
              @for (d of b.dayScore; track d.day) { <td>{{ d.actual }}</td> }
              <td class="wk">{{ b.overall.actual }}</td>
            </tr>
            <tr>
              <th>%</th>
              @for (d of b.dayScore; track d.day) { <td>{{ pct(d.actual, d.goal) }}</td> }
              <td class="wk">{{ pct(b.overall.actual, b.overall.goal) }}</td>
            </tr>
          </tbody>
        </table>

        <!-- Departments -->
        @for (dept of b.departments; track dept.id) {
          <section class="dept">
            <h2>
              <span class="bar" [style.background]="dept.color"></span>
              {{ dept.name }}
              <span class="dept-score">{{ dept.weekActual }}/{{ dept.weekGoal }} &middot; {{ pct(dept.weekActual, dept.weekGoal) }}</span>
            </h2>

            @if (dept.deliverables.length) {
              <table class="del-table">
                <thead>
                  <tr><th class="op">Op</th><th>Operation</th><th class="num">Done/SNs</th><th>Serial numbers</th></tr>
                </thead>
                <tbody>
                  @for (d of dept.deliverables; track d.id) {
                    <tr>
                      <td class="op">{{ d.op_code }}</td>
                      <td>{{ d.op_name }}</td>
                      <td class="num">{{ doneCount(d.serials) }}/{{ d.serials.length }}</td>
                      <td class="sns">
                        @for (s of d.serials; track s.id; let last = $last) {
                          <span [class.done]="s.done">{{ s.sn }}@if (s.done) {&nbsp;&#10003;}</span>@if (!last) {, }
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            }

            <table class="day-table">
              <thead>
                <tr>
                  <th class="day">Day</th>
                  <th>{{ dept.second_shift ? '1st shift plan' : 'Plan' }}</th>
                  @if (showShift2(dept)) { <th>2nd shift plan</th> }
                  <th class="num">Goal</th>
                  <th class="num">Actual</th>
                  <th class="notes">Shift notes &amp; comments</th>
                </tr>
              </thead>
              <tbody>
                @for (day of dept.days; track day.day) {
                  <tr>
                    <td class="day">{{ day.name }}</td>
                    <td>{{ day.goal_note }}</td>
                    @if (showShift2(dept)) { <td>{{ day.shift2_plan }}</td> }
                    <td class="num">{{ day.goal }}</td>
                    <td class="num">{{ day.actual }}</td>
                    <td class="notes">
                      @if (day.shift1_note) { <div><b>1st shift:</b> {{ day.shift1_note }}</div> }
                      @if (day.shift2_note) { <div><b>2nd shift:</b> {{ day.shift2_note }}</div> }
                      @if (day.comment) { <div class="comment"><b>Comment:</b> {{ day.comment }}</div> }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      </div>
    } @else {
      <p class="empty">Loading report…</p>
    }
  `,
  styles: [`
    .actions { display: flex; justify-content: space-between; margin-bottom: 1rem; }
    .empty { color: var(--ink-soft); text-align: center; margin-top: 2rem; }

    .report { background: #fff; border: 1px solid var(--rule); border-radius: 10px; padding: 1.5rem 1.75rem; }
    .rep-head { display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 2px solid var(--brand-ink); padding-bottom: 0.6rem; }
    h1 { margin: 0; font-size: 1.6rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .rep-meta { color: var(--ink-soft); font-size: 0.85rem; margin-top: 0.15rem; }
    .rep-total { text-align: right; font-family: var(--display); }
    .rep-total .big { font-size: 1.9rem; font-weight: 700; display: block; line-height: 1; }
    .rep-total .pct { color: var(--ink-soft); font-weight: 600; }

    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { border: 1px solid var(--rule-strong); padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; }
    thead th { background: var(--brand-tint); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; }

    .score-table { margin-top: 1rem; }
    .score-table td { text-align: center; }
    .score-table tbody th { width: 4.5rem; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .score-table .wk { font-weight: 700; background: var(--paper); }

    .dept { margin-top: 1.4rem; }
    h2 {
      display: flex; align-items: center; gap: 0.5rem; margin: 0 0 0.5rem;
      font-size: 1.15rem; text-transform: uppercase; letter-spacing: 0.05em;
    }
    .bar { width: 9px; height: 20px; border-radius: 3px; flex: none; }
    .dept-score { margin-left: auto; font-size: 0.95rem; color: var(--ink-soft); font-weight: 600; }

    .del-table { margin-bottom: 0.5rem; }
    .del-table .op { width: 5rem; white-space: nowrap; font-weight: 600; }
    .num { width: 4.2rem; text-align: center !important; white-space: nowrap; }
    .sns .done { color: var(--ok); font-weight: 600; }

    .day-table .day { width: 5.5rem; font-weight: 600; }
    .day-table .notes { width: 32%; }
    .notes div + div { margin-top: 0.15rem; }
    .notes .comment { color: #7a4a04; }

    @media print {
      .no-print { display: none !important; }
      /* Page margins come from here, not @page — side padding repeats on every
         sheet, and the per-section padding keeps a section that lands at the
         top of a continuation page off the paper edge. */
      .report { border: none; border-radius: 0; padding: 0 0.5in 0.5in; }
      .rep-head { padding-top: 0.5in; }
      .dept { break-inside: avoid; margin-top: 0; padding-top: 0.3in; }
      thead th { background: var(--brand-tint) !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .bar, .score-table .wk { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  `],
})
export class ReportPage implements OnInit, OnDestroy {
  board = signal<WeekBoard | null>(null);
  now = new Date();

  private static readonly APP_TITLE = 'Lineboard — Weekly Production Planner';

  constructor(
    private api: ApiService,
    private route: ActivatedRoute,
    private router: Router,
    private title: Title,
  ) {}

  ngOnInit() {
    // snapshot.paramMap reads the ':id' from /report/:id once, at load —
    // fine here because navigating to another report remounts the component.
    const id = Number(this.route.snapshot.paramMap.get('id'));
    this.api.week(id).subscribe(b => {
      this.board.set(b);
      // Browsers print the document title as the page header and use it as the
      // default "Save as PDF" filename.
      this.title.setTitle(`Weekly Production Report — ${b.label}`);
    });
  }

  // Lifecycle pair to ngOnInit: runs when the user navigates away.
  // Restores the app-wide title so other tabs/pages aren't mislabeled.
  ngOnDestroy() {
    this.title.setTitle(ReportPage.APP_TITLE);
  }

  pct(actual: number, goal: number): string {
    return goal > 0 ? Math.round((actual / goal) * 100) + '%' : '—';
  }

  doneCount(serials: { done: number }[]): number {
    return serials.filter(s => s.done).length;
  }

  /** Show the 2nd-shift column when the department runs one, or has legacy 2nd-shift plans recorded. */
  showShift2(dept: Department): boolean {
    return !!dept.second_shift || dept.days.some((d: DayPlan) => !!d.shift2_plan);
  }

  print() { window.print(); }
  back() { this.router.navigate(['/']); }
}
