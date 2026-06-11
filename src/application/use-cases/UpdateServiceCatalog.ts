import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ServiceCatalog } from '@domain/entities/service-catalog';
import {
  ServiceCatalogNotFoundError,
  ServiceCatalogNameConflictError,
  ServiceCatalogNonRenameableError,
} from '@domain/errors/contractServices';

export class UpdateServiceCatalog {
  constructor(private readonly repo: ServiceCatalogRepository) {}
  async execute(id: string, data: Partial<{ name: string; label: string | null; active: boolean; sortOrder: number }>): Promise<ServiceCatalog> {
    const item = await this.repo.getById(id);
    if (!item) throw new ServiceCatalogNotFoundError(id);

    let patch = { ...data };
    if (data.name) {
      const normalized = data.name.trim().toUpperCase();
      const isRename = normalized.toLowerCase() !== item.name.toLowerCase();
      if (isRename) {
        // W-1 — OTROS is the protected catch-all; its name is frozen. Renaming it would
        // bypass the non-deletable guard. A no-op name (same value) is still allowed.
        if (item.name === 'OTROS') throw new ServiceCatalogNonRenameableError();
        const conflict = await this.repo.getByName(normalized);
        if (conflict && conflict.id !== id) throw new ServiceCatalogNameConflictError(normalized);
      }
      patch = { ...patch, name: normalized };
    }

    const updated = await this.repo.update(id, patch);
    if (!updated) throw new ServiceCatalogNotFoundError(id);
    return updated;
  }
}
