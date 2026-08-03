import type { ContractLookup } from '@application/use-cases/gigared/lookups';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import type { PortalTvStatusDto } from '@application/dto/portal/portalTv.dto';

/**
 * EPIC v3 (clave de TV del portal) — `GET /api/portal/tv/:contractId`.
 *
 * Lectura 100% LOCAL (jamás toca Gigared): `hasTv` = el CONTRATO del param
 * tiene la fila TV (ContractService del catálogo name='TV'). Ancla el
 * CONTRATO vía `getByPair` — a diferencia de `PrismaTvCredentialsReader`, que
 * ancla por customer (un cliente con dos contratos vería el slot equivocado).
 * El login visible es el `tvLogin` del slot; la password NUNCA sale por acá
 * (la lección del leak #65/H3 — la credencial completa es superficie de staff).
 *
 * Decisiones:
 *  - Anti-IDOR: contrato ajeno o inexistente -> `ContractNotFoundError` (el
 *    MISMO error que tira `ChangeTvPassword`) — 404 indistinguible en la ruta.
 *  - Solo slot ACTIVO cuenta como "tiene TV": una baja/rebaja deja la fila
 *    inactiva y el staff aún lee las credenciales (M8), pero el CLIENTE no
 *    debe ver un servicio dado de baja como propio.
 *  - Catálogo sin entrada 'TV' activa -> hasTv:false (nadie tiene TV; estado
 *    normal, no un 500 — mismo criterio `not_configured` del WiFi).
 */
export class GetPortalTvStatus {
  constructor(
    private readonly contractLookup: ContractLookup,
    private readonly catalogRepo: Pick<ServiceCatalogRepository, 'getByName'>,
    private readonly csRepo: Pick<ContractServiceRepository, 'getByPair'>,
  ) {}

  async execute(clientId: string, contractId: string): Promise<PortalTvStatusDto> {
    const contract = await this.contractLookup.findById(contractId);
    if (!contract || contract.clientId !== clientId) {
      throw new ContractNotFoundError(contractId);
    }

    const tvCatalog = await this.catalogRepo.getByName('TV');
    if (!tvCatalog || !tvCatalog.active) {
      return { hasTv: false, login: null };
    }

    const slot = await this.csRepo.getByPair(contractId, tvCatalog.id);
    if (!slot || slot.status !== 'active') {
      return { hasTv: false, login: null };
    }

    return { hasTv: true, login: slot.tvLogin ?? null };
  }
}
