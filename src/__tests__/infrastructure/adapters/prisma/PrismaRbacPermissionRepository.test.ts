/**
 * Contract tests for PrismaRbacPermissionRepository.
 *
 * Runs the same shared contract suite as the InMemory adapter.
 * Skipped when DATABASE_URL_TEST is absent — set it to run against a real DB.
 *
 * To run:
 *   DATABASE_URL_TEST=postgresql://... npx jest PrismaRbacPermissionRepository
 *
 * The test DB must have the RBAC migration applied (56 permissions pre-seeded).
 */

import { runRbacPermissionContractTests } from '../_shared/rbacPermissionContractTests';

const SKIP = !process.env['DATABASE_URL_TEST'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maybeSkip = (SKIP ? describe.skip : describe) as any;

maybeSkip('PrismaRbacPermissionRepository [requires DATABASE_URL_TEST]', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaRbacPermissionRepository } = require('@infrastructure/adapters/prisma/PrismaRbacPermissionRepository') as {
    PrismaRbacPermissionRepository: new () => import('@domain/ports/RbacPermissionRepository').RbacPermissionRepository;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@infrastructure/database/prisma') as {
    prisma: import('@prisma/client').PrismaClient;
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // The migration seed already provides 56 permissions (14 modules × 4 actions).
  // The makeSeededRepo factory returns a Prisma-backed repo; no extra seeding needed.
  runRbacPermissionContractTests(async () => new PrismaRbacPermissionRepository());
});
