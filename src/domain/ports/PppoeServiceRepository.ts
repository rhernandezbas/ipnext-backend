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
  /** PPPoE HUÉRFANOS: sin contrato asociado (contractId=null). El inventario por adoptar. */
  findUnassigned(): Promise<PppoeService[]>;
  /**
   * PPPoE ASIGNADOS: con contractId != null AND remoteAddress != null AND status = 'enabled'.
   * Fuente de datos para la tab Asignaciones (GET /api/ip-assignments).
   */
  findAssigned(): Promise<PppoeService[]>;
  /**
   * PPPoE ASIGNADOS paginados. Misma condición base que `findAssigned` más filtros opcionales.
   * - `search`: coincidencia parcial case-insensitive sobre username, remoteAddress o contractId.
   * - `nasId`: filtro exacto por nasId.
   * - Orden estable: username asc.
   * - `total` = count con el MISMO where (sin skip/take), para el paginador del FE.
   */
  findAssignedPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    nasId?: string;
  }): Promise<{ data: PppoeService[]; total: number }>;
  /**
   * Asocia un PPPoE a un contrato seteando SOLO su `contractId` (no toca password/profile/etc.).
   * Devuelve la entidad actualizada, o null si el PPPoE no existe.
   */
  setContractId(id: string, contractId: string): Promise<PppoeService | null>;
  /**
   * Desasocia un PPPoE de su contrato seteando `contractId=null`. NO toca el `status` ni el
   * secret RADIUS (el PPPoE sigue 'enabled', vuelve a ser huérfano re-asociable).
   * Devuelve la entidad actualizada, o null si el PPPoE no existe.
   */
  clearContractId(id: string): Promise<PppoeService | null>;

  // ── Fase C (enforcement) ───────────────────────────────────────────────────
  /**
   * Setea SOLO el `enforcedState` de un PPPoE (NO toca el `profile` comercial).
   * Devuelve la entidad actualizada, o null si no existe.
   */
  setEnforcedState(id: string, state: EnforcedState): Promise<PppoeService | null>;
  /** persist-caller-id: guarda la MAC del CPE (última sesión vista) para que sobreviva a la desconexión. */
  setCallerId(id: string, callerId: string): Promise<void>;
  /**
   * PPPoE de clientes con un `Client.status` dado (cruza pppoe→contract→client).
   * Es el resolver de `target='debtors'` (status='late') sin depender de RADIUS.
   */
  listByClientStatus(status: string): Promise<PppoeService[]>;
}
