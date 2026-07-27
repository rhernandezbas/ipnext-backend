import { PppoeService, EnforcedState, PppoeDisplayStatus, pickCurrentPppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert, PppoeServiceWithClient } from '@domain/ports/PppoeServiceRepository';
import { PppoeUsernameTakenError } from '@domain/errors/pppoe';
import { prisma } from '../../database/prisma';
// pppoe-search-bulk-plan: MAC search helpers (pure domain, no infra deps).
import { looksLikeMac, macSearchVariants } from '@domain/services/macSearch';

/**
 * internet-history — traduce el estado de NEGOCIO a su predicado Prisma sobre (status crudo + enforcedState).
 * MISMA precedencia que pppoeDisplayStatus (domain). Va siempre en el WHERE (nunca post-paginación).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function displayStatusWhere(s: PppoeDisplayStatus): Record<string, any> {
  switch (s) {
    case 'baja':    return { status: 'terminated' };
    case 'blocked': return { status: { not: 'terminated' }, OR: [{ status: 'disabled' }, { enforcedState: 'blocked' }] };
    // reduced wins only AFTER baja/blocked are ruled out: not terminated, not disabled, not blocked-enforced.
    case 'reduced': return { status: { notIn: ['terminated', 'disabled'] }, enforcedState: 'reduced' };
    case 'active':  return { status: 'enabled', enforcedState: 'active' };
    // 'inactive' = la negación de todos los buckets conocidos: no terminated, no disabled, no blocked,
    // no reduced, y no (enabled+active). En la práctica: status NOT IN (terminated,disabled,enabled)
    // con enforcedState active, o cualquier combinación residual.
    case 'inactive': return {
      NOT: [
        { status: 'terminated' },
        { status: 'disabled' },
        { enforcedState: 'blocked' },
        { enforcedState: 'reduced' },
        { status: 'enabled', enforcedState: 'active' },
      ],
    };
  }
}

/**
 * PrismaPppoeServiceRepository — adapter de persistencia (pppoe-foundation + Fase C).
 * Usa el singleton `prisma` (patrón del proyecto, igual que PrismaNasRepository).
 * `(prisma as any).pppoeService`: el client local no está regenerado (el Dockerfile corre
 * `prisma generate` en build → en prod tipa bien). Gotcha documentado en WORKFLOW-MULTI-REPO.
 */
function model() {
  return (prisma as any).pppoeService;
}

