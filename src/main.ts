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
import { bootstrapRadiusAuthIngest } from './infrastructure/scheduling/bootstrapRadiusAuthIngest';
import { bootstrapPppoeAutoMove } from './infrastructure/scheduling/bootstrapPppoeAutoMove';
import { bootstrapRadiusAutoCure } from './infrastructure/scheduling/bootstrapRadiusAutoCure';
import { bootstrapChatMediaDownload } from './infrastructure/scheduling/bootstrapChatMediaDownload';
import { bootstrapAutoProvisionFiber } from './infrastructure/scheduling/bootstrapAutoProvisionFiber';
import { bootstrapSnoozeReactivation } from './infrastructure/scheduling/bootstrapSnoozeReactivation';
import { PrismaIClassClosureConfigRepository } from './infrastructure/adapters/prisma/PrismaIClassClosureConfigRepository';
import { PrismaRbacUserRepository } from './infrastructure/adapters/prisma/PrismaRbacUserRepository';
import { bootstrapSystemUsers } from './infrastructure/bootstrap/bootstrapSystemUsers';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

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

  // (a') System users — the "Api" reporter MUST exist before we serve requests:
  // the external ticket endpoint (external-create-ticket) stamps it as reporterId,
  // and GR-ingested tasks reference it too. Runs UNCONDITIONALLY and idempotent,
  // DECOUPLED from Gestión Real (deprecated) — it used to be seeded ONLY inside
  // bootstrapGestionRealIngest, behind GR's early-returns (GR off → no reporter).
  await bootstrapSystemUsers(new PrismaRbacUserRepository(), {
    passwordHash: bcrypt.hashSync(randomUUID(), 10),
  });

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
  // RADIUS auth ingest (radpostauth) — opt-in, fire-and-forget after listen.
  void bootstrapRadiusAuthIngest()
    .then((scheduler) => scheduler?.start())
    .catch((err) => console.error('[radius-auth-ingest] bootstrap failed (server kept alive):', (err as Error).message));
  // PPPoE auto-move watcher (pppoe-move-nas W2) — opt-in, dark by default (flag 'pppoe-auto-move').
  void bootstrapPppoeAutoMove()
    .then((scheduler) => scheduler?.start())
    .catch((err) => console.error('[pppoe-auto-move] bootstrap failed (server kept alive):', (err as Error).message));
  // RADIUS session auto-cure watcher (radius-session-autocure BE-1) — opt-in, dark by default
  // (flag 'radius-auto-cure').
  void bootstrapRadiusAutoCure()
    .then((scheduler) => scheduler?.start())
    .catch((err) => console.error('[radius-auto-cure] bootstrap failed (server kept alive):', (err as Error).message));
  // messaging-inbox-v2-media (F1.5 fase A, Tanda 1) — reintento de descarga de media
  // entrante — opt-in, dark by default (flag 'chat-media-download').
  void bootstrapChatMediaDownload()
    .then((scheduler) => scheduler?.start())
    .catch((err) => console.error('[chat-media-download] bootstrap failed (server kept alive):', (err as Error).message));
  // Watcher full-auto de fibra (K3 fiber-auto-watcher) — opt-in (envs SMARTOLT_*),
  // dark by default (flag 'fiber-auto-provision-watcher', separado del flag del wizard).
  void bootstrapAutoProvisionFiber()
    .then((scheduler) => scheduler?.start())
    .catch((err) => console.error('[fiber-auto-watcher] bootstrap failed (server kept alive):', (err as Error).message));
  // conversation-snooze (Ola 6c) — watcher que normaliza en DB las conversaciones snoozed
  // vencidas — dark by default (flag 'snooze-reactivation'). Las vistas/counts ya son correctos
  // sin él (derivación lazy); esto es sólo higiene de status + evento 'unsnoozed' limpio.
  void bootstrapSnoozeReactivation()
    .then((scheduler) => scheduler?.start())
    .catch((err) => console.error('[snooze-reactivation] bootstrap failed (server kept alive):', (err as Error).message));

  // Start schedulers — both start dormant (gated by feature flags).
  iclassClosure?.start();
  taskAutocomplete?.start();
  uispSync.start();
})().catch((err) => console.error('[server] fatal bootstrap error:', err));
