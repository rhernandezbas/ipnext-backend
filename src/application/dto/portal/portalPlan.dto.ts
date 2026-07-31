/**
 * PortalPlanDto — customer-portal-api (Fase 4, task 4.3 + fix wave L1 +
 * portal-ticket-contract v2.A).
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
  /**
   * v2.A (portal-ticket-contract) — REINSTATED. L1 (review de la v1) lo sacó
   * de este DTO: "UUID interno expuesto sin ningún uso = foothold para un
   * IDOR futuro". Ahora SÍ tiene un uso legítimo — el usuario pidió "para
   * abrir un reclamo debería seleccionar el contrato primero", y este es
   * EXACTAMENTE el valor que la app manda de vuelta en
   * `POST /api/portal/tickets` (`contractId`) para indicar sobre qué
   * contrato es el reclamo. Precisamente PORQUE vuelve a viajar al cliente,
   * `CreatePortalTicket` valida SIEMPRE que el `contractId` recibido
   * pertenezca al cliente del token — el BE nunca confía en lo que la app
   * filtró acá (ver `PortalContractNotFoundError`). Si en el futuro alguien
   * piensa en sacarlo de nuevo, que lea esto primero: la app lo necesita.
   */
  contractId: string;
  plan: string;
  type: string;
  status: string;
  startDate: string;
  services: PortalPlanServiceDto[];
}
