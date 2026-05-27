/**
 * One-off resync of the Gestión Real client mirror.
 *
 * WHY: the GR client parser used to read `telefonos.Telefono` directly, but GR
 * keys `telefonos` by phone TYPE (Movil, "", numeric keys...), so ~5% of clients
 * lost their phone. The parser is fixed (firstPhone), but delta syncs only touch
 * clients that CHANGED, so the already-synced rows keep their wrong (empty) phone
 * until a full backfill re-upserts them with the fixed parser.
 *
 * WHAT THIS DOES:
 *   1. Resets the `gr-clients` SyncState cursor to null. With no cursor,
 *      SyncGestionRealClients.execute() runs in BACKFILL mode.
 *   2. Runs the use-case once. Backfill re-fetches ALL clients and re-upserts
 *      them through PrismaClientMirrorRepository.upsertClient, which writes
 *      `phone: c.phone ?? ''` — so every row gets the corrected phone.
 *
 * SAFE & IDEMPOTENT: only re-upserts clients (no deletes). Re-running it just
 * re-upserts again. It reuses the real use-case, no duplicated fetch logic.
 *
 * WHERE TO RUN: inside the deploy/container that has access to the prod DB —
 * the database is NOT reachable from outside. Requires GR_* env vars set.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register prisma/scripts/resync-gr-clients.ts
 */

import { config } from '@infrastructure/config';
import { GestionRealClient } from '@infrastructure/adapters/gestion-real/GestionRealClient';
import { PrismaClientMirrorRepository } from '@infrastructure/adapters/prisma/PrismaClientMirrorRepository';
import { PrismaSyncStateRepository } from '@infrastructure/adapters/prisma/PrismaSyncStateRepository';
import { SyncGestionRealClients } from '@application/use-cases/SyncGestionRealClients';

async function main(): Promise<void> {
  const gr = new GestionRealClient({
    baseUrl: config.gestionReal.baseUrl,
    cuit: config.gestionReal.cuit,
    secret: config.gestionReal.secret,
  });
  const mirror = new PrismaClientMirrorRepository();
  const state = new PrismaSyncStateRepository();

  // Force backfill: clearing the cursor makes execute() run in 'backfill' mode,
  // which re-fetches and re-upserts ALL clients with the fixed phone parser.
  const prior = await state.get('gr-clients');
  await state.save({
    entity: 'gr-clients',
    cursor: null,
    lastRunAt: new Date(),
    lastResult: 'resync: cursor reset for phone backfill',
    itemsSynced: prior?.itemsSynced ?? 0,
  });
  console.log('Cursor for gr-clients reset to null — next run will backfill.');

  const sync = new SyncGestionRealClients(gr, mirror, state, {
    estados: config.gestionReal.estados,
  });

  const result = await sync.execute();

  console.log('--- RESYNC DONE ---');
  console.log(`  mode:    ${result.mode}`);
  console.log(`  fetched: ${result.fetched}`);
  console.log(`  created: ${result.created}`);
  console.log(`  updated: ${result.updated}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
