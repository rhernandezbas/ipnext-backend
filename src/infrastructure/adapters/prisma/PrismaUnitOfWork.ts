import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { prisma } from '../../database/prisma';
import { PrismaInventorySuggestionRepository } from './PrismaInventorySuggestionRepository';
import { PrismaContractInventoryRepository } from './PrismaContractInventoryRepository';
import { PrismaStockLocationRepository } from './PrismaStockLocationRepository';
import { PrismaInventoryAssetRepository } from './PrismaInventoryAssetRepository';
import { PrismaInventoryMovementRepository } from './PrismaInventoryMovementRepository';
import { PrismaReturnSuggestionRepository } from './PrismaReturnSuggestionRepository';

/**
 * Prisma UnitOfWork (Fix #1/#3). Opens a single `prisma.$transaction` and builds
 * tx-scoped repo instances bound to the SAME `tx` client, so every write issued
 * through the bag (asset.create + INSTALL movement + CII.create + setStatus)
 * shares one transaction. A throw anywhere rolls the whole thing back — a real
 * transaction boundary, NOT compensation. The movement repo detects it's running
 * tx-scoped and skips its own nested `$transaction`.
 */
export class PrismaUnitOfWork implements UnitOfWork {
  constructor(private readonly client = prisma) {}

  async runInTransaction<T>(fn: (repos: TransactionalRepos) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => {
      const repos: TransactionalRepos = {
        suggestions: new PrismaInventorySuggestionRepository(tx),
        inventory: new PrismaContractInventoryRepository(tx),
        locations: new PrismaStockLocationRepository(tx),
        assets: new PrismaInventoryAssetRepository(tx),
        movements: new PrismaInventoryMovementRepository(tx),
        returns: new PrismaReturnSuggestionRepository(tx),
      };
      return fn(repos);
    });
  }
}
