import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { InstalledItemDto, toInstalledItemDto } from '@application/dto/InstalledItemDto';

/** Lists the installed inventory of a contract, resolving each item's approver name. */
export class ListContractInstalledItems {
  constructor(
    private readonly inventory: ContractInventoryRepository,
    private readonly users: RbacUserRepository,
  ) {}

  async execute(contractId: string): Promise<InstalledItemDto[]> {
    const items = await this.inventory.listByContract(contractId);
    const ids = [...new Set(items.map(i => i.addedByUserId).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    await Promise.all(
      ids.map(async id => {
        const u = await this.users.findById(id);
        if (u) names.set(id, u.name);
      }),
    );
    return items.map(i =>
      toInstalledItemDto(i, i.addedByUserId ? names.get(i.addedByUserId) ?? null : null),
    );
  }
}
