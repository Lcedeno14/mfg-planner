/**
 * scoreboard.component.ts — the Andon strip: one Week tile plus a tile per day,
 * each showing actual/goal and a percent, colored green/amber/red.
 *
 * ("Andon" is the lean-manufacturing term for a big visible status board —
 * glanceable from across the room, which drives the large numbers here.)
 *
 * This is a "presentational" (dumb) component: it owns no data and makes no
 * HTTP calls. The board page hands in numbers via inputs; this renders them.
 * That split keeps logic testable and lets the same strip appear anywhere.
 */
import { Component, computed, input } from '@angular/core';
import { DayScore } from '../../models';

// A local view-model: the pre-digested shape the template consumes.
// Not exported — no one outside this file needs it.
interface Tile {
  name: string;
  actual: number;
  goal: number;
  pct: number | null; // null = no goal set, shown as "—"
  cls: string;        // one of the .status-* utility classes from styles.scss
  today: boolean;
}

@Component({
  selector: 'app-scoreboard',
  standalone: true,
  template: `
    <!-- role/aria-label: screen readers announce this as a named group -->
    <div class="strip" role="group" aria-label="Weekly scoreboard">
      <!-- @for is Angular's built-in loop syntax; track tells it how to
           identify entries so it patches the DOM instead of rebuilding it -->
      @for (t of tiles(); track t.name) {
        <div class="tile" [class.overall]="t.name === 'Week'" [class.today]="t.today">
          <div class="tile-head">
            <span class="tile-name">{{ t.name }}</span>
            @if (t.today) { <span class="today-dot" title="Today"></span> }
          </div>
          <div class="tile-nums">
            <span class="actual">{{ t.actual }}</span>
            <span class="of">/</span>
            <span class="goal">{{ t.goal }}</span>
          </div>
          <!-- [class]="t.cls" binds the whole class string, picking the
               status color computed below -->
          <div class="tile-pct" [class]="t.cls">
            {{ t.pct === null ? '—' : t.pct + '%' }}
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    /* 7 columns: a wider Week tile + six equal day tiles. The 1px gap over a
       colored background is a cheap way to draw grid lines. */
    .strip {
      display: grid; grid-template-columns: 1.3fr repeat(6, 1fr);
      gap: 1px; background: var(--rule);
      border: 1px solid var(--rule); border-radius: 10px; overflow: hidden;
    }
    .tile { background: var(--panel); padding: 0.6rem 0.9rem; position: relative; }
    .tile.overall { background: var(--brand-darkest); color: #fff; }
    .tile.overall .tile-name { color: var(--brand-soft); }
    /* inset box-shadow = a top border that doesn't shift the layout */
    .tile.today { box-shadow: inset 0 3px 0 var(--accent); }
    .tile-head { display: flex; align-items: center; gap: 0.4rem; }
    .tile-name {
      font-family: var(--display); font-weight: 600; font-size: 0.95rem;
      text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-soft);
    }
    .today-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
    .tile-nums { font-family: var(--display); line-height: 1.05; margin-top: 0.15rem; }
    .actual { font-size: 2.2rem; font-weight: 700; }   /* the glanceable number */
    .of { font-size: 1.2rem; margin: 0 0.15rem; opacity: 0.45; }
    .goal { font-size: 1.4rem; font-weight: 500; opacity: 0.75; }
    .tile-pct {
      display: inline-block; margin-top: 0.3rem; padding: 0.1rem 0.5rem;
      border-radius: 4px; font-family: var(--display); font-weight: 600; font-size: 0.95rem;
    }
    /* Reflow to a wrapped grid on smaller screens instead of shrinking tiles */
    @media (max-width: 900px) {
      .strip { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 560px) {
      .strip { grid-template-columns: repeat(2, 1fr); }
    }
  `],
})
export class ScoreboardComponent {
  // input.required<T>() declares signal-based inputs: the parent binds them in
  // its template ([dayScore]="b.dayScore"). "required" = the compiler errors
  // if a parent forgets one. Read a signal by calling it: this.dayScore().
  dayScore = input.required<DayScore[]>();
  overall = input.required<{ goal: number; actual: number }>();
  isCurrentWeek = input(false); // optional input with a default

  // computed() derives a value from other signals and caches it; it re-runs
  // only when an input changes. This is Angular's reactive alternative to
  // recalculating in the template on every change-detection pass.
  tiles = computed<Tile[]>(() => {
    // Mark "today" only when actually viewing the current week; getDay()'s
    // 0=Sunday is remapped so 0=Monday matches the app's day indexing.
    const todayIdx = this.isCurrentWeek() ? (new Date().getDay() + 6) % 7 : -1;
    const mk = (name: string, actual: number, goal: number, today = false): Tile => {
      const pct = goal > 0 ? Math.round((actual / goal) * 100) : null;
      // Thresholds shared app-wide: >=100% good, >=70% warn, else bad.
      let cls = 'status-idle';
      if (pct !== null) cls = pct >= 100 ? 'status-good' : pct >= 70 ? 'status-warn' : 'status-bad';
      return { name, actual, goal, pct, cls, today };
    };
    const o = this.overall();
    return [
      mk('Week', o.actual, o.goal),
      ...this.dayScore().map(d => mk(d.name, d.actual, d.goal, d.day === todayIdx)),
    ];
  });
}
