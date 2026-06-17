import { PppoeService, EnforcedState } from '../entities/pppoeService';

export interface PppoeServiceUpsert {
  username: string;
  password: string;
  profile?: string | null;
  remoteAddress?: string | null;
  status?: string;
  nasId: string;
  contractId?: string | null;
  enforcedState?: EnforcedState; // Fase C — default 'active' si se omite
}

export interface PppoeServiceRepository {
  /** Idempotente por `username`: crea o actualiza la fila existente. */
  upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService>;
  list(): Promise<PppoeService[]>;
  findById(id: string): Promise<PppoeService | null>;
  findByUsername(username: string): Promise<PppoeService | null>;
  findByContract(contractId: string): Promise<PppoeService[]>;

  // ── Fase C (enforcement) ───────────────────────────────────────────────────
  /**
   * Setea SOLO el `enforcedState` de un PPPoE (NO toca el `profile` comercial).
   * Devuelve la entidad actualizada, o null si no existe.
   */
  setEnforcedState(id: string, state: EnforcedState): Promise<PppoeService | null>;
  /**
   * PPPoE de clientes con un `Client.status` dado (cruza pppoe→contract→client).
   * Es el resolver de `target='debtors'` (status='late') sin depender de RADIUS.
   */
  listByClientStatus(status: string): Promise<PppoeService[]>;
}
