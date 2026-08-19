/**
 * app.component.ts — the root shell: top bar, navigation, and the outlet
 * where the router swaps pages in and out.
 *
 * ── Angular: anatomy of a component ─────────────────────────────────────────
 * A component = a TypeScript class + an HTML template + (scoped) styles,
 * tied together by the @Component decorator. `standalone: true` means it
 * declares its own dependencies in `imports` instead of relying on an
 * NgModule — RouterOutlet and RouterLink are imported here because the
 * template uses them.
 *
 * Template and styles are written inline (template:/styles:) rather than in
 * separate files — a stylistic choice this codebase uses for small components;
 * DepartmentCardComponent shows the separate-file variant.
 *
 * ── Styling: view encapsulation ─────────────────────────────────────────────
 * Styles declared on a component are scoped to it: Angular rewrites selectors
 * at build time so `.topbar` here can never leak into another component.
 * Global rules and design tokens live in styles.scss instead.
 */
import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root', // matches the <app-root> tag in index.html
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">LINE</span><span class="brand-mark alt">BOARD</span>
        <span class="brand-sub">Weekly production planner</span>
      </div>
      <nav>
        <!-- routerLink navigates without a page reload; routerLinkActive adds
             the 'active' class when the URL matches. The home link needs
             exact matching or it would stay lit on every route ('' is a
             prefix of everything). -->
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Weekly plan</a>
        <a routerLink="/suggestions" routerLinkActive="active">Suggested plan</a>
        <a routerLink="/settings" routerLinkActive="active">Setup</a>
      </nav>
    </header>
    <main>
      <!-- The router renders the current page component here (see app.routes.ts) -->
      <router-outlet />
    </main>
  `,
  styles: [`
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      background: var(--brand-ink); color: #fff; padding: 0.6rem 1.25rem;
      position: sticky; top: 0; z-index: 20; /* stays pinned while the board scrolls */
    }
    .brand { display: flex; align-items: baseline; gap: 0.15rem; }
    .brand-mark { font-family: var(--display); font-weight: 700; font-size: 1.5rem; letter-spacing: 0.06em; }
    .brand-mark.alt { color: var(--accent); }
    .brand-sub { margin-left: 0.75rem; color: var(--brand-soft); font-size: 0.8rem; }
    nav { display: flex; gap: 0.25rem; }
    nav a {
      color: var(--brand-tint); text-decoration: none; font-weight: 500;
      padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.9rem;
    }
    nav a:hover { background: rgba(255,255,255,0.08); color: #fff; }
    nav a.active { background: rgba(255,255,255,0.14); color: #fff; }
    main { padding: 1.25rem; max-width: 1500px; margin: 0 auto; }
    @media (max-width: 640px) {
      .brand-sub { display: none; } /* drop the tagline on phones */
      main { padding: 0.75rem; }
    }
  `],
})
export class AppComponent {} // all behavior lives in the template; no class logic needed
