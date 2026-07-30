import { randomUUID } from 'crypto';
import type { PortalAccount } from '@domain/entities/portalAccount';
import type {
  PortalAccountRepository,
  CreatePortalAccountInput,
  UpdatePortalAccountInput,
} from '@domain/ports/PortalAccountRepository';
import { PortalAccountNotFoundError } from '@domain/errors/portal.errors';

/** InMemoryPortalAccountRepository — test seam (Fase 1, task 1.3). */
export class InMemoryPortalAccountRepository implements PortalAccountRepository {
  private readonly store: PortalAccount[] = [];

  async findById(id: string): Promise<PortalAccount | null> {
    const row = this.store.find((a) => a.id === id);
    return row ? { ...row } : null;
  }

  async findByDni(dni: string): Promise<PortalAccount | null> {
    const row = this.store.find((a) => a.dni === dni);
    return row ? { ...row } : null;
  }

  async findByClientId(clientId: string): Promise<PortalAccount | null> {
    const row = this.store.find((a) => a.clientId === clientId);
    return row ? { ...row } : null;
  }

  async create(input: CreatePortalAccountInput): Promise<PortalAccount> {
    const now = new Date().toISOString();
    const account: PortalAccount = {
      id: randomUUID(),
      clientId: input.clientId,
      dni: input.dni,
      passwordHash: input.passwordHash,
      status: 'active',
      mustChangePassword: true,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.push(account);
    return { ...account };
  }

  async update(id: string, patch: UpdatePortalAccountInput): Promise<PortalAccount> {
    const row = this.store.find((a) => a.id === id);
    if (!row) throw new PortalAccountNotFoundError(id);
    if (patch.dni !== undefined) row.dni = patch.dni;
    if (patch.passwordHash !== undefined) row.passwordHash = patch.passwordHash;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.mustChangePassword !== undefined) row.mustChangePassword = patch.mustChangePassword;
    if (patch.lastLoginAt !== undefined) row.lastLoginAt = patch.lastLoginAt.toISOString();
    row.updatedAt = new Date().toISOString();
    return { ...row };
  }

  async delete(id: string): Promise<void> {
    const idx = this.store.findIndex((a) => a.id === id);
    if (idx >= 0) this.store.splice(idx, 1);
  }
}
