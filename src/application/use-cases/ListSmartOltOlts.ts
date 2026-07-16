import {
  SmartOltOltConfig,
  SmartOltOltConfigRepository,
} from '@domain/ports/SmartOltOltConfigRepository';

/**
 * smartolt-provision (K2) — catálogo de OLTs SmartOLT (config de fibra):
 * GET /api/fiber/olts. El shape del port YA es un DTO plano (sin entidad Prisma).
 */
export class ListSmartOltOlts {
  constructor(private readonly repo: SmartOltOltConfigRepository) {}

  async execute(): Promise<SmartOltOltConfig[]> {
    return this.repo.list();
  }
}
