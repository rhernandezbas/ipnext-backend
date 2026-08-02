/**
 * PortalAccountRepository — domain port (customer-portal-api Fase 1).
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { PortalAccount } from '../entities/portalAccount';
import type { PaginatedResult, PaginatedQuery } from '../entities/pagination';

export interface CreatePortalAccountInput {
  clientId: string;
  dni: string;
  passwordHash: string;
}

/** Partial update — only provided fields change. */
export interface UpdatePortalAccountInput {
  dni?: string;
  passwordHash?: string;
  status?: 'active' | 'disabled';
  mustChangePassword?: boolean;
  lastLoginAt?: Date;
}

/** portal-notification-inbox — referencia narrow (accountId + clientId), sin el resto de `PortalAccount`. */
export interface PortalAccountClientRef {
  accountId: string;
  clientId: string;
}

export interface PortalAccountRepository {
  findById(id: string): Promise<PortalAccount | null>;
  /** Login lookup — exact match on the unique `dni` column. */
  findByDni(dni: string): Promise<PortalAccount | null>;
  /** 1 account <-> 1 client (v1) — used by the admin CRUD to enforce uniqueness. */
  findByClientId(clientId: string): Promise<PortalAccount | null>;
  create(input: CreatePortalAccountInput): Promise<PortalAccount>;
  /** Rejects if `id` does not exist. */
  update(id: string, patch: UpdatePortalAccountInput): Promise<PortalAccount>;
  delete(id: string): Promise<void>;
  /**
   * portal-accounts-admin (Fase 3) — paginated listing for `ListPortalAccounts`.
   * Newest first (`createdAt desc`). Same page/limit defaulting contract as
   * `CustomerRepository.list` (page=1, limit=25 when omitted/invalid).
   */
  list(query: PaginatedQuery): Promise<PaginatedResult<PortalAccount>>;
  /**
   * portal-promos (`audience-preview`) — cuántos de estos `clientId` tienen
   * cuenta de portal. Es el ÚNICO número del preview que refleja a quién le
   * llega DE VERDAD (una promo no sirve de nada para un cliente sin app). UNA
   * query agregada (`count` con `clientId IN (...)`), nunca N llamadas a
   * `findByClientId`. `[]` de input -> 0 sin disparar query.
   */
  countByClientIds(clientIds: string[]): Promise<number>;
  /**
   * portal-notification-inbox — TODAS las cuentas cuyo `clientId` está en
   * `clientIds`, SIN mirar `PortalPushPreference` — el buzón es REGISTRO
   * (¿existió el aviso?), no TIMBRE (¿sonó el teléfono?). Esas son dos
   * preguntas distintas y esta query solo responde la primera. `undefined` =
   * TODAS las cuentas (aviso sin filtro de nodo); `[]` = ninguna, sin
   * disparar query (mismo criterio que `countByClientIds`).
   */
  listByClientIds(clientIds?: string[]): Promise<PortalAccountClientRef[]>;
}