/**
 * pppoe-bulk-select-filter (v2) — WHERE-builder COMPARTIDO entre `listAllPaginated` y
 * `listAllIds` (design Decisión 1, Opción C). Extraído SIN cambio de comportamiento del
 * bloque que antes vivía inline en `listAllPaginated` (:206-243 pre-refactor). Es el
 * ÚNICO lugar donde se arma este WHERE — por construcción, ambos métodos NUNCA pueden
 * driftear entre sí (el guardrail del riesgo #1 del change).
 *
 * Combine independent predicates with AND so two separate OR-clauses (search vs. blocked)
 * never collide on the same key. Each entry is its own where-fragment.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildListAllWhere(params: {
  search?: string;
  displayStatus?: PppoeDisplayStatus;
  nasId?: string;
  includeUnassigned?: boolean;
  pendingOnly?: boolean;
}): Record<string, any> {
  const { search, displayStatus, nasId, includeUnassigned, pendingOnly } = params;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const and: Record<string, any>[] = [];
  // pppoe-full-management: solo filtrar por contractId IS NOT NULL cuando includeUnassigned=false (default).
  // FIXED filter: esta es la página de servicios de CLIENTES — solo PPPoE CON contrato.
  // Los huérfanos del ingest (contractId=null) NUNCA aparecen, ni cuentan para el total.
  if (!includeUnassigned) {
    and.push({ contractId: { not: null } });
  }
  // pppoe-preprovision D6.7: SOLO pendientes de instalación (nasId IS NULL). Vive en el
  // WHERE-builder COMPARTIDO → paridad listado/ids POR CONSTRUCCIÓN (mismo guardrail que el
  // resto de los filtros). Compositivo: pendingOnly + nasId=X da AND contradictorio (vacío).
  if (pendingOnly) and.push({ nasId: null });
  if (nasId) and.push({ nasId });
  if (search) {
    // pppoe-search-bulk-plan: search matches username OR client name (existing), AND NOW ALSO
    // remoteAddress (IP, partial, always) + callerId variants when the term looks like a MAC.
    // All OR fragments are under a single AND entry to avoid colliding with displayStatus/contractId.
    const searchOr: Record<string, unknown>[] = [
      { username: { contains: search, mode: 'insensitive' } },
      { contract: { is: { client: { is: { name: { contains: search, mode: 'insensitive' } } } } } },
      // IP: partial, case-insensitive (IPs are stored canonical so case is N/A but consistent).
      { remoteAddress: { contains: search, mode: 'insensitive' } },
    ];

    // MAC: only add callerId OR-branches when the search term looks like a MAC (hex-only after
    // stripping MAC separators, 4-12 chars). Generates ≤4 variants (raw, colon, dash, plain)
    // each as a `contains mode:insensitive` (covers both upper/lowercase in the DB).
    if (looksLikeMac(search)) {
      for (const variant of macSearchVariants(search)) {
        searchOr.push({ callerId: { contains: variant, mode: 'insensitive' } });
      }
    }

    and.push({ OR: searchOr });
  }
  // BUSINESS-status → WHERE translation (same precedence as pppoeDisplayStatus). Always in the WHERE,
  // so pagination and total stay correct. 'inactive' = the negation of all the known buckets.
  if (displayStatus) and.push(displayStatusWhere(displayStatus));

  return and.length > 0 ? { AND: and } : {};
}

export class PrismaPppoeServiceRepository implements PppoeServiceRepository {
  async upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService> {
    const fields: Record<string, unknown> = {
      password: data.password,
      profile: data.profile ?? null,
      remoteAddress: data.remoteAddress ?? null,
      status: data.status ?? 'enabled',
      nasId: data.nasId,
      contractId: data.contractId ?? null,
      // GUARD: callerId NO se incluye acá a propósito. Es Prominense-owned (la MAC de la última
      // sesión vista) y se persiste aparte vía setCallerId() — el ingest desde GET /users NUNCA lo pisa.
    };
    // enforcedState: solo se escribe si viene (en create cae al default 'active' del schema).
    if (data.enforcedState !== undefined) fields['enforcedState'] = data.enforcedState;
    // ipMode solo se escribe si viene (en create cae al default 'fixed' del schema).
    // sqlippool-cleanup: el modo pool fue descartado — toda alta actual escribe 'fixed';
    // el campo se conserva en el modelo/DTO (persistencia de la IP fija).
    if (data.ipMode !== undefined) fields['ipMode'] = data.ipMode;
    // pppoe-preprovision: idem — solo si viene (en create cae al default 'cgnat' del schema).
    if (data.ipTypePreference !== undefined) fields['ipTypePreference'] = data.ipTypePreference;
    const row = await model().upsert({
      where: { username: data.username },
      create: { username: data.username, enforcedState: data.enforcedState ?? 'active', ...fields },
      update: fields,
    });
    return toEntity(row);
  }

  async list(): Promise<PppoeService[]> {
    // review M1 (contract-node-ap-auto-assign): defensa en profundidad — findMany() SIN orderBy
    // devuelve orden de heap de Postgres (puede cambiar con updates reales entre corridas).
    // AutoAssignContractNetwork ya desempata por `id` si `createdAt` empata, así que esto no es
    // estrictamente necesario para su correctitud, pero deja el propio `list()` determinístico
    // para cualquier consumidor futuro.
    const rows = await model().findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toEntity);
  }

  async findById(id: string): Promise<PppoeService | null> {
    const row = await model().findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findByUsername(username: string): Promise<PppoeService | null> {
    const row = await model().findUnique({ where: { username } });
    return row ? toEntity(row) : null;
  }

  async findByUsernames(usernames: string[]): Promise<PppoeServiceWithClient[]> {
    if (usernames.length === 0) return [];
    const rows = await model().findMany({
      where: { username: { in: usernames } },
      // SECURITY: explicit `select` (NOT `include`) — the PPPoE `password` is NEVER read into memory.
      // Includes the JOIN pppoe → contract → client for clientId + customerName, same as listAllPaginated.
      select: {
        id: true,
        username: true,
        profile: true,
        remoteAddress: true,
        status: true,
        enforcedState: true,
        nasId: true,
        contractId: true,
        callerId: true,
        ipMode: true,
        ipTypePreference: true,
        createdAt: true,
        contract: { select: { clientId: true, client: { select: { name: true } } } },
      },
    });
    return rows.map(toEntityWithClient);
  }

  async findByContract(contractId: string): Promise<PppoeService[]> {
    const rows = await model().findMany({ where: { contractId } });
    return rows.map(toEntity);
  }

  async findUnassigned(): Promise<PppoeService[]> {
    const rows = await model().findMany({ where: { contractId: null } });
    return rows.map(toEntity);
  }

  async findAssigned(): Promise<PppoeService[]> {
    const rows = await model().findMany({
      where: {
        contractId: { not: null },
        remoteAddress: { not: null },
        // pppoe-preprovision: un pendiente (nasId null) jamás es una asignación.
        nasId: { not: null },
        status: 'enabled',
      },
    });
    return rows.map(toEntity);
  }

  async findByNasIdPaginated(params: {
    nasId: string;
    page: number;
    pageSize: number;
    username?: string;
    status?: string;
    enforcedState?: string;
  }): Promise<{ data: PppoeService[]; total: number }> {
    const { nasId, page, pageSize, username, status, enforcedState } = params;
    const skip = (page - 1) * pageSize;

    const where: Record<string, unknown> = { nasId };
    if (username) where['username'] = { contains: username, mode: 'insensitive' };
    if (status)        where['status']        = status;
    if (enforcedState) where['enforcedState'] = enforcedState;

    const [rows, total] = await Promise.all([
      model().findMany({
        where,
        orderBy: { username: 'asc' },
        skip,
        take: pageSize,
      }),
      model().count({ where }),
    ]);

    return { data: rows.map(toEntity), total };
  }

  async findAssignedPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    nasId?: string;
  }): Promise<{ data: PppoeService[]; total: number }> {
    const { page, pageSize, search, nasId } = params;
    const skip = (page - 1) * pageSize;

    const baseWhere: Record<string, unknown> = {
      contractId:    { not: null },
      remoteAddress: { not: null },
      // pppoe-preprovision: un pendiente (nasId null) jamás es una asignación.
      nasId:         { not: null },
      status:        'enabled',
    };
    if (nasId) baseWhere['nasId'] = nasId;
    if (search) {
      baseWhere['OR'] = [
        { username:      { contains: search, mode: 'insensitive' } },
        { remoteAddress: { contains: search, mode: 'insensitive' } },
        { contractId:    { contains: search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      model().findMany({
        where:   baseWhere,
        orderBy: { username: 'asc' },
        skip,
        take: pageSize,
      }),
      model().count({ where: baseWhere }),
    ]);

    return { data: rows.map(toEntity), total };
  }

  async listAllPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    displayStatus?: PppoeDisplayStatus;
    nasId?: string;
    includeUnassigned?: boolean;
    pendingOnly?: boolean;
  }): Promise<{ data: PppoeServiceWithClient[]; total: number }> {
    const { page, pageSize, search, displayStatus, nasId, includeUnassigned, pendingOnly } = params;
    const skip = (page - 1) * pageSize;

    // pppoe-bulk-select-filter (v2): WHERE compartido con listAllIds — ÚNICA fuente de
    // verdad del filtro (design Decisión 1). NUNCA reconstruir este WHERE inline acá.
    const where = buildListAllWhere({ search, displayStatus, nasId, includeUnassigned, pendingOnly });

    const [rows, total] = await Promise.all([
      model().findMany({
        where,
        orderBy: { username: 'asc' },
        skip,
        take: pageSize,
        // SECURITY: explicit `select` (NOT `include`) so the PPPoE `password` is NEVER read into
        // memory for the list — defense in depth. Lists only the fields toEntityWithClient needs
        // + the JOIN pppoe → contract → client for clientId + customerName.
        select: {
          id: true,
          username: true,
          profile: true,
          remoteAddress: true,
          status: true,
          enforcedState: true,
          nasId: true,
          contractId: true,
          callerId: true,
          ipMode: true,
          ipTypePreference: true,
          createdAt: true,
          contract: { select: { clientId: true, client: { select: { name: true } } } },
        },
      }),
      model().count({ where }),
    ]);

    return { data: rows.map(toEntityWithClient), total };
  }

  /**
   * pppoe-bulk-select-filter (v2) — reusa el MISMO `buildListAllWhere` que `listAllPaginated`
   * (paridad garantizada por construcción). Proyección liviana (`select: { id: true }`, SIN el
   * JOIN cliente): este método alimenta la selección masiva del bulk, no una grilla.
   */
  async listAllIds(params: {
    search?: string;
    displayStatus?: PppoeDisplayStatus;
    nasId?: string;
    includeUnassigned?: boolean;
    pendingOnly?: boolean;
  }): Promise<{ ids: string[]; total: number }> {
    const where = buildListAllWhere(params);

    const [rows, total] = await Promise.all([
      model().findMany({
        where,
        orderBy: { username: 'asc' },
        select: { id: true },
      }),
      model().count({ where }),
    ]);

    return { ids: rows.map((r: { id: string }) => r.id), total };
  }

  async setContractId(id: string, contractId: string): Promise<PppoeService | null> {
    try {
      const row = await model().update({ where: { id }, data: { contractId } });
      return toEntity(row);
    } catch (err: any) {
      if (err?.code === 'P2025') return null; // fila inexistente → null; el resto PROPAGA
      throw err;
    }
  }

  async clearContractId(id: string): Promise<PppoeService | null> {
    try {
      const row = await model().update({ where: { id }, data: { contractId: null } });
      return toEntity(row);
    } catch (err: any) {
      if (err?.code === 'P2025') return null;
      throw err;
    }
  }

  async setCallerId(id: string, callerId: string): Promise<void> {
    await model().update({ where: { id }, data: { callerId } });
  }

  /**
   * pppoe-move-nas (ajuste 3 — anti-resurrección): update NO-creador por id para el move.
   * P2025 (fila borrada por terminate/rename concurrente) → null; el caller lanza el typed
   * not-found SIN re-crear la lápida. Cualquier otro error de infra PROPAGA (el caller registra
   * el evento `failed_db` — el RADIUS ya quedó escrito y la divergencia necesita rastro).
   *
   * pppoe-preprovision D7.3: `expectedNasId` PROVISTO ⇒ CAS ATÓMICO por nasId actual —
   * `WHERE id = ? AND nasId = ?` (extended where unique; con `null` ⇒ `nasId IS NULL`, la
   * adopción de un pendiente). Condición sin match ⇒ P2025 ⇒ null (el caller distingue
   * "fila borrada" vs "carrera doble-adopción perdida" re-leyendo por id).
   */
  async setNasAndIp(id: string, nasId: string, remoteAddress: string | null, ipMode: 'pool' | 'fixed', expectedNasId?: string | null): Promise<PppoeService | null> {
    try {
      const where = expectedNasId !== undefined ? { id, nasId: expectedNasId } : { id };
      const row = await model().update({ where, data: { nasId, remoteAddress, ipMode } });
      return toEntity(row);
    } catch (err: any) {
      if (err?.code === 'P2025') return null;
      throw err;
    }
  }

  async setEnforcedState(id: string, state: EnforcedState): Promise<PppoeService | null> {
    try {
      const row = await model().update({ where: { id }, data: { enforcedState: state } });
      return toEntity(row);
    } catch (err: any) {
      // SOLO la fila inexistente se traga como null. Un error de infra (conexión caída, etc.)
      // debe PROPAGARSE: tras cortar en el router, mentir "confirmado" sería peor que fallar.
      if (err?.code === 'P2025') return null;
      throw err;
    }
  }

  async listByClientStatus(status: string): Promise<PppoeService[]> {
    // JOIN pppoe → contract → client; el status del cliente determina el deudor (sin RADIUS).
    const rows = await model().findMany({
      where: { contract: { client: { status } } },
    });
    return rows.map(toEntity);
  }

  async deleteById(id: string): Promise<void> {
    try {
      await model().delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === 'P2025') return; // ya no existe — no-op
      throw err;
    }
  }

  /** pppoe-full-management: actualiza SOLO el username (para recrear-username). */
  async createByUsername(data: PppoeServiceUpsert): Promise<PppoeService> {
    const fields: Record<string, unknown> = {
      password: data.password,
      profile: data.profile ?? null,
      remoteAddress: data.remoteAddress ?? null,
      status: data.status ?? 'enabled',
      nasId: data.nasId,
      contractId: data.contractId ?? null,
      enforcedState: data.enforcedState ?? 'active',
    };
    if (data.ipMode !== undefined) fields['ipMode'] = data.ipMode;
    // pppoe-preprovision: solo si viene (en create cae al default 'cgnat' del schema).
    if (data.ipTypePreference !== undefined) fields['ipTypePreference'] = data.ipTypePreference;
    try {
      const row = await model().create({ data: { username: data.username, ...fields } });
      return toEntity(row);
    } catch (err: any) {
      if (err?.code === 'P2002') throw new PppoeUsernameTakenError(data.username);
      throw err;
    }
  }

  async updateUsername(id: string, newUsername: string): Promise<PppoeService | null> {
    try {
      const updated = await model().update({
        where: { id },
        data: { username: newUsername },
      });
      return toEntity(updated);
    } catch (err: any) {
      if (err?.code === 'P2025') return null; // no existe
      throw err;
    }
  }

  /**
   * finance-growth fix-wave-2 — ONE batch query (`contractId IN (...)`),
   * never N+1. Tie-break for contracts with multiple rows delegates to the
   * SHARED domain helper `pickCurrentPppoeService` — the exact same function
   * `InMemoryPppoeServiceRepository` calls, so the two adapters cannot drift
   * on this criterion.
   *
   * fix-wave-3 (🟡 3 + 🔵 secrets) — two fixes on top:
   *  1. `orderBy: [{createdAt:'desc'},{id:'asc'}]` — defense in depth (same
   *     convention as `list()` above). The REAL determinism guarantee is
   *     `pickCurrentPppoeService`'s own `id` tiebreak (it re-sorts the FULL
   *     result regardless of fetch order), but this keeps the query itself
   *     aligned with the rest of the adapter. Before this, `findMany()` with
   *     NO `orderBy` returned Postgres's heap-scan order — not guaranteed
   *     stable across runs — and a genuine `createdAt` tie (e.g. bulk-import
   *     rows created in the same millisecond) used to resolve by whatever
   *     order the rows happened to arrive in, measured to flip the same
   *     month's MRR between 10000 and 15000 across two runs.
   *  2. Explicit `select` (SECURITY) — this projection exists ONLY to
   *     resolve a plan CODE; `password` (and every other PPPoE field this
   *     use case doesn't need) is NEVER read into memory. Same convention as
   *     `findByUsernames` above. Before this fix, a bare `findMany({ where })`
   *     pulled every column — including the RADIUS `password` — for EVERY
   *     PPPoE row of EVERY contract touched by a finance snapshot run (once
   *     per month × up to 163 months in a full backfill).
   */
  async findCurrentProfilesByContractIds(contractIds: string[]): Promise<Map<string, string | null>> {
    if (contractIds.length === 0) return new Map();
    const rows: Array<{ id: string; contractId: string | null; profile: string | null; status: string; createdAt: Date | string }> =
      await model().findMany({
        where: { contractId: { in: contractIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true, contractId: true, profile: true, status: true, createdAt: true },
      });
    const byContract = new Map<string, Array<{ id: string; profile: string | null; status: string; createdAt: string }>>();
    for (const row of rows) {
      if (row.contractId === null) continue;
      const entry = { id: row.id, profile: row.profile ?? null, status: row.status, createdAt: new Date(row.createdAt).toISOString() };
      const list = byContract.get(row.contractId);
      if (list) list.push(entry);
      else byContract.set(row.contractId, [entry]);
    }
    const result = new Map<string, string | null>();
    for (const [contractId, contractRows] of byContract) {
      const winner = pickCurrentPppoeService(contractRows);
      if (winner) result.set(contractId, winner.profile ?? null);
    }
    return result;
  }
}

