import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">LINE</span><span class="brand-mark alt">BOARD</span>
        <span class="brand-sub">Weekly production planner</span>
      </div>
      <nav>
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Weekly plan</a>
        <a routerLink="/suggestions" routerLinkActive="active">Suggested plan</a>
      </nav>
    </header>
    <main>
      <router-outlet />
    </main>
  `,
  styles: [`
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      background: #14293f; color: #fff; padding: 0.6rem 1.25rem;
      position: sticky; top: 0; z-index: 20;
    }
    .brand { display: flex; align-items: baseline; gap: 0.15rem; }
    .brand-mark { font-family: var(--display); font-weight: 700; font-size: 1.5rem; letter-spacing: 0.06em; }
    .brand-mark.alt { color: #f5b83d; }
    .brand-sub { margin-left: 0.75rem; color: #9fb2c5; font-size: 0.8rem; }
    nav { display: flex; gap: 0.25rem; }
    nav a {
      color: #c9d6e2; text-decoration: none; font-weight: 500;
      padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.9rem;
    }
    nav a:hover { background: rgba(255,255,255,0.08); color: #fff; }
    nav a.active { background: rgba(255,255,255,0.14); color: #fff; }
    main { padding: 1.25rem; max-width: 1500px; margin: 0 auto; }
    @media (max-width: 640px) {
      .brand-sub { display: none; }
      main { padding: 0.75rem; }
    }
  `],
})
export class AppComponent {}
