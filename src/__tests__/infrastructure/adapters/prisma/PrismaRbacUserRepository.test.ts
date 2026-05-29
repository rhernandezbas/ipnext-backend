/**
 * Contract tests for PrismaRbacUserRepository.
 *
 * Runs the same shared contract suite as the InMemory adapter.
 * Skipped when DATABASE_URL_TEST is absent — set it to run against a real DB.
 *
 * To run:
 *   DATABASE_URL_TEST=postgresql://... npx jest PrismaRbacUserRepository
 *
 * The test DB must have the RBAC migration applied (SDD #1 migration must be present).
 * Each test gets a fresh instance; data isolation relies on unique logins/emails.
 *
 * For countUsersWithRoleCode: the Prisma adapter reads from the actual DB via JOIN.
 * The seedRole helper creates a role directly via prisma to avoid depending on the
 * RbacRoleRepository port (which is not injected into PrismaRbacUserRepository).
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

  runRbacUserContractTests(
    () => new PrismaRbacUserRepository(),
    () => {
      const userRepo = new PrismaRbacUserRepository();
      const userRoleRepo = new PrismaRbacUserRoleRepository();
      return {
        userRepo,
        userRoleRepo,
        seedRole: async (code: string) => {
          // Create a role directly via prisma — this is a test-only helper
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const role = await (prisma as any).rbacRole.create({
            data: { code, label: code, isSystem: true },
          });
          return role.id as string;
        },
      };
    },
  );
});