function toEntity(row: any): PppoeService {
  return {
    id: row.id,
    username: row.username,
    password: row.password,
    profile: row.profile ?? null,
    remoteAddress: row.remoteAddress ?? null,
    status: row.status,
    enforcedState: (row.enforcedState ?? 'active') as EnforcedState,
    nasId: row.nasId ?? null,
    contractId: row.contractId ?? null,
    callerId: row.callerId ?? null,
    ipMode: (row.ipMode ?? 'fixed') as 'pool' | 'fixed',
    ipTypePreference: (row.ipTypePreference ?? 'cgnat') as 'cgnat' | 'public',
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEntityWithClient(row: any): PppoeServiceWithClient {
  // SECURITY: built field-by-field WITHOUT `password` — the list `select` never fetched it.
  // Do NOT spread toEntity(row) here: that would re-introduce a `password` key (as undefined).
  return {
    id:            row.id,
    username:      row.username,
    profile:       row.profile ?? null,
    remoteAddress: row.remoteAddress ?? null,
    status:        row.status,
    enforcedState: (row.enforcedState ?? 'active') as EnforcedState,
    nasId:         row.nasId ?? null,
    contractId:    row.contractId ?? null,
    callerId:      row.callerId ?? null,
    ipMode:        (row.ipMode ?? 'fixed') as 'pool' | 'fixed',
    ipTypePreference: (row.ipTypePreference ?? 'cgnat') as 'cgnat' | 'public',
    createdAt:     new Date(row.createdAt).toISOString(),
    clientId:      row.contract?.clientId ?? null,
    customerName:  row.contract?.client?.name ?? null,
  };
}
