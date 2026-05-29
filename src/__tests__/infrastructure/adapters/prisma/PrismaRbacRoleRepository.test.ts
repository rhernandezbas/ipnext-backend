/**
 * Contract tests for PrismaRbacRoleRepository.
 *
 * Runs the same shared contract suite as the InMemory adapter.
 * Skipped when DATABASE_URL_TEST is absent — set it to run against a real DB.
 *
 * To run:
 *   DATABASE_URL_TEST=postgresql://... npx jest PrismaRbacRoleRepository
 *
 * The test DB must have the RBAC migration applied (roles are seeded by migration SQL).
 */

import { runRbacRoleContractTests } from '../_shared/rbacRoleContractTests';

const SKIP = !process.env['DATABASE_URL_TEST'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maybeSkip = (SKIP ? describe.skip : describe) as any;

maybeSkip('PrismaRbacRoleRepository [requires DATABASE_URL_TEST]', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaRbacRoleRepository } = require('@infrastructure/adapters/prisma/PrismaRbacRoleRepository') as {
    PrismaRbacRoleRepository: new () => import('@domain/ports/RbacRoleRepository').RbacRoleRepository;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@infrastructure/database/prisma') as {
    prisma: import('@prisma/client').PrismaClient;
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // The migration seed already provides noc, super_admin, and all 6 system roles.
  // The makeSeededRepo factory returns a Prisma-backed repo; no extra seeding needed.
  runRbacRoleContractTests(async () => new PrismaRbacRoleRepository());
});
