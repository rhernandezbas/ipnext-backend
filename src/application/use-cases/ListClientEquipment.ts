import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { ClientInstalledItemDto, toClientInstalledItemDto } from '@application/dto/InstalledItemDto';

/**
 * Vista agregada de TODO el equipamiento instalado a lo largo de los contratos
 * de un cliente. Read-only. El repo resuelve el JOIN con Contract y entrega las
 * filas ya ordenadas (por contrato, luego antigüedad); este caso de uso sólo
 * mapea a DTO — nunca devuelve entidades crudas.
 */
export class ListClientEquipment {
  constructor(private readonly inventory: ContractInventoryRepository) {}

  async execute(clientId: string): Promise<ClientInstalledItemDto[]> {
    const rows = await this.inventory.listByClient(clientId);
    return rows.map(toClientInstalledItemDto);
  }
}
