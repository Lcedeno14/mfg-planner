import { Component, computed, input } from '@angular/core';
import { DayScore } from '../../models';

interface Tile {
  name: string;
  actual: number;
  goal: number;
  pct: number | null;
  cls: string;
  today: boolean;
}

@Component({
  selector: 'app-scoreboard',
  standalone: true,
  template: `
    <div class="strip" role="group" aria-label="Weekly scoreboard">
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
          <div class="tile-pct" [class]="t.cls">
            {{ t.pct === null ? '—' : t.pct + '%' }}
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .strip {
      display: grid; grid-template-columns: 1.3fr repeat(5, 1fr);
      gap: 1px; background: var(--rule);
      border: 1px solid var(--rule); border-radius: 10px; overflow: hidden;
    }
    .tile { background: var(--panel); padding: 0.6rem 0.9rem; position: relative; }
    .tile.overall { background: #1c2734; color: #fff; }
    .tile.overall .tile-name { color: #9fb2c5; }
    .tile.today { box-shadow: inset 0 3px 0 #f5b83d; }
    .tile-head { display: flex; align-items: center; gap: 0.4rem; }
    .tile-name {
      font-family: var(--display); font-weight: 600; font-size: 0.95rem;
      text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-soft);
    }
    .today-dot { width: 7px; height: 7px; border-radius: 50%; background: #f5b83d; }
    .tile-nums { font-family: var(--display); line-height: 1.05; margin-top: 0.15rem; }
    .actual { font-size: 2.2rem; font-weight: 700; }
    .of { font-size: 1.2rem; margin: 0 0.15rem; opacity: 0.45; }
    .goal { font-size: 1.4rem; font-weight: 500; opacity: 0.75; }
    .tile-pct {
      display: inline-block; margin-top: 0.3rem; padding: 0.1rem 0.5rem;
      border-radius: 4px; font-family: var(--display); font-weight: 600; font-size: 0.95rem;
    }
    @media (max-width: 900px) {
      .strip { grid-template-columns: repeat(3, 1fr); }
    }
    @media (max-width: 560px) {
      .strip { grid-template-columns: repeat(2, 1fr); }
    }
  `],
})
export class ScoreboardComponent {
  dayScore = input.required<DayScore[]>();
  overall = input.required<{ goal: number; actual: number }>();
  isCurrentWeek = input(false);

  tiles = computed<Tile[]>(() => {
    const todayIdx = this.isCurrentWeek() ? (new Date().getDay() + 6) % 7 : -1;
    const mk = (name: string, actual: number, goal: number, today = false): Tile => {
      const pct = goal > 0 ? Math.round((actual / goal) * 100) : null;
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
