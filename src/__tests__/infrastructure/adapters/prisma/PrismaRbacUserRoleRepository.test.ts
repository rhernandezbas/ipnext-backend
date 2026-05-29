/**
 * Contract tests for PrismaRbacUserRoleRepository.
 *
 * Runs the same shared contract suite as the InMemory adapter.
 * Skipped when DATABASE_URL_TEST is absent — set it to run against a real DB.
 *
 * To run:
 *   DATABASE_URL_TEST=postgresql://... npx jest PrismaRbacUserRoleRepository
 *
 * NOTE: The shared contract tests use synthetic string IDs ('user-1', 'role-admin').
 * For Prisma, those must be valid FK references in the DB — ensure the test DB has
 * matching RbacUser and RbacRole rows, or the FK constraints will reject the inserts.
 * A full integration test would pre-create the user and role rows first.
 */

import { runRbacUserRoleContractTests } from '../_shared/rbacUserRoleContractTests';

const SKIP = !process.env['DATABASE_URL_TEST'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maybeSkip = (SKIP ? describe.skip : describe) as any;

maybeSkip('PrismaRbacUserRoleRepository [requires DATABASE_URL_TEST]', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaRbacUserRoleRepository } = require('@infrastructure/adapters/prisma/PrismaRbacUserRoleRepository') as {
    PrismaRbacUserRoleRepository: new () => import('@domain/ports/RbacUserRoleRepository').RbacUserRoleRepository;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@infrastructure/database/prisma') as {
    prisma: import('@prisma/client').PrismaClient;
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  runRbacUserRoleContractTests(() => new PrismaRbacUserRoleRepository());
});
