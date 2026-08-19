import { Routes } from '@angular/router';
import { BoardPage } from './pages/board/board.page';
import { SuggestionsPage } from './pages/suggestions/suggestions.page';
import { SettingsPage } from './pages/settings/settings.page';
import { ReportPage } from './pages/report/report.page';

export const routes: Routes = [
  { path: '', component: BoardPage },
  { path: 'suggestions', component: SuggestionsPage },
  { path: 'settings', component: SettingsPage },
  { path: 'report/:id', component: ReportPage },
  { path: '**', redirectTo: '' },
];
