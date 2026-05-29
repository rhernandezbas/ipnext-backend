/**
 * RBAC migration seed validation test.
 *
 * Asserts that the migration seeded 14 modules, 56 permissions, and 6 roles.
 * Skipped when DATABASE_URL_TEST is absent — set it to run against a real DB.
 *
 * To run:
 *   DATABASE_URL_TEST=postgresql://... npx jest rbac-migration
 */

const SKIP = !process.env['DATABASE_URL_TEST'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maybeSkip = (SKIP ? describe.skip : describe) as any;

maybeSkip(
  'RBAC migration seed validation [requires DATABASE_URL_TEST]',
  () => {
    // Import prisma inside the suite so it only initialises when the suite runs
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { prisma } = require('@infrastructure/database/prisma') as {
      prisma: import('@prisma/client').PrismaClient;
    };

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('seeds exactly 14 RBAC modules', async () => {
      const count = await (prisma as any).rbacModule.count();
      expect(count).toBe(14);
    });

    it('seeds exactly 56 RBAC permissions (14 modules × 4 actions)', async () => {
      const count = await (prisma as any).rbacPermission.count();
      expect(count).toBe(56);
    });

    it('seeds exactly 6 RBAC roles', async () => {
      const count = await (prisma as any).rbacRole.count();
      expect(count).toBe(6);
    });

    it('seeds super_admin role with 56 permission grants', async () => {
      const superAdmin = await (prisma as any).rbacRole.findUnique({
        where: { code: 'super_admin' },
        include: { _count: { select: { permissions: true } } },
      });
      expect(superAdmin).not.toBeNull();
      expect(superAdmin._count.permissions).toBe(56);
    });

    it('non-super_admin roles start with 0 permission grants', async () => {
      const roles = await (prisma as any).rbacRole.findMany({
        where: { code: { not: 'super_admin' } },
        include: { _count: { select: { permissions: true } } },
      });
      for (const role of roles) {
        expect(role._count.permissions).toBe(0);
      }
    });
  },
);
