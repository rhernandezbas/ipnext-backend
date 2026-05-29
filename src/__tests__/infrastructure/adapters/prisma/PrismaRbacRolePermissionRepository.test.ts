/**
 * Contract tests for PrismaRbacRolePermissionRepository.
 *
 * Runs the same shared contract suite as the InMemory adapter.
 * Skipped when DATABASE_URL_TEST is absent — set it to run against a real DB.
 *
 * To run:
 *   DATABASE_URL_TEST=postgresql://... npx jest PrismaRbacRolePermissionRepository
 *
 * NOTE: The shared contract tests use synthetic string IDs ('role-admin', 'perm-clients-read').
 * For Prisma, those must be valid FK references in the DB — ensure the test DB has
 * matching RbacRole and RbacPermission rows, or the FK constraints will reject inserts.
 * A full integration test would resolve real IDs from the migration seed first.
 */

import { runRbacRolePermissionContractTests } from '../_shared/rbacRolePermissionContractTests';

const SKIP = !process.env['DATABASE_URL_TEST'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maybeSkip = (SKIP ? describe.skip : describe) as any;

maybeSkip('PrismaRbacRolePermissionRepository [requires DATABASE_URL_TEST]', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaRbacRolePermissionRepository } = require('@infrastructure/adapters/prisma/PrismaRbacRolePermissionRepository') as {
    PrismaRbacRolePermissionRepository: new () => import('@domain/ports/RbacRolePermissionRepository').RbacRolePermissionRepository;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@infrastructure/database/prisma') as {
    prisma: import('@prisma/client').PrismaClient;
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  runRbacRolePermissionContractTests(() => new PrismaRbacRolePermissionRepository());
});
