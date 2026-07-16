/**
 * Output DTOs for the contracts page (GET /api/services).
 * Field names mirror the frontend contract EXACTLY:
 *   - ContractSummary: { id, clientName, plan, status, technology, startDate }
 *   - Envelope: { data, total, page, pageSize, totalPages }
 * See ipnext-frontend src/types/contract.ts and src/types/api.ts.
 */

export interface ContractSummaryDto {
  id: string;
  /** #55 — external Gestión Real contract id (Contract.grContratoId). null for non-GR rows. */
  code: string | null;
  clientId: string;
  clientName: string;
  plan: string;
  status: string;
  technology: string | null;
  startDate: string;
  /**
   * contract-network-read — CURRENT node/AP assignment, so the FE picker (Fase B) can
   * render what is already assigned instead of flying blind. All 4 fields are nullable;
   * null means "sin asignar". Contrato acordado con el FE — nombres exactos.
   */
  networkSiteId: string | null;
  networkSiteName: string | null;
  accessPointId: string | null;
  accessPointName: string | null;
}

export interface PaginatedContractsDto {
  data: ContractSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
