/**
 * Contract tests for PrismaRbacUserRepository.
 *
 * Runs the same shared contract suite as the InMemory adapter.
 * Skipped when DATABASE_URL_TEST is absent — set it to run against a real DB.
 *
 * To run:
 *   DATABASE_URL_TEST=postgresql://... npx jest PrismaRbacUserRepository
 *
 * The test DB must have the RBAC migration applied.
 * Each test gets a fresh instance; data isolation relies on unique logins/emails.
 */

import { runRbacUserContractTests } from '../_shared/rbacUserContractTests';

const SKIP = !process.env['DATABASE_URL_TEST'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const maybeSkip = (SKIP ? describe.skip : describe) as any;

maybeSkip('PrismaRbacUserRepository [requires DATABASE_URL_TEST]', () => {
  // Import adapters inside the suite so they only initialise when the suite runs
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaRbacUserRepository } = require('@infrastructure/adapters/prisma/PrismaRbacUserRepository') as {
    PrismaRbacUserRepository: new () => import('@domain/ports/RbacUserRepository').RbacUserRepository;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { prisma } = require('@infrastructure/database/prisma') as {
    prisma: import('@prisma/client').PrismaClient;
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  runRbacUserContractTests(() => new PrismaRbacUserRepository());
});
