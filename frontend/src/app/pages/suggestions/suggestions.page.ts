import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { ApiService } from '../../api.service';
import { Suggestion, SuggestionResponse, Week } from '../../models';

@Component({
  selector: 'app-suggestions-page',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, SelectModule, TooltipModule],
  template: `
    <div class="head">
      <div>
        <h1>Suggested plan</h1>
        <p class="sub">
          Built from the active-unit snapshot in the transaction database.
          The data runs about 80% accurate — units with no recent transactions are flagged
          <span class="verify-tag">verify</span> so you can confirm with the floor before committing.
        </p>
      </div>
      <div class="apply-to">
        <label>Apply to week</label>
        <p-select [options]="weeks()" [(ngModel)]="targetWeek" optionLabel="label" placeholder="Pick a week" />
      </div>
    </div>

    @if (data(); as d) {
      <div class="sugg-grid">
        @for (s of d.suggestions; track s.op_code) {
          <div class="sugg-card" [style.--dept-color]="s.color">
            <div class="sugg-head">
              <span class="op-code">{{ s.op_code }}</span>
              <span class="op-name">{{ s.op_name }}</span>
              <span class="dept-name">{{ s.department_name }}</span>
            </div>
            <div class="sugg-meta">
              <span><strong>{{ s.queued.length }}</strong> queued</span>
              <span>Suggested goal <strong>{{ s.suggested_goal }}</strong></span>
              <span>≈ <strong>{{ s.est_hours }}</strong> labor hrs</span>
            </div>
            <div class="sn-row">
              @for (u of s.queued; track u.sn) {
                <span class="sn-chip" [class.stale]="s.verify.includes(u.sn)"
                      [pTooltip]="'Last transaction ' + u.last_txn + (s.verify.includes(u.sn) ? ' — verify with the floor' : '')"
                      tooltipPosition="top">
                  {{ u.sn }}
                  @if (s.verify.includes(u.sn)) { <i class="pi pi-question-circle"></i> }
                </span>
              }
            </div>
            <div class="sugg-actions">
              <p-button [label]="applied().has(s.op_code) ? 'Added to plan' : 'Add to weekly plan'"
                        size="small" [outlined]="!applied().has(s.op_code)"
                        [disabled]="!targetWeek || applied().has(s.op_code)"
                        [icon]="applied().has(s.op_code) ? 'pi pi-check' : 'pi pi-plus'"
                        (onClick)="apply(s)" />
            </div>
          </div>
        }
      </div>
    } @else {
      <p class="empty">Loading the active-unit snapshot…</p>
    }
  `,
  styles: [`
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
    h1 { margin: 0 0 0.2rem; font-size: 1.6rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .sub { color: var(--ink-soft); max-width: 46rem; margin: 0 0 1rem; font-size: 0.88rem; }
    .verify-tag {
      background: var(--warn-soft); color: var(--warn); border-radius: 4px;
      padding: 0 0.3rem; font-weight: 600; font-size: 0.8rem;
    }
    .apply-to { display: flex; flex-direction: column; gap: 0.25rem; }
    .apply-to label { font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--ink-soft); }
    .sugg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 1rem; }
    @media (max-width: 440px) { .sugg-grid { grid-template-columns: 1fr; } }
    .sugg-card {
      background: var(--panel); border: 1px solid var(--rule); border-radius: 10px;
      padding: 0.8rem 0.9rem; border-top: 3px solid var(--dept-color);
    }
    .sugg-head { display: flex; align-items: center; gap: 0.5rem; }
    .op-code { font-family: var(--display); font-weight: 700; background: var(--dept-color);
      color: #fff; padding: 0.05rem 0.45rem; border-radius: 4px; }
    .op-name { font-weight: 600; flex: 1; }
    .dept-name { font-size: 0.75rem; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.06em; }
    .sugg-meta { display: flex; gap: 1rem; color: var(--ink-soft); font-size: 0.82rem; margin: 0.5rem 0; }
    .sugg-meta strong { color: var(--ink); }
    .sn-row { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.7rem; }
    .sn-chip { display: inline-flex; align-items: center; gap: 0.3rem; border: 1px solid var(--rule);
      border-radius: 999px; padding: 0.18rem 0.6rem; font-size: 0.82rem; background: #fff; }
    .sn-chip.stale { border-color: var(--warn); background: var(--warn-soft); color: var(--warn); }
    .sn-chip .pi { font-size: 0.75rem; }
    .empty { color: var(--ink-soft); text-align: center; margin-top: 2rem; }
  `],
})
export class SuggestionsPage implements OnInit {
  data = signal<SuggestionResponse | null>(null);
  weeks = signal<Week[]>([]);
  targetWeek: Week | null = null;
  applied = signal(new Set<string>());

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.api.suggestions().subscribe(d => this.data.set(d));
    this.api.weeks().subscribe(ws => {
      this.weeks.set(ws);
      this.targetWeek = ws[0] ?? null;
    });
  }

  apply(s: Suggestion) {
    if (!this.targetWeek) return;
    this.api.applySuggestion({
      week_id: this.targetWeek.id,
      department_id: s.department_id,
      op_code: s.op_code,
      op_name: s.op_name,
      goal: s.suggested_goal,
      sns: s.queued.map(u => u.sn),
    }).subscribe(() => {
      const next = new Set(this.applied());
      next.add(s.op_code);
      this.applied.set(next);
    });
  }
}
