import { config } from '../config';
import { GestionRealClient } from '../adapters/gestion-real/GestionRealClient';
import { PrismaClientMirrorRepository } from '../adapters/prisma/PrismaClientMirrorRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { SyncGestionRealClients } from '@application/use-cases/SyncGestionRealClients';
import { SyncGestionRealContracts } from '@application/use-cases/SyncGestionRealContracts';
import { GestionRealSyncScheduler } from './GestionRealSyncScheduler';

/**
 * Composition root for the GR mirror sync. Returns a ready-to-start scheduler,
 * or null when the feature is off or misconfigured — callers just no-op on null,
 * so flipping GR_SYNC_ENABLED=false leaves the server behaving exactly as before.
 */
export function bootstrapGestionRealSync(): GestionRealSyncScheduler | null {
  const gr = config.gestionReal;

  if (!gr.enabled) {
    console.log('[gr-sync] disabled (GR_SYNC_ENABLED != true)');
    return null;
  }
  if (!gr.cuit || !gr.secret) {
    console.warn('[gr-sync] enabled but GR_CUIT/GR_SECRET missing — not starting');
    return null;
  }

  const client = new GestionRealClient({ baseUrl: gr.baseUrl, cuit: gr.cuit, secret: gr.secret });
  const mirror = new PrismaClientMirrorRepository();
  const state = new PrismaSyncStateRepository();
  const syncClients = new SyncGestionRealClients(client, mirror, state);
  const syncContracts = new SyncGestionRealContracts(client, mirror);

  return new GestionRealSyncScheduler(syncClients, syncContracts, { intervalMs: gr.intervalMs });
}
