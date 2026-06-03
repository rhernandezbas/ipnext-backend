import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

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
