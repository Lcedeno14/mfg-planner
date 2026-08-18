import { Routes } from '@angular/router';
import { BoardPage } from './pages/board/board.page';
import { SuggestionsPage } from './pages/suggestions/suggestions.page';

export const routes: Routes = [
  { path: '', component: BoardPage },
  { path: 'suggestions', component: SuggestionsPage },
  { path: '**', redirectTo: '' },
];
