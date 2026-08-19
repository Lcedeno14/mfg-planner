/**
 * main.ts — the application's entry point.
 *
 * When the browser loads index.html, the built JS bundle starts executing
 * here. bootstrapApplication mounts AppComponent onto the <app-root> tag in
 * index.html, wiring in the app-wide providers from appConfig (router, HTTP
 * client, UI theme).
 *
 * This is the modern "standalone" Angular bootstrap: components declare their
 * own imports, so there is no NgModule layer — what older Angular apps did
 * with AppModule/platformBrowserDynamic happens in this one call.
 */
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err)); // a bootstrap failure would otherwise be silent
