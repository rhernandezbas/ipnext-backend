import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { NasNotFoundError, PppoeIngestNotSupportedError } from '@domain/errors/pppoe';

export interface IngestPppoeResult {
  /** Cuántos PPPoE huérfanos se crearon (usernames nuevos). */
  created: number;
  /** Cuántos se omitieron por existir ya (NUNCA se pisan: pueden estar asociados). */
  skipped: number;
}

/**
 * IngestPppoeFromNas — ADOPTA el inventario PPPoE real de un NAS: carga los usuarios del RADIUS
 * como filas `PppoeService` HUÉRFANAS (contractId=null) CON su password, para que el operador
 * las asocie a contratos una por una y revele la clave.
 *
 * Routing por `nas.type`:
 *   - `mikrotik_radius` → `orchestrator.listUsers()` (GET /users: username, password, plan, framed_ip).
 *   - resto            → `PppoeIngestNotSupportedError` (no hay fuente de inventario con password aún).
 *
 * SKIP de existentes (NO clobber): si el `username` YA está en la DB, se OMITE — jamás se pisa una
 * fila (podría estar asociada a un contrato, con su propia password/profile). Solo se INSERTAN nuevos.
 * Mapeo: plan → profile, framedIp → remoteAddress, status='enabled', contractId=null.
 */
export class IngestPppoeFromNas {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
  ) {}

  async execute(nasId: string): Promise<IngestPppoeResult> {
    const nas = await this.nasRepo.findNasServerById(nasId);
    if (!nas) throw new NasNotFoundError(nasId);

    if (nas.type !== 'mikrotik_radius') {
      throw new PppoeIngestNotSupportedError(nas.type);
    }

    const inventory = await this.orchestrator.listUsers();

    let created = 0;
    let skipped = 0;
    for (const item of inventory) {
      const existing = await this.repo.findByUsername(item.username);
      if (existing) {
        skipped += 1;
        continue; // NUNCA pisar: la fila puede estar asociada con su propia clave
      }
      await this.repo.upsertByUsername({
        username: item.username,
        password: item.password,
        profile: item.plan,
        remoteAddress: item.framedIp,
        status: 'enabled',
        nasId,
        contractId: null,
      });
      created += 1;
    }

    return { created, skipped };
  }
}
