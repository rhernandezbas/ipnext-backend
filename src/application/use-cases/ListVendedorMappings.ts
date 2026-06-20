import { RbacUserRepository } from '@domain/ports/RbacUserRepository';

export interface VendedorMappingDTO {
  userId: string;
  userName: string;
  userLogin: string;
  grVendedorName: string | null;
}

/**
 * ListVendedorMappings — returns all users with their GR vendedor mapping.
 *
 * Fase 2b (cartera "Mis clientes"). Reuses the existing RbacUser listing — no
 * join/catalog needed since grVendedorName is a free-text soft mapping.
 */
export class ListVendedorMappings {
  constructor(private readonly userRepo: RbacUserRepository) {}

  async execute(): Promise<VendedorMappingDTO[]> {
    const users = await this.userRepo.list();
    return users.map(u => ({
      userId: u.id,
      userName: u.name,
      userLogin: u.login,
      grVendedorName: u.grVendedorName ?? null,
    }));
  }
}
