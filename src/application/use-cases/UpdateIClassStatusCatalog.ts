import { IClassStatusCatalogEntry } from '@domain/entities/iclass-status-catalog';
import { IClassStatusNotFoundError } from '@domain/errors/iclass';
import { IClassStatusCatalogRepository, UpdateStatusInput } from '@domain/ports/IClassStatusCatalogRepository';

/**
 * Partially update the operator-configurable fields of an IClass status catalog entry
 * (displayLabel, color, tracked). Throws IClassStatusNotFoundError when the statusCode
 * does not exist in the catalog (must first appear via auto-discovery or sync).
 */
export class UpdateIClassStatusCatalog {
  constructor(private readonly repo: IClassStatusCatalogRepository) {}

  async execute(statusCode: string, patch: UpdateStatusInput): Promise<IClassStatusCatalogEntry> {
    const updated = await this.repo.update(statusCode, patch);
    if (!updated) throw new IClassStatusNotFoundError(statusCode);
    return updated;
  }
}
