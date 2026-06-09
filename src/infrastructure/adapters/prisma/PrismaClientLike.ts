import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Minimal client surface the inventory adapters need. Satisfied by both the
 * root `PrismaClient` and a `$transaction` callback's `Prisma.TransactionClient`,
 * so the same repo classes can run standalone OR tx-scoped inside a UnitOfWork
 * (Fix #1/#3). Defaults to the global `prisma` when no client is injected.
 */
export type PrismaClientLike = PrismaClient | Prisma.TransactionClient;
