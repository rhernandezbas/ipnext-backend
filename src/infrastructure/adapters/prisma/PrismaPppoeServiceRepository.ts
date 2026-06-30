import { PppoeService, EnforcedState, PppoeDisplayStatus } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert, PppoeServiceWithClient } from '@domain/ports/PppoeServiceRepository';
import { PppoeUsernameTakenError } from '@domain/errors/pppoe';
import { prisma } from '../../database/prisma';

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
    // pppoe-pool-ip: ipMode solo se escribe si viene (en create cae al default 'fixed' del schema).
    // CRÍTICO: sin esto, la rama pool de CreatePppoeService no persistiría ipMode='pool' en prod.
    if (data.ipMode !== undefined) fields['ipMode'] = data.ipMode;
    const row = await model().upsert({
      where: { username: data.username },
      create: { username: data.username, enforcedState: data.enforcedState ?? 'active', ...fields },
      update: fields,
    });
    return toEntity(row);
  }

  async list(): Promise<PppoeService[]> {
    const rows = await model().findMany();
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
  }): Promise<{ data: PppoeServiceWithClient[]; total: number }> {
    const { page, pageSize, search, displayStatus, nasId, includeUnassigned } = params;
    const skip = (page - 1) * pageSize;

    // Combine independent predicates with AND so two separate OR-clauses (search vs. blocked) never
    // collide on the same key. Each entry is its own where-fragment.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const and: Record<string, any>[] = [];
    // pppoe-full-management: solo filtrar por contractId IS NOT NULL cuando includeUnassigned=false (default).
    // FIXED filter: esta es la página de servicios de CLIENTES — solo PPPoE CON contrato.
    // Los huérfanos del ingest (contractId=null) NUNCA aparecen, ni cuentan para el total.
    if (!includeUnassigned) {
      and.push({ contractId: { not: null } });
    }
    if (nasId) and.push({ nasId });
    if (search) {
      // search matches username OR the contract's client name (JOIN through the relation).
      and.push({ OR: [
        { username: { contains: search, mode: 'insensitive' } },
        { contract: { is: { client: { is: { name: { contains: search, mode: 'insensitive' } } } } } },
      ] });
    }
    // BUSINESS-status → WHERE translation (same precedence as pppoeDisplayStatus). Always in the WHERE,
    // so pagination and total stay correct. 'inactive' = the negation of all the known buckets.
    if (displayStatus) and.push(displayStatusWhere(displayStatus));

    const where: Record<string, unknown> = and.length > 0 ? { AND: and } : {};

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
          createdAt: true,
          contract: { select: { clientId: true, client: { select: { name: true } } } },
        },
      }),
      model().count({ where }),
    ]);

    return { data: rows.map(toEntityWithClient), total };
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

  async setIpMode(id: string, ipMode: 'pool' | 'fixed', remoteAddress: string | null): Promise<PppoeService | null> {
    try {
      const row = await model().update({ where: { id }, data: { ipMode, remoteAddress } });
      return toEntity(row);
    } catch (err: any) {
      if (err?.code === 'P2025') return null; // fila inexistente → null; el resto PROPAGA
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
    nasId: row.nasId,
    contractId: row.contractId ?? null,
    callerId: row.callerId ?? null,
    ipMode: (row.ipMode ?? 'fixed') as 'pool' | 'fixed',
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
    nasId:         row.nasId,
    contractId:    row.contractId ?? null,
    callerId:      row.callerId ?? null,
    ipMode:        (row.ipMode ?? 'fixed') as 'pool' | 'fixed',
    createdAt:     new Date(row.createdAt).toISOString(),
    clientId:      row.contract?.clientId ?? null,
    customerName:  row.contract?.client?.name ?? null,
  };
}
