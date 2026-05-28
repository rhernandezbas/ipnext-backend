import { IClassSoType } from '@domain/entities/iclass-so-type';
import { IClassSoTypeRepository } from '@domain/ports/IClassSoTypeRepository';

/**
 * Returns the IClass SO type catalog, optionally filtered by active status.
 * Returns DTOs (IClassSoType shape) — never raw Prisma entities.
 */
export class ListIClassSoTypes {
  constructor(private readonly repo: IClassSoTypeRepository) {}

  execute(filter?: { active?: boolean }): Promise<IClassSoType[]> {
    return this.repo.list(filter);
  }
}
