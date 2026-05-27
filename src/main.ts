import './infrastructure/config'; // fail-fast env validation runs on import
import { createApp } from './infrastructure/http/app';
import { config } from './infrastructure/config';
import { bootstrapGestionRealSync } from './infrastructure/scheduling/bootstrapGestionRealSync';

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
const grSync = bootstrapGestionRealSync();
grSync?.start();
