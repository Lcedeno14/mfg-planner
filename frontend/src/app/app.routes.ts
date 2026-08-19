/**
 * app.routes.ts — the URL map for this single-page application (SPA).
 *
 * In an SPA, the browser loads one HTML page and JavaScript swaps views as
 * the URL changes — no full page reloads. Each entry pairs a URL path with
 * the component to render inside AppComponent's <router-outlet>.
 *
 * Note the parameter route 'report/:id' — ':id' is a placeholder, so
 * /report/3 renders ReportPage with id=3 readable via ActivatedRoute.
 * Order matters: routes match top-down, and the '**' wildcard at the end
 * catches every unknown URL and redirects home instead of showing a blank page.
 *
 * (Server-side detail: in production, Express serves index.html for any
 * non-/api URL precisely so these client-side routes survive a page refresh.)
 */
import { Routes } from '@angular/router';
import { BoardPage } from './pages/board/board.page';
import { SuggestionsPage } from './pages/suggestions/suggestions.page';
import { SettingsPage } from './pages/settings/settings.page';
import { ReportPage } from './pages/report/report.page';

export const routes: Routes = [
  { path: '', component: BoardPage },                 // the weekly board (home)
  { path: 'suggestions', component: SuggestionsPage },// suggested plan from active units
  { path: 'settings', component: SettingsPage },      // departments + op catalog setup
  { path: 'report/:id', component: ReportPage },      // printable report for week :id
  { path: '**', redirectTo: '' },                     // unknown URL → home
];
