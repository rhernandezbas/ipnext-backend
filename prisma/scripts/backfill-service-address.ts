/**
 * One-off backfill: populate Service.address / lat / lng from Gestión Real
 * for all Service rows that have a grContratoId but still have address = NULL.
 *
 * Strategy:
 *   - Paginates over Service WHERE grContratoId IS NOT NULL in BATCH_SIZE chunks.
 *   - Groups services by client.grClienteId → 1 GR API call per client.
 *   - Matches each contract by grContratoId and updates address/lat/lng.
 *   - Sleeps 100ms between client batches to avoid GR rate-limiting.
 *   - Idempotent: safe to re-run (only writes when address would change).
 *
 * Guard: refuses to run without CONFIRM=YES environment variable.
 *
 * Run:
 *   CONFIRM=YES DATABASE_URL=... GR_BASE_URL=... GR_CUIT=... GR_SECRET=... \
 *     npx ts-node -r tsconfig-paths/register prisma/scripts/backfill-service-address.ts
 *
 * Optional env:
 *   BATCH_SIZE   — clients per cycle (default 50)
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { GestionRealClient } from '../../src/infrastructure/adapters/gestion-real/GestionRealClient';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://ipnext:ipnext_secret@localhost:5432/ipnext';

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '50', 10);

const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const gr = new GestionRealClient({
  baseUrl: process.env.GR_BASE_URL ?? '',
  cuit: process.env.GR_CUIT ?? '',
  secret: process.env.GR_SECRET ?? '',
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // --- Pre-run counts ---
  const totalServices = await prisma.service.count({ where: { grContratoId: { not: null } } });
  const alreadyFilled = await prisma.service.count({
    where: { grContratoId: { not: null }, address: { not: null } },
  });
  const toProcess = totalServices - alreadyFilled;

  console.log('--- BEFORE ---');
  console.log(`  Services with grContratoId:             ${totalServices}`);
  console.log(`  Already have address (skip):            ${alreadyFilled}`);
  console.log(`  Pending (address IS NULL):              ${toProcess}`);

  if (process.env.CONFIRM !== 'YES') {
    console.log('\nDRY RUN — set CONFIRM=YES to actually update. Nothing was changed.');
    return;
  }

  if (!process.env.GR_BASE_URL || !process.env.GR_CUIT || !process.env.GR_SECRET) {
    console.error('ERROR: GR_BASE_URL, GR_CUIT and GR_SECRET must be set.');
    process.exit(1);
  }

  let updated = 0;
  let skipped = 0; // no address in GR either
  let errors = 0;
  let offset = 0;

  while (true) {
    // Page through services that still need backfill.
    const services = await prisma.service.findMany({
      where: { grContratoId: { not: null }, address: null },
      select: { id: true, grContratoId: true, client: { select: { grClienteId: true } } },
      orderBy: { id: 'asc' },
      skip: offset,
      take: BATCH_SIZE,
    });

    if (services.length === 0) break;

    // Group by grClienteId so we make 1 GR call per client.
    const byClient = new Map<string, typeof services>();
    for (const svc of services) {
      const grClienteId = svc.client?.grClienteId;
      if (!grClienteId) continue;
      if (!byClient.has(grClienteId)) byClient.set(grClienteId, []);
      byClient.get(grClienteId)!.push(svc);
    }

    for (const [grClienteId, clientServices] of byClient.entries()) {
      try {
        const contracts = await gr.fetchContractsByClient(grClienteId);
        const contractMap = new Map(contracts.map((c) => [c.grContratoId, c]));

        for (const svc of clientServices) {
          const contract = contractMap.get(svc.grContratoId!);
          if (!contract || contract.address === null) {
            skipped++;
            continue;
          }
          await prisma.service.update({
            where: { id: svc.id },
            data: {
              address: contract.address,
              lat: contract.lat ?? null,
              lng: contract.lng ?? null,
            },
          });
          updated++;
        }
      } catch (err) {
        console.error(`  ERROR fetching contracts for grClienteId=${grClienteId}:`, err);
        errors += clientServices.length;
      }

      await sleep(100);
    }

    console.log(`  Batch offset=${offset}: updated=${updated}, skipped=${skipped}, errors=${errors}`);
    offset += BATCH_SIZE;
  }

  // --- Post-run counts ---
  const afterFilled = await prisma.service.count({
    where: { grContratoId: { not: null }, address: { not: null } },
  });

  console.log('\n--- AFTER ---');
  console.log(`  Services with address:  ${afterFilled}`);
  console.log(`\nSummary: Updated ${updated} | Skipped (no GR address) ${skipped} | Errors ${errors}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
