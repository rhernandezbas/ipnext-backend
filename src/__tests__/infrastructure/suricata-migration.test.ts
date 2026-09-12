/**
 * suricata-migration.test.ts — assertion estática sobre el SQL REAL de las
 * migraciones del change `suricata-tickets-mirror`. Molde exacto:
 * `messaging-migration.test.ts` (mismo patrón que `store`, `inbox-views`,
 * `messaging-bulk`, etc.).
 *
 * Por qué existe: el seed de estas migraciones (módulo RBAC + permisos +
 * grants + feature flags) es DML apendado a mano al diff de Prisma, y el
 * contenedor corre `prisma migrate deploy` en cada arranque. Un INSERT sin
 * `ON CONFLICT ... DO NOTHING` que se re-ejecute revienta la migración, y con
 * el `&&` del CMD el server NO arranca. Nadie estaba testeando eso.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'prisma', 'migrations');

/**
 * Lee el SQL con los comentarios `--` REMOVIDOS. Sin esto, el bloque de
 * cabecera ("Todo el seed es ON CONFLICT DO NOTHING...") cuenta como un
 * `ON CONFLICT DO NOTHING` más y el conteo da un falso verde: la prosa
 * afirmando la protección satisfacía al test en lugar del SQL que la aplica.
 */
function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('Migración 20261116000000_suricata_tickets_mirror_base (Fase A, D1/D2/D14)', () => {
  let sql: string;

  beforeAll(() => {
    sql = readMigration('20261116000000_suricata_tickets_mirror_base');
  });

  it('crea las 7 tablas del espejo', () => {
    expect(sql).toMatch(/CREATE TABLE "SuricataArea"/);
    expect(sql).toMatch(/CREATE TABLE "SuricataTicket"/);
    expect(sql).toMatch(/CREATE TABLE "SuricataMessage"/);
    expect(sql).toMatch(/CREATE TABLE "SuricataAttachment"/);
    expect(sql).toMatch(/CREATE TABLE "SuricataTicketVerdict"/);
    expect(sql).toMatch(/CREATE TABLE "SuricataReplyAudit"/);
    expect(sql).toMatch(/CREATE TABLE "SuricataSyncRun"/);
  });

  it('los externalId del espejo son UNIQUE (idempotencia del upsert por id externo)', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "SuricataArea_externalId_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "SuricataTicket_externalId_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "SuricataMessage_externalId_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "SuricataAttachment_ticketId_externalRef_key"/);
  });

  describe('CRÍTICO — seed idempotente (el contenedor corre migrate deploy en cada arranque)', () => {
    it('TODOS los INSERT llevan ON CONFLICT ... DO NOTHING: ninguno queda suelto', () => {
      const inserts = sql.match(/INSERT INTO/g) ?? [];
      const conflicts = sql.match(/ON CONFLICT[^;]*DO NOTHING/g) ?? [];

      // 9 = 1 módulo + 3 permisos (read/manage/reply) + 3 grants + 2 feature flags.
      expect(inserts).toHaveLength(9);
      expect(conflicts).toHaveLength(inserts.length);
    });

    it('cada sentencia INSERT individual contiene su propio ON CONFLICT DO NOTHING', () => {
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.includes('INSERT INTO'));

      expect(statements.length).toBeGreaterThan(0);
      const sinGuard = statements.filter((s) => !/ON CONFLICT[\s\S]*DO NOTHING/.test(s));
      expect(sinGuard).toEqual([]);
    });

    it('el módulo RBAC resuelve conflicto por "code" (la unique real, no un DO NOTHING ciego)', () => {
      expect(sql).toMatch(/INSERT INTO "RbacModule"[\s\S]*?ON CONFLICT \("code"\) DO NOTHING/);
    });

    it('los permisos resuelven conflicto por ("moduleId", "action")', () => {
      const permisos = sql.match(/INSERT INTO "RbacPermission"[\s\S]*?DO NOTHING/g) ?? [];
      expect(permisos).toHaveLength(3);
      for (const p of permisos) {
        expect(p).toMatch(/ON CONFLICT \("moduleId", "action"\) DO NOTHING/);
      }
    });

    it('los grants resuelven conflicto por ("roleId", "permissionId")', () => {
      const grants = sql.match(/INSERT INTO "RbacRolePermission"[\s\S]*?DO NOTHING/g) ?? [];
      expect(grants).toHaveLength(3);
      for (const g of grants) {
        expect(g).toMatch(/ON CONFLICT \("roleId", "permissionId"\) DO NOTHING/);
      }
    });

    it('los 2 feature flags del rollout dark nacen en FALSE y son idempotentes', () => {
      expect(sql).toMatch(/INSERT INTO "FeatureFlag"[\s\S]*?'suricata-sync-enabled', false[\s\S]*?ON CONFLICT DO NOTHING/);
      expect(sql).toMatch(/INSERT INTO "FeatureFlag"[\s\S]*?'suricata-reply-enabled', false[\s\S]*?ON CONFLICT DO NOTHING/);
    });

    it('ningún INSERT usa ON CONFLICT DO UPDATE (pisaría una decisión ya tomada en prod)', () => {
      expect(sql).not.toMatch(/ON CONFLICT[^;]*DO UPDATE/);
    });
  });

  /**
   * Decisión de producto confirmada por el usuario (fix wave): un ticket de
   * Suricata contiene nombre, teléfono y audios de clientes reales. Eso lo ve
   * quien ATIENDE tickets, no cualquier rol del sistema. El seed original
   * calcaba el bloque de `store`, que abre `read` a los 6 roles.
   *
   * De los 6 roles de sistema (SYSTEM_ROLES, rbac.ts — no existe ningún
   * 'soporte'/'agente'/'atencion_cliente'), el rol de atención es `noc`: el
   * operador de mesa, explícitamente NO técnico de campo (ver
   * `TECHNICAL_ROLE_CODES`, donde solo figura 'tecnico'). `administracion` es
   * Contabilidad según el seed de roles.
   */
  describe('alcance de los grants — datos de clientes reales, no para todo el sistema', () => {
    /**
     * Devuelve la sentencia COMPLETA y AISLADA del grant de esa acción. El
     * split por `;` es obligatorio: un regex sobre el archivo entero se come
     * el grant anterior y reporta roles que no son de esta sentencia.
     */
    function grantFor(action: string): string {
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.includes('INSERT INTO "RbacRolePermission"') && s.includes(`p."action" = '${action}'`));
      expect(statements).toHaveLength(1);
      return statements[0];
    }

    it("suricata.read NO se otorga a los 6 roles: nada de 'tecnico' ni 'ventas'", () => {
      const read = grantFor('read');
      expect(read).not.toMatch(/'tecnico'/);
      expect(read).not.toMatch(/'ventas'/);
      expect(read).not.toMatch(/'administracion'/);
    });

    it('suricata.read se otorga a super_admin, administrador y el rol de atención (noc)', () => {
      const read = grantFor('read');
      expect(read).toMatch(/'super_admin'/);
      expect(read).toMatch(/'administrador'/);
      expect(read).toMatch(/'noc'/);
      // Exactamente esos 3 — un rol más entra por acá sin que nadie lo note.
      const roles = read.match(/'(super_admin|administrador|administracion|ventas|noc|tecnico)'/g) ?? [];
      expect(roles).toHaveLength(3);
    });

    it('suricata.manage sigue restringido a super_admin + administrador (asignación)', () => {
      const manage = grantFor('manage');
      const roles = manage.match(/'(super_admin|administrador|administracion|ventas|noc|tecnico)'/g) ?? [];
      expect(roles.sort()).toEqual(["'administrador'", "'super_admin'"]);
    });

    it('suricata.reply sigue restringido a super_admin + administrador (envío irreversible a un cliente real)', () => {
      const reply = grantFor('reply');
      const roles = reply.match(/'(super_admin|administrador|administracion|ventas|noc|tecnico)'/g) ?? [];
      expect(roles.sort()).toEqual(["'administrador'", "'super_admin'"]);
    });
  });

  it('seedea las 3 acciones del módulo: read, manage y la DEDICADA reply (RBAC-EXT-2)', () => {
    expect(sql).toMatch(/'read'/);
    expect(sql).toMatch(/'manage'/);
    expect(sql).toMatch(/'reply'/);
  });

  it('sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia transacción)', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});

describe('Migración 20261117000000_seed_suricata_verdict_flag', () => {
  let sql: string;

  beforeAll(() => {
    sql = readMigration('20261117000000_seed_suricata_verdict_flag');
  });

  it("siembra 'suricata-verdict-enabled' en FALSE, idempotente", () => {
    expect(sql).toMatch(/INSERT INTO "FeatureFlag"[\s\S]*?'suricata-verdict-enabled', false[\s\S]*?ON CONFLICT DO NOTHING/);
  });

  it('el único INSERT lleva su ON CONFLICT DO NOTHING', () => {
    const inserts = sql.match(/INSERT INTO/g) ?? [];
    const conflicts = sql.match(/ON CONFLICT[^;]*DO NOTHING/g) ?? [];
    expect(inserts).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });

  it('sin BEGIN/COMMIT explícito', () => {
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/m);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/m);
  });
});
