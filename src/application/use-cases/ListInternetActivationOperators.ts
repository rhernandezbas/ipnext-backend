import type { ContractServiceEventRepository } from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { InternetActivationOperatorDto } from '@application/dto/pppoe.dto';

/**
 * ListInternetActivationOperators (internet-history) — query use case que devuelve los
 * OPERADORES DISTINCT ({actorId, actorName}) que produjeron eventos del servicio INTERNET.
 * Espejo "operadores" de ListInternetServiceHistory: puebla el <select> de operadores del
 * historial con gate pppoe.read (el FE hoy usa useRbacUsers, que exige admin/rbac — inusable
 * para usuarios pppoe.read).
 *
 * INTERNET se identifica por ServiceCatalog.name === 'INTERNET'. Se resuelve el catalog id una
 * vez y se pasa como serviceCatalogId filter, así el resultado NUNCA incluye TV ni otros. Si
 * falta el catálogo INTERNET, devuelve [] (falla-cerrado: no se filtran operadores ajenos).
 *
 * Orden por actorName asc lo garantiza el repo. El mapeo a DTO ocurre acá (no se filtran
 * objetos de dominio).
 */
export class ListInternetActivationOperators {
  constructor(
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
  ) {}

  async execute(): Promise<InternetActivationOperatorDto[]> {
    const internet = await this.catalogRepo.getByName('INTERNET');
    if (!internet) return [];
    const ops = await this.eventRepo.listDistinctOperators({ serviceCatalogId: internet.id });
    return ops.map(o => ({ actorId: o.actorId, actorName: o.actorName }));
  }
}
