import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { NasRepository } from '@domain/ports/NasRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import {
  NasNotFoundError,
  PppoeIngestNotSupportedError,
  PppoeNasHasNoPoolsError,
} from '@domain/errors/pppoe';
import { routesViaOrchestrator } from '@domain/entities/nas';
import { ipInAnyRange } from '@domain/services/ipMath';

export interface IngestPppoeResult {
  /** Cuántos PPPoE huérfanos se crearon (usernames nuevos). */
  created: number;
  /** Cuántos se omitieron por existir ya (NUNCA se pisan: pueden estar asociados). */
  skipped: number;
  /** Cuántos se descartaron porque el username matcheó un exclusionPattern (placeholder interno). */
  excluded: number;
  /**
   * ingest-pppoe-filter-by-nas-pools: cuántos usuarios del inventario RADIUS COMPARTIDO se
   * descartaron porque su `framedIp` no cae en NINGÚN pool de ESTE NAS (o no tienen framedIp
   * válido) — pertenecen a otro NAS, son CGNAT de otro router, o healthchecks sin IP.
   */
  skippedOtherNas: number;
}

/**
 * IngestPppoeFromNas — ADOPTA el inventario PPPoE real de un NAS: carga los usuarios del RADIUS
 * como filas `PppoeService` HUÉRFANAS (contractId=null) CON su password, para que el operador
 * las asocie a contratos una por una y revele la clave.
 *
 * Routing por `nas.type`:
 *   - `radius_orchestrator` → `orchestrator.listUsers()` (GET /users: username, password, plan, framed_ip).
 *   - resto            → `PppoeIngestNotSupportedError` (no hay fuente de inventario con password aún).
 *
 * ingest-pppoe-filter-by-nas-pools: `orchestrator.listUsers()` devuelve TODOS los usuarios del
 * RADIUS HA compartido (~6300, de MUCHOS NAS) — no solo los de este NAS. Antes se atribuían TODOS
 * a `nasId` ciegamente. Ahora se filtra por pertenencia: un item SOLO se ingiere si su `framedIp`
 * es una IPv4 válida que cae en alguno de los `IpPool` de ESTE NAS (`findPoolsByNas`). Sin ningún
 * pool cargado no hay forma de distinguir pertenencia → se rechaza con `PppoeNasHasNoPoolsError`
 * en vez de ingerir todo el RADIUS a ciegas.
 *
 * SKIP de existentes (NO clobber): si el `username` YA está en la DB Y NO está terminated, se OMITE
 * (podría estar asociado con su propia password/profile). Excepción: si el existente tiene
 * status='terminated', significa que fue recreado en el router tras una baja → se RE-INGESTA
 * (se actualiza a enabled+contractId=null con los datos frescos del RADIUS).
 * Mapeo: plan → profile, framedIp → remoteAddress, status='enabled', contractId=null.
 */
export class IngestPppoeFromNas {
  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly nasRepo: NasRepository,
    private readonly orchestrator: RadiusOrchestratorGateway,
    /**
     * Pools de IP del NAS (`IpPool.nasId`) — usado para atribuir correctamente el inventario
     * RADIUS compartido a ESTE NAS por `framedIp` (ingest-pppoe-filter-by-nas-pools).
     */
    private readonly ipNetworkRepo: IpNetworkRepository,
    /**
     * Patrones de exclusión para usernames placeholder (e.g. /^accesosur\d+$/i).
     * Los usernames que matcheen alguno de estos patrones se descartan sin persistir.
     * Separado de `skipped` (existentes) — son contadores independientes.
     * Default: [] (sin exclusiones = comportamiento original BC).
     */
    private readonly exclusionPatterns: RegExp[] = [],
  ) {}

  async execute(nasId: string): Promise<IngestPppoeResult> {
    const nas = await this.nasRepo.findNasServerById(nasId);
    if (!nas) throw new NasNotFoundError(nasId);

    if (!routesViaOrchestrator(nas.type)) {
      throw new PppoeIngestNotSupportedError(nas.type);
    }

    const pools = await this.ipNetworkRepo.findPoolsByNas(nasId);
    if (pools.length === 0) {
      throw new PppoeNasHasNoPoolsError(nasId);
    }

    const inventory = await this.orchestrator.listUsers();

    let created = 0;
    let skipped = 0;
    let excluded = 0;
    let skippedOtherNas = 0;
    for (const item of inventory) {
      // Filtro de exclusión (placeholders internos como accesosurN)
      if (this.exclusionPatterns.some(re => re.test(item.username))) {
        excluded += 1;
        continue;
      }

      // Filtro de pertenencia al NAS: framedIp debe caer en alguno de sus pools.
      // Sin framedIp (null/vacío) o fuera de todos los pools → pertenece a otro NAS.
      if (!item.framedIp || !ipInAnyRange(item.framedIp, pools)) {
        skippedOtherNas += 1;
        continue;
      }

      const existing = await this.repo.findByUsername(item.username);
      if (existing) {
        // terminated = fue recreado en el router tras una baja → re-ingestar con los datos frescos
        if (existing.status !== 'terminated') {
          skipped += 1;
          continue; // fila activa/asociada — jamás pisar
        }
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

    return { created, skipped, excluded, skippedOtherNas };
  }
}
