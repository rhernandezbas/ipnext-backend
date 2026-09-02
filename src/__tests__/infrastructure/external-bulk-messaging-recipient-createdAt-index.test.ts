/**
 * external-bulk-messaging — fix wave F2 (NEW-2). `countAuthorizedRecipientsByCreatorSince`
 * (D3.a/D6, cupo diario) filtra `CampaignRecipient` por `createdAt >= since` +
 * `status notIn` + join `campaign.createdById` (`PrismaCampaignRepository.
 * countAuthorizedRecipientsByCreatorSince`) sin un índice que respalde el
 * `createdAt >= since` — full scan de la tabla en CADA `send` externo (SEND-4,
 * paso 7). `@@index([createdAt])` es aditivo y va en la MISMA migración de este
 * change (`20261112000000_external_bulk_messaging`, todavía no deployada en
 * ningún lado — no hay backfill que correr).
 *
 * Pin estático (molde `conversation-labels-migration.test.ts`): el índice tiene
 * que existir TANTO en `schema.prisma` COMO en el SQL de la migración — un
 * `prisma migrate dev` corrido sin el otro lado deja el schema y la DB
 * divergentes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Los pins sobre TEXTO tienen que ignorar comentarios: un `// @@index(...)`
 * o un `-- CREATE INDEX ...` comentado pasaria el match igual y el guard
 * mentiria (gotcha "tests sobre texto filtran comentarios").
 */
function stripLineComments(source: string, marker: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(marker))
    .join('\n');
}

describe('schema.prisma — CampaignRecipient.createdAt indexado (fix wave F2, NEW-2)', () => {
  let schema: string;

  beforeAll(() => {
    schema = stripLineComments(readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8'), '//');
  });

  it('CampaignRecipient declara @@index([createdAt])', () => {
    const modelMatch = schema.match(/model CampaignRecipient \{[\s\S]*?\n\}/);
    expect(modelMatch).not.toBeNull();
    expect(modelMatch![0]).toMatch(/@@index\(\[createdAt\]\)/);
  });
});

describe('Migración 20261112000000_external_bulk_messaging — CREATE INDEX de CampaignRecipient.createdAt (fix wave F2, NEW-2)', () => {
  let sql: string;

  beforeAll(() => {
    sql = stripLineComments(
      readFileSync(
        join(__dirname, '..', '..', '..', 'prisma', 'migrations', '20261112000000_external_bulk_messaging', 'migration.sql'),
        'utf8',
      ),
      '--',
    );
  });

  it('crea el índice CampaignRecipient_createdAt_idx sobre createdAt', () => {
    expect(sql).toMatch(/CREATE INDEX "CampaignRecipient_createdAt_idx" ON "CampaignRecipient"\("createdAt"\)/);
  });
});
