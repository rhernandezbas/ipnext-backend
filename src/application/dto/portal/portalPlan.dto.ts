/**
 * PortalPlanDto — customer-portal-api (Fase 4, task 4.3).
 *
 * portal-self-service spec "Mis planes": un contrato del cliente con su plan
 * contratado, estado y servicios asociados (#43 `ContractService` -> `ServiceCatalog`,
 * ver `domain/entities/customer.ts` `Contract`/`ContractServiceItem`). Sin campos
 * operativos internos (sin `vendedor`, sin `technology` interno de red, sin GPS).
 */
export interface PortalPlanServiceDto {
  name: string;
  status: string;
}

export interface PortalPlanDto {
  contractId: string;
  plan: string;
  type: string;
  status: string;
  startDate: string;
  services: PortalPlanServiceDto[];
}
