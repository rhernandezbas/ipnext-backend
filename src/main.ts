import './infrastructure/config'; // fail-fast env validation runs on import
import { createApp } from './infrastructure/http/app';
import { config } from './infrastructure/config';
import { bootstrapGestionRealSync } from './infrastructure/scheduling/bootstrapGestionRealSync';
import { bootstrapGestionRealIngest } from './infrastructure/scheduling/bootstrapGestionRealIngest';
import { bootstrapIClassClosure } from './infrastructure/scheduling/bootstrapIClassClosure';
import { bootstrapTaskAutocomplete } from './infrastructure/scheduling/bootstrapTaskAutocomplete';
import { bootstrapBackfill } from './infrastructure/scheduling/bootstrapBackfill';
import { bootstrapUispSync } from './infrastructure/scheduling/bootstrapUispSync';
import { bootstrapRadiusAccountingIngest } from './infrastructure/scheduling/bootstrapRadiusAccountingIngest';
import { PrismaIClassClosureConfigRepository } from './infrastructure/adapters/prisma/PrismaIClassClosureConfigRepository';

// Safety net: a single unhandled rejection (e.g. an external integration like
// Splynx being unavailable inside an async route) must NOT take the whole
// process down. Log it and keep serving every other request.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception (kept alive):', err);
});

// Async IIFE: read config ONCE, await both bootstraps (they need to be awaited so
// taskAutocomplete is resolved before createApp), then start the server.
// module: CommonJS → no top-level await; IIFE is the idiomatic alternative.
void (async () => {
  const configRepo = new PrismaIClassClosureConfigRepository();
  const cfg = await configRepo.get(); // (a) read persisted intervals ONCE

  // (b) IClass closure loop — now async, receives interval from config
  const iclassClosure = await bootstrapIClassClosure(cfg.closureIntervalMs);

  // (c) Task auto-complete — awaited so la instancia está disponible para createApp
  const taskAutocomplete = await bootstrapTaskAutocomplete(cfg.autocompleteIntervalMs);

  // (d) BackfillScheduler on-demand — awaited antes de createApp (#32)
  const backfillScheduler = await bootstrapBackfill();

  // (f) UISP mirror sync — opt-in (absent env → scheduler skips each tick)
  const uispSync = await bootstrapUispSync(300_000);

  // (e) createApp wires both schedulers into the closure router — must run after await
  const app = createApp(taskAutocomplete, backfillScheduler, uispSync);

  app.listen(config.port, () => {
    console.log(`[server] Running on port ${config.port}`);
  });

  // Gestión Real read-only mirror sync — opt-in, fire-and-forget after listen.
  void bootstrapGestionRealSync()
    .then((grSync) => grSync?.start())
    .catch((err) => console.error('[gr-sync] bootstrap failed (server kept alive):', (err as Error).message));

  // Gestión Real installation-order ingest — opt-in, fire-and-forget after listen.
  void bootstrapGestionRealIngest()
    .then((grIngest) => grIngest?.start())
    .catch((err) => console.error('[gr-ingest] bootstrap failed (server kept alive):', (err as Error).message));
  // RADIUS accounting ingest — opt-in, fire-and-forget after listen.
  void bootstrapRadiusAccountingIngest()
    .then((scheduler) => scheduler?.start())
    .catch((err) => console.error('[radius-ingest] bootstrap failed (server kept alive):', (err as Error).message));

  // Start schedulers — both start dormant (gated by feature flags).
  iclassClosure?.start();
  taskAutocomplete?.start();
  uispSync.start();
})().catch((err) => console.error('[server] fatal bootstrap error:', err));
