/**
 * One-off, GUARDED wipe of all Client rows (and, by FK cascade, their Service /
 * Invoice / ClientLog; ScheduledTask.customerId is set null).
 *
 * Use to "start from zero" before the Gestión Real backfill repopulates clients.
 * THIS IS DESTRUCTIVE AND IRREVERSIBLE. It refuses to run unless CONFIRM=YES.
 *
 * Run (against prod, inside the server's docker network):
 *   CONFIRM=YES DATABASE_URL=... npx ts-node scripts/wipe-clients.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://ipnext:ipnext_secret@localhost:5432/ipnext';
const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const [clients, services, invoices] = await Promise.all([
    prisma.client.count(),
    prisma.service.count(),
    prisma.invoice.count(),
  ]);

  console.log('--- BEFORE ---');
  console.log(`  clients:  ${clients}`);
  console.log(`  services: ${services} (cascade-deleted)`);
  console.log(`  invoices: ${invoices} (cascade-deleted)`);

  if (process.env.CONFIRM !== 'YES') {
    console.log('\nDRY RUN — set CONFIRM=YES to actually delete. Nothing was changed.');
    return;
  }

  console.log('\nDeleting all clients (cascade)...');
  const deleted = await prisma.client.deleteMany({});
  console.log(`Deleted ${deleted.count} clients.`);

  const [c2, s2, i2] = await Promise.all([
    prisma.client.count(),
    prisma.service.count(),
    prisma.invoice.count(),
  ]);
  console.log('--- AFTER ---');
  console.log(`  clients:  ${c2}`);
  console.log(`  services: ${s2}`);
  console.log(`  invoices: ${i2}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());
