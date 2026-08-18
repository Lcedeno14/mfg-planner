import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { providePrimeNG } from 'primeng/config';
import { definePreset } from '@primeng/themes';
import Aura from '@primeng/themes/aura';

import { routes } from './app.routes';

const ShopFloorPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#eef4fb', 100: '#d8e4f4', 200: '#b0c9e8', 300: '#84aada',
      400: '#5a8ccb', 500: '#33689f', 600: '#2b5787', 700: '#23476e',
      800: '#1b3755', 900: '#14293f', 950: '#0d1b2a',
    },
  },
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(),
    provideAnimationsAsync(),
    providePrimeNG({
      theme: { preset: ShopFloorPreset, options: { darkModeSelector: false } },
    }),
  ],
};
