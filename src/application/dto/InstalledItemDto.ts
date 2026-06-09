import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { ClientInstalledItemRow } from '@domain/ports/ContractInventoryRepository';

/**
 * Wire-format de un ítem instalado: la entidad de dominio + el nombre del usuario
 * que lo aprobó (resuelto desde `addedByUserId`). `addedByUserName` es null cuando
 * no hay aprobador (ítem manual viejo) o el usuario no existe.
 */
export interface InstalledItemDto extends ContractInstalledItem {
  addedByUserName: string | null;
}

export function toInstalledItemDto(
  item: ContractInstalledItem,
  userName: string | null,
): InstalledItemDto {
  return { ...item, addedByUserName: userName };
}

/**
 * Wire-format de un ítem instalado en la vista AGREGADA por cliente: la entidad
 * de dominio + el contexto del contrato al que pertenece (plan y tipo). Se usa
 * en `GET /api/clients/:clientId/equipment` para agrupar por contrato.
 */
export interface ClientInstalledItemDto extends ContractInstalledItem {
  /** Plan del contrato (ej: "Fibra 300MB"). */
  contractPlan: string;
  /** Tipo del contrato (ej: "internet"). */
  contractType: string;
}

export function toClientInstalledItemDto(row: ClientInstalledItemRow): ClientInstalledItemDto {
  return { ...row };
}
