/**
 * internet-history-plan-direction — one-shot, IDEMPOTENT backfill of oldPlan/newPlan on
 * historical 'modified' contract_service_events.
 *
 * Migration 20260828000000 added nullable `oldPlan` / `newPlan` columns. Legacy 'modified'
 * events only recorded the plan pair inside `notes` as "OLD → NEW" (with '—' meaning null).
 * This script parses `notes` and fills the new columns so the history page can derive the
 * upgrade/downgrade direction for OLD events too.
 *
 * SAFE + RE-RUNNABLE:
 *   - Only touches eventType='modified' rows that were NOT yet backfilled (newPlan IS NULL).
 *   - Never writes into non-'modified' events (activated/deactivated/... have no plan pair).
 *   - Only fills columns; never deletes or rewrites `notes` (kept for back-compat).
 *   - Re-running is a no-op once every parseable row has newPlan set.
 *
 * Parsing: `notes` = "<old> → <new>" (separator is " → ", U+2192). "—" maps to null. A row whose
 * notes don't split into exactly two parts is left untouched and reported as skipped/malformed.
 *
 * Run (DRY-RUN by default — prints what it WOULD do, writes nothing):
 *   DATABASE_URL=... npx ts-node scripts/backfill-contract-service-event-plans.ts
 * Apply for real:
 *   CONFIRM=YES DATABASE_URL=... npx ts-node scripts/backfill-contract-service-event-plans.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://ipnext:ipnext_secret@localhost:5432/ipnext';
const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const SEPARATOR = ' → '; // " → "

/** Parse a legacy `notes` string ("OLD → NEW"). Returns null if it isn't a plan pair. */
function parseNotes(notes: string | null): { oldPlan: string | null; newPlan: string | null } | null {
  if (!notes) return null;
  const parts = notes.split(SEPARATOR);
  if (parts.length !== 2) return null;
  const norm = (s: string): string | null => {
    const t = s.trim();
    return t === '' || t === '—' ? null : t; // '—' (U+2014) → null
  };
  const oldPlan = norm(parts[0]!);
  const newPlan = norm(parts[1]!);
  // A real plan change always has a destination plan. If we can't recover it, treat as malformed.
  if (newPlan === null) return null;
  return { oldPlan, newPlan };
}

async function main(): Promise<void> {
  const apply = process.env.CONFIRM === 'YES';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: Array<{ id: string; notes: string | null }> = await (prisma as any).contractServiceEvent.findMany({
    where: { eventType: 'modified', newPlan: null },
    select: { id: true, notes: true },
  });

  console.log(`--- backfill oldPlan/newPlan (${apply ? 'APPLY' : 'DRY-RUN'}) ---`);
  console.log(`  candidate 'modified' rows (newPlan IS NULL): ${rows.length}`);

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const parsed = parseNotes(row.notes);
    if (!parsed) {
      skipped++;
      console.warn(`  SKIP ${row.id} — notes not parseable as "old → new": ${JSON.stringify(row.notes)}`);
      continue;
    }
    if (apply) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).contractServiceEvent.update({
        where: { id: row.id },
        data: { oldPlan: parsed.oldPlan, newPlan: parsed.newPlan },
      });
    }
    updated++;
  }

  console.log('--- summary ---');
  console.log(`  ${apply ? 'updated' : 'would update'}: ${updated}`);
  console.log(`  skipped (malformed notes): ${skipped}`);
  if (!apply) console.log('\nDRY RUN — set CONFIRM=YES to write. Nothing was changed.');
}

main()
  .catch((err) => {
    console.error('backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
