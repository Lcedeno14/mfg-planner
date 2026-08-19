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
      50: '#edf6fa', 100: '#cfe4ed', 200: '#95c6da', 300: '#5aa7c6',
      400: '#1e88b3', 500: '#0078a9', 600: '#026a94', 700: '#044d6b',
      800: '#063042', 900: '#002e43', 950: '#081520',
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
