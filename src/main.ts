import './infrastructure/config'; // fail-fast env validation runs on import
import { createApp } from './infrastructure/http/app';
import { config } from './infrastructure/config';
import { bootstrapGestionRealSync } from './infrastructure/scheduling/bootstrapGestionRealSync';
import { bootstrapGestionRealIngest } from './infrastructure/scheduling/bootstrapGestionRealIngest';
import { bootstrapIClassClosure } from './infrastructure/scheduling/bootstrapIClassClosure';
import { bootstrapTaskAutocomplete } from './infrastructure/scheduling/bootstrapTaskAutocomplete';

// Safety net: a single unhandled rejection (e.g. an external integration like
// Splynx being unavailable inside an async route) must NOT take the whole
// process down. Log it and keep serving every other request.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception (kept alive):', err);
});

const app = createApp();

app.listen(config.port, () => {
  console.log(`[server] Running on port ${config.port}`);
});

// Gestión Real read-only mirror sync — opt-in, no-op when disabled.
// Async because the composition root reads the persisted interval/estados config.
void bootstrapGestionRealSync()
  .then((grSync) => grSync?.start())
  .catch((err) => console.error('[gr-sync] bootstrap failed (server kept alive):', (err as Error).message));

// Gestión Real installation-order ingest — opt-in, no-op when disabled.
// Async because the composition root resolves the fallback "Pendiente" stage.
void bootstrapGestionRealIngest()
  .then((grIngest) => grIngest?.start())
  .catch((err) => console.error('[gr-ingest] bootstrap failed (server kept alive):', (err as Error).message));

// IClass closure loop — starts dormant; gated by the `iclass-closure-loop`
// feature flag (default OFF). Returns null only when IClass credentials are missing.
const iclassClosure = bootstrapIClassClosure();
iclassClosure?.start();

// Task auto-complete (#14) — starts dormant; gated by the `task-autocomplete`
// feature flag (default OFF). Re-fires pending closure side-effects per task.
const taskAutocomplete = bootstrapTaskAutocomplete();
taskAutocomplete?.start();
