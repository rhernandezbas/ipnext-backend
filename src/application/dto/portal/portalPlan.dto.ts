/**
 * PortalPlanDto — customer-portal-api (Fase 4, task 4.3 + fix wave L1).
 *
 * portal-self-service spec "Mis planes": un contrato del cliente con su plan
 * contratado, estado y servicios asociados (#43 `ContractService` -> `ServiceCatalog`,
 * ver `domain/entities/customer.ts` `Contract`/`ContractServiceItem`). Sin campos
 * operativos internos (sin `vendedor`, sin `technology` interno de red, sin GPS,
 * y — L1 — sin `contractId`: el id interno del contrato no esta en el allow-list
 * del spec y no viaja al portal).
 */
export interface PortalPlanServiceDto {
  name: string;
  status: string;
}

export interface PortalPlanDto {
  plan: string;
  type: string;
  status: string;
  startDate: string;
  services: PortalPlanServiceDto[];
}
