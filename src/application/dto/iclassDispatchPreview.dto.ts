/**
 * DTO for the IClass dispatch-preview endpoint (Ola C).
 * Whitelist only — no Prisma/entity leakage.
 */
import { DispatchPreviewRow } from '@application/use-cases/GetIClassDispatchPreview';

export interface DispatchPreviewRowDTO {
  projectId: string;
  projectTitle: string;
  soType: { code: string; description: string } | null;
  nodeResolution: 'by-customer-city';
  customerCodeSource: 'contractCode-or-customerCode';
  phoneSource: 'customer-phone';
  soCodeSource: 'task-sequence-number';
  initialStatus: 'assigned-by-iclass';
  hardcoded: {
    networkPhone: '0000000000';
    networkCustomerCode: 'NETWORK';
  };
}

export interface DispatchPreviewListDTO {
  items: DispatchPreviewRowDTO[];
}

export function toDispatchPreviewRowDTO(row: DispatchPreviewRow): DispatchPreviewRowDTO {
  return {
    projectId: row.projectId,
    projectTitle: row.projectTitle,
    soType: row.soType ? { code: row.soType.code, description: row.soType.description } : null,
    nodeResolution: row.nodeResolution,
    customerCodeSource: row.customerCodeSource,
    phoneSource: row.phoneSource,
    soCodeSource: row.soCodeSource,
    initialStatus: row.initialStatus,
    hardcoded: {
      networkPhone: '0000000000',
      networkCustomerCode: 'NETWORK',
    },
  };
}
