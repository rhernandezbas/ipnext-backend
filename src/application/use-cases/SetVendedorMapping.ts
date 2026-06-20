import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { RbacUser } from '@domain/entities/rbac';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';

export interface SetVendedorMappingInput {
  userId: string;
  /** null = desmapear (limpia). string = nombre del vendedor en GR. */
  grVendedorName: string | null;
}

/**
 * SetVendedorMapping — maps an agente (RbacUser) to a GR vendedor name.
 *
 * Fase 2b (cartera "Mis clientes"). GR vendedor is a free-text soft mapping
 * (no catalog validation, unlike the IClass team mapping) — GR is slated for
 * deprecation, so the mapping is kept fully isolated from the core user model.
 *
 * Flow:
 * 1. Resolve user — not found → ReferenceNotFoundError (404).
 * 2. update(userId, { grVendedorName }). null clears the mapping.
 */
export class SetVendedorMapping {
  constructor(private readonly userRepo: RbacUserRepository) {}

  async execute(input: SetVendedorMappingInput): Promise<RbacUser> {
    const { userId, grVendedorName } = input;

    const user = await this.userRepo.findById(userId);
    if (!user) throw new ReferenceNotFoundError('user', userId);

    return this.userRepo.update(userId, { grVendedorName });
  }
}
