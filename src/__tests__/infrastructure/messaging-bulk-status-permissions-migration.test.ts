/**
 * bulk-granular-perms — assertion estática (molde messaging-bulk-migration.test.ts)
 * sobre la migración 20261017000000: siembra las 6 permission granulares, otorga
 * backward-compat a todo rol con messaging.bulk, y agrega el snapshot en Campaign.
 * También pinea rbac.ts (KNOWN_ACTIONS declara las 6).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('rbac.ts — KNOWN_ACTIONS declara las 6 acciones granulares (bulk-granular-perms)', () => {
  let rbacSrc: string;

  beforeAll(() => {
    rbacSrc = readFileSync(join(__dirname, '..', '..', 'domain', 'entities', 'rbac.ts'), 'utf8');
  });

  it.each(['bulk_active', 'bulk_late', 'bulk_blocked', 'bulk_inactive', 'bulk_baja', 'bulk_numbers'])(
    "KNOWN_ACTIONS declara '%s'",
    (action) => {
      expect(rbacSrc).toMatch(new RegExp(`'${action}',`));
    },
  );
});

describe('Migración 20261017000000_messaging_bulk_status_permissions', () => {
  let sql: string;

  beforeAll(() => {
    sql = readFileSync(
      join(
        __dirname, '..', '..', '..', 'prisma', 'migrations',
        '20261017000000_messaging_bulk_status_permissions', 'migration.sql',
      ),
      'utf8',
    );
  });

  it('siembra las 6 permission granulares', () => {
    for (const action of ['bulk_active', 'bulk_late', 'bulk_blocked', 'bulk_inactive', 'bulk_baja', 'bulk_numbers']) {
      expect(sql).toContain(`'${action}'`);
    }
  });

  it('backward-compat: grant a partir de los roles que YA tienen messaging.bulk', () => {
    expect(sql).toMatch(/bulk_p\."action"\s*=\s*'bulk'/);
    expect(sql).toMatch(/INSERT INTO "RbacRolePermission"/);
  });

  it('agrega recipientStatuses (TEXT[]) y hasRawRecipients (BOOLEAN) a Campaign', () => {
    expect(sql).toMatch(/ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "recipientStatuses" TEXT\[\]/);
    expect(sql).toMatch(/ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "hasRawRecipients" BOOLEAN/);
  });

  it('TODOS los INSERT son idempotentes (ON CONFLICT DO NOTHING)', () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    const conflicts = sql.match(/ON CONFLICT[^;]*DO NOTHING/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(conflicts).toHaveLength(inserts.length);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});
