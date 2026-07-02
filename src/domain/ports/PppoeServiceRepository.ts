import { PppoeService, EnforcedState, PppoeDisplayStatus } from '../entities/pppoeService';

export interface PppoeServiceUpsert {
  username: string;
  password: string;
  profile?: string | null;
  remoteAddress?: string | null;
  status?: string;
  nasId: string;
  contractId?: string | null;
  enforcedState?: EnforcedState; // Fase C — default 'active' si se omite
  /** pppoe-pool-ip: modo de asignación de IP. 'pool' = FreeRADIUS asigna del pool | 'fixed' = IP pineada. Default 'fixed'. */
  ipMode?: 'pool' | 'fixed';
}

/**
 * internet-history — PPPoE row enriched with the contract's client (resolved via JOIN
 * pppoe → Contract → Client). Used by the GLOBAL internet services list so the use case
 * never re-queries per row. clientId/customerName are best-effort (null for orphan rows
 * without a contract, or when the client was deleted).
 *
 * SECURITY: this projection OMITS `password` at the TYPE level (Omit<PppoeService,'password'>).
 * The list adapters never SELECT the secret into memory, so even a future `res.json(rawRepoOutput)`
 * can't leak it — defense in depth, not just a DTO-boundary strip.
 */
export interface PppoeServiceWithClient extends Omit<PppoeService, 'password'> {
  clientId: string | null;
  customerName: string | null;
}

export interface PppoeServiceRepository {
  /** Idempotente por `username`: crea o actualiza la fila existente. */
  upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService>;
  list(): Promise<PppoeService[]>;
  findById(id: string): Promise<PppoeService | null>;
  findByUsername(username: string): Promise<PppoeService | null>;
  /**
   * gestion-red-sessions — BATCH lookup por username, enriquecido con su cliente
   * (clientId + customerName via JOIN pppoe→contract→client). Resuelve el cruce de las
   * sesiones RADIUS activas en UNA sola query (`username IN (...)`), NUNCA N+1.
   * Solo devuelve filas que matchean algún username; el caller mapea por `username`
   * y deja en null las sesiones sin PppoeService. NUNCA expone el password (proyección WithClient).
   */
  findByUsernames(usernames: string[]): Promise<PppoeServiceWithClient[]>;
  findByContract(contractId: string): Promise<PppoeService[]>;
  /** PPPoE HUÉRFANOS: sin contrato asociado (contractId=null). El inventario por adoptar. */
  findUnassigned(): Promise<PppoeService[]>;
  /**
   * PPPoE ASIGNADOS: con contractId != null AND remoteAddress != null AND status = 'enabled'.
   * Fuente de datos para la tab Asignaciones (GET /api/ip-assignments).
   */
  findAssigned(): Promise<PppoeService[]>;
  /**
   * PPPoE del NE8000 Audit: servicios filtrados por nasId con paginación y filtros opcionales.
   * Orden: username ASC.
   */
  findByNasIdPaginated(params: {
    nasId: string;
    page: number;
    pageSize: number;
    username?: string;
    status?: string;
    enforcedState?: string;
  }): Promise<{ data: PppoeService[]; total: number }>;

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
   * internet-history — TODOS los PPPoE (la vista GLOBAL de internet, espejo de la página de TV),
   * enriquecidos con su cliente (clientId + customerName via JOIN pppoe→contract→client).
   * - `search`: coincidencia parcial case-insensitive sobre username, el nombre del cliente o
   *   `remoteAddress` (IP). pppoe-search-bulk-plan: si el término PARECE una MAC (`looksLikeMac`
   *   de `@domain/services/macSearch`), también matchea `callerId` con las variantes de formato
   *   (`aa:bb:…`, `aa-bb-…`, `aabb…`) en OR — la MAC persistida NO está normalizada en el BE.
   * - `displayStatus`: filtro por estado de NEGOCIO (active|reduced|blocked|baja|inactive). El adapter
   *   lo TRADUCE a su condición sobre (status crudo + enforcedState) en el WHERE — nunca post-paginación:
   *     active   → status='enabled' AND enforcedState='active'
   *     reduced  → enforcedState='reduced'
   *     blocked  → status='disabled' OR enforcedState='blocked'
   *     baja     → status='terminated'
   *     inactive → el resto (negación de todos los anteriores)
   * - `nasId`: filtro exacto por router.
   * - `includeUnassigned`: cuando `true`, NO aplica el filtro `contractId IS NOT NULL` →
   *   la lista incluye huérfanos (contractId=null). Default `false` = comportamiento actual.
   * - Orden estable: username asc.
   * - `total` = count con el MISMO where (sin skip/take) para el paginador del FE.
   */
  listAllPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    displayStatus?: PppoeDisplayStatus;
    nasId?: string;
    /** pppoe-full-management: cuando true, incluye PPPoE sin contrato (huérfanos). Default false. */
    includeUnassigned?: boolean;
  }): Promise<{ data: PppoeServiceWithClient[]; total: number }>;

  /**
   * pppoe-full-management: actualiza SOLO el `username` de un PPPoE (para recrear-username).
   * Preserva TODOS los demás campos (contractId, id, historial, etc.).
   * Devuelve la entidad actualizada, o null si el id no existe.
   */
  updateUsername(id: string, newUsername: string): Promise<PppoeService | null>;
  /**
   * pppoe-full-management (W3 — anti-TOCTOU): crea un PPPoE en el espejo rechazando si el username
   * ya existe. A diferencia de `upsertByUsername`, NUNCA sobreescribe una fila existente —
   * lanza `PppoeUsernameTakenError`. Previene la condición de carrera entre el chequeo de
   * unicidad y la persistencia en el standalone path (sin contractId).
   */
  createByUsername(data: PppoeServiceUpsert): Promise<PppoeService>;
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
   * Borrado HARD de la fila (baja total). Se llama DESPUÉS de confirmar que el plano de control
   * (RADIUS/router) eliminó al usuario. El username queda libre para ser re-ingresado en el futuro.
   * No-op si el id no existe.
   */
  deleteById(id: string): Promise<void>;
  /**
   * pppoe-pool-ip: actualiza SOLO `ipMode` y `remoteAddress` de un PPPoE (pin/unpin de IP fija).
   * NO toca password/profile/status. Devuelve la entidad actualizada, o null si no existe.
   */
  setIpMode(id: string, ipMode: 'pool' | 'fixed', remoteAddress: string | null): Promise<PppoeService | null>;
  /**
   * pppoe-move-nas fix wave 1 (ajuste 3 / S1.7 — anti-resurrección): actualiza SOLO
   * `nasId` + `remoteAddress` + `ipMode` de un PPPoE, POR ID y SIN crear. A diferencia de
   * `upsertByUsername`, si la fila fue borrada por un terminate/rename concurrente devuelve
   * `null` (typed not-found en el caller) en vez de re-INSERTAR la lápida.
   * NO toca password/profile/status/contractId/enforcedState.
   */
  setNasAndIp(id: string, nasId: string, remoteAddress: string | null, ipMode: 'pool' | 'fixed'): Promise<PppoeService | null>;
  /**
   * PPPoE de clientes con un `Client.status` dado (cruza pppoe→contract→client).
   * Es el resolver de `target='debtors'` (status='late') sin depender de RADIUS.
   */
  listByClientStatus(status: string): Promise<PppoeService[]>;
}
