/**
 * app.config.ts — application-wide providers: the services every part of the
 * app can inject, configured once at bootstrap.
 *
 * "Providers" are Angular's dependency-injection registrations. Each
 * provide* call below switches on one capability:
 *   - provideRouter(routes)  → URL navigation (see app.routes.ts)
 *   - provideHttpClient()    → makes HttpClient injectable (used by ApiService)
 *   - provideAnimationsAsync → animation engine, lazy-loaded (PrimeNG needs it)
 *   - providePrimeNG         → the UI component library's theme
 */
import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeng/themes';
import Aura from '@primeng/themes/aura';

import { routes } from './app.routes';

// PrimeNG theming: start from the stock "Aura" preset and override its
// `primary` color ramp. A ramp runs light (50) to dark (950) around the main
// brand color at 500 — PrimeNG picks shades from it for hover/focus/active
// states on every button, select, dialog, etc. These values match the CSS
// design tokens in styles.scss, so PrimeNG widgets and hand-styled elements
// draw from the same palette.
const ShopFloorPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#edf6fa', 100: '#cfe4ed', 200: '#95c6da', 300: '#5aa7c6',
      400: '#1e88b3', 500: '#0078a9', 600: '#026a94', 700: '#044d6b',
      800: '#063042', 900: '#002e43', 950: '#081520',
    },
  },
});

export const appConfig: ApplicationConfig = {
  providers: [
    // Change detection = how Angular knows to re-render after events/HTTP.
    // eventCoalescing batches bursts of events into one render pass.
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(),
    provideAnimationsAsync(),
    providePrimeNG({
      // darkModeSelector: false — this app ships a single light look; the
      // theme won't flip when the OS switches to dark mode.
      theme: { preset: ShopFloorPreset, options: { darkModeSelector: false } },
    }),
  ],
};
