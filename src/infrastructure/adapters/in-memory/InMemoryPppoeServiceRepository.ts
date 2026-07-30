import { randomUUID } from 'crypto';
import { PppoeService, EnforcedState, PppoeDisplayStatus, pppoeDisplayStatus, pickCurrentPppoeService } from '@domain/entities/pppoeService';
import { PppoeServiceRepository, PppoeServiceUpsert, PppoeServiceWithClient } from '@domain/ports/PppoeServiceRepository';
import type { IpKind } from '@domain/entities/network';
import { PppoeUsernameTakenError } from '@domain/errors/pppoe';
// pppoe-search-bulk-plan: MAC search helpers — SAME logic as Prisma adapter (parity).
import { looksLikeMac, macSearchVariants } from '@domain/services/macSearch';

/**
 * InMemoryPppoeServiceRepository — test seam para PppoeServiceRepository (pppoe-foundation + Fase C).
 * Array-backed. Upsert idempotente por `username`. `now()` inyectable.
 *
 * Fase C: `setEnforcedState` (no toca profile) + `listByClientStatus`. Como el repo de pppoe
 * no conoce Clients/Contracts, el cruce pppoe→client.status se siembra en tests con
 * `setContractClientStatus(contractId, status)` (test-only seam; en prod el JOIN lo hace Prisma).
 */
export class InMemoryPppoeServiceRepository implements PppoeServiceRepository {
  private readonly store: PppoeService[] = [];
  private readonly contractClientStatus = new Map<string, string>();
  private readonly contractClient = new Map<string, { clientId: string | null; customerName: string | null }>();
  private readonly now: () => Date;

  constructor(opts?: { now?: () => Date }) {
    this.now = opts?.now ?? (() => new Date());
  }

  /** Test seam: asocia un contractId con el status de su cliente (para listByClientStatus). */
  setContractClientStatus(contractId: string, status: string): void {
    this.contractClientStatus.set(contractId, status);
  }

  /** Test seam: asocia un contractId con su cliente (clientId+customerName) para listAllPaginated. */
  setContractClient(contractId: string, clientId: string | null, customerName: string | null): void {
    this.contractClient.set(contractId, { clientId, customerName });
  }

  async upsertByUsername(data: PppoeServiceUpsert): Promise<PppoeService> {
    const existing = this.store.find(s => s.username === data.username);
    if (existing) {
      existing.password = data.password;
      existing.profile = data.profile ?? null;
      existing.remoteAddress = data.remoteAddress ?? null;
      existing.status = data.status ?? 'enabled';
      existing.nasId = data.nasId;
      existing.contractId = data.contractId ?? null;
      if (data.enforcedState !== undefined) existing.enforcedState = data.enforcedState;
      if (data.ipMode !== undefined) existing.ipMode = data.ipMode;
      // pppoe-preprovision: solo se pisa si viene (mirror del adapter Prisma).
      if (data.ipTypePreference !== undefined) existing.ipTypePreference = data.ipTypePreference;
      return { ...existing };
    }
    const created: PppoeService = {
      id: randomUUID(),
      username: data.username,
      password: data.password,
      profile: data.profile ?? null,
      remoteAddress: data.remoteAddress ?? null,
      status: data.status ?? 'enabled',
      nasId: data.nasId,
      contractId: data.contractId ?? null,
      enforcedState: data.enforcedState ?? 'active',
      ipMode: data.ipMode ?? 'fixed',
      // pppoe-preprovision: default 'cgnat' (mirror del default del schema Prisma).
      ipTypePreference: data.ipTypePreference ?? 'cgnat',
      callerId: null,
      createdAt: this.now().toISOString(),
    };
    this.store.push(created);
    return { ...created };
  }

  async list(): Promise<PppoeService[]> {
    return this.store.map(s => ({ ...s }));
  }

  async findById(id: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    return found ? { ...found } : null;
  }

  async findByUsername(username: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.username === username);
    return found ? { ...found } : null;
  }

  async findByUsernames(usernames: string[]): Promise<PppoeServiceWithClient[]> {
    const set = new Set(usernames);
    // SECURITY: explicit projection WITHOUT `password` (mirrors the Prisma `select`).
    return this.store
      .filter(s => set.has(s.username))
      .map(s => {
        const client = s.contractId ? this.contractClient.get(s.contractId) : undefined;
        return {
          id:            s.id,
          username:      s.username,
          profile:       s.profile,
          remoteAddress: s.remoteAddress,
          status:        s.status,
          enforcedState: s.enforcedState,
          nasId:         s.nasId,
          contractId:    s.contractId,
          callerId:      s.callerId,
          ipMode:        s.ipMode,
          ipTypePreference: s.ipTypePreference,
          createdAt:     s.createdAt,
          clientId:      client?.clientId ?? null,
          customerName:  client?.customerName ?? null,
        };
      });
  }

  async findByContract(contractId: string): Promise<PppoeService[]> {
    return this.store.filter(s => s.contractId === contractId).map(s => ({ ...s }));
  }

  async findUnassigned(): Promise<PppoeService[]> {
    return this.store.filter(s => s.contractId === null).map(s => ({ ...s }));
  }

  async findAssigned(): Promise<PppoeService[]> {
    return this.store
      .filter(s => s.contractId !== null && s.remoteAddress !== null && s.nasId !== null && s.status === 'enabled')
      .map(s => ({ ...s }));
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
    const usernameLower = username ? username.toLowerCase() : undefined;

    const filtered = this.store.filter(s => {
      if (s.nasId !== nasId) return false;
      if (usernameLower && !s.username.toLowerCase().includes(usernameLower)) return false;
      if (status && s.status !== status) return false;
      if (enforcedState && s.enforcedState !== enforcedState) return false;
      return true;
    });

    const sorted = [...filtered].sort((a, b) => a.username.localeCompare(b.username));

    const total = sorted.length;
    const skip  = (page - 1) * pageSize;
    const data  = sorted.slice(skip, skip + pageSize).map(s => ({ ...s }));

    return { data, total };
  }

  async findAssignedPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    nasId?: string;
  }): Promise<{ data: PppoeService[]; total: number }> {
    const { page, pageSize, search, nasId } = params;
    const searchLower = search ? search.toLowerCase() : undefined;

    const filtered = this.store.filter(s => {
      if (s.contractId === null || s.remoteAddress === null || s.nasId === null || s.status !== 'enabled') return false;
      if (nasId && s.nasId !== nasId) return false;
      if (searchLower) {
        const matchUsername    = s.username.toLowerCase().includes(searchLower);
        const matchIp          = s.remoteAddress.toLowerCase().includes(searchLower);
        const matchContractId  = s.contractId.toLowerCase().includes(searchLower);
        if (!matchUsername && !matchIp && !matchContractId) return false;
      }
      return true;
    });

    // Stable order: username asc
    const sorted = [...filtered].sort((a, b) => a.username.localeCompare(b.username));

    const total = sorted.length;
    const skip  = (page - 1) * pageSize;
    const data  = sorted.slice(skip, skip + pageSize).map(s => ({ ...s }));

    return { data, total };
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
    const searchLower = search ? search.toLowerCase() : undefined;

    // SECURITY: build the projection explicitly WITHOUT `password` (mirrors the Prisma `select`).
    // `{ ...s }` would copy the secret into the list object at runtime even though the type omits it.
    const withClient = (s: PppoeService): PppoeServiceWithClient => {
      const client = s.contractId ? this.contractClient.get(s.contractId) : undefined;
      return {
        id:            s.id,
        username:      s.username,
        profile:       s.profile,
        remoteAddress: s.remoteAddress,
        status:        s.status,
        enforcedState: s.enforcedState,
        nasId:         s.nasId,
        contractId:    s.contractId,
        callerId:      s.callerId,
        ipMode:        s.ipMode,
        ipTypePreference: s.ipTypePreference,
        createdAt:     s.createdAt,
        clientId:      client?.clientId ?? null,
        customerName:  client?.customerName ?? null,
      };
    };

    const filtered = this.store.map(withClient).filter(s => {
      // pppoe-full-management: si includeUnassigned=true NO filtrar por contractId.
      // Default (false/omitido): solo PPPoE CON contrato (comportamiento actual — pina InternetServicesPage).
      if (!includeUnassigned && s.contractId === null) return false;
      // pppoe-preprovision D6.7: SOLO pendientes de instalación (nasId null) — espejo del
      // buildListAllWhere del adapter Prisma.
      if (pendingOnly && s.nasId !== null) return false;
      // BUSINESS-status filter: compute each row's display status and compare. Mirrors the Prisma
      // WHERE translation and stays consistent with the DTO (same precedence, single source of truth).
      if (displayStatus && pppoeDisplayStatus(s.status, s.enforcedState) !== displayStatus) return false;
      if (nasId && s.nasId !== nasId) return false;
      if (searchLower) {
        const matchUsername = s.username.toLowerCase().includes(searchLower);
        const matchClient   = (s.customerName ?? '').toLowerCase().includes(searchLower);
        // pppoe-search-bulk-plan: also match remoteAddress (IP partial, case-insensitive).
        const matchIp       = s.remoteAddress ? s.remoteAddress.toLowerCase().includes(searchLower) : false;
        // pppoe-search-bulk-plan: also match callerId (MAC) when search looks like a MAC.
        // Mirror of the Prisma adapter: same variants, same case-insensitive contains logic.
        // `search` is always defined here (we're inside the `if (searchLower)` block).
        let matchMac = false;
        if (s.callerId && search && looksLikeMac(search)) {
          const callerIdLower = s.callerId.toLowerCase();
          matchMac = macSearchVariants(search).some(v => callerIdLower.includes(v.toLowerCase()));
        }
        if (!matchUsername && !matchClient && !matchIp && !matchMac) return false;
      }
      return true;
    });

    const sorted = [...filtered].sort((a, b) => a.username.localeCompare(b.username));

    const total = sorted.length;
    const skip = (page - 1) * pageSize;
    const data = sorted.slice(skip, skip + pageSize).map(s => ({ ...s }));

    return { data, total };
  }

  /**
   * pppoe-bulk-select-filter (v2) — espejo EXACTO del filtrado de `listAllPaginated`
   * (MISMO helper `macSearch`, MISMA traducción de `displayStatus`, MISMO `contractId`/
   * `nasId`), sin paginar. `ids.length === total` siempre. La duplicación de la lógica de
   * filtro (en vez de un helper compartido en runtime) es intencional: el in-memory replica
   * la SEMÁNTICA del adapter Prisma, no su código — cada uno vive en su propio archivo
   * de adapter, igual que el resto del port (ver design.md "Hexagonal / DIP").
   */
  async listAllIds(params: {
    search?: string;
    displayStatus?: PppoeDisplayStatus;
    nasId?: string;
    includeUnassigned?: boolean;
    pendingOnly?: boolean;
  }): Promise<{ ids: string[]; total: number }> {
    const { search, displayStatus, nasId, includeUnassigned, pendingOnly } = params;
    const searchLower = search ? search.toLowerCase() : undefined;

    const withClient = (s: PppoeService): PppoeServiceWithClient => {
      const client = s.contractId ? this.contractClient.get(s.contractId) : undefined;
      return {
        id:            s.id,
        username:      s.username,
        profile:       s.profile,
        remoteAddress: s.remoteAddress,
        status:        s.status,
        enforcedState: s.enforcedState,
        nasId:         s.nasId,
        contractId:    s.contractId,
        callerId:      s.callerId,
        ipMode:        s.ipMode,
        ipTypePreference: s.ipTypePreference,
        createdAt:     s.createdAt,
        clientId:      client?.clientId ?? null,
        customerName:  client?.customerName ?? null,
      };
    };

    const filtered = this.store.map(withClient).filter(s => {
      if (!includeUnassigned && s.contractId === null) return false;
      // pppoe-preprovision D6.7: espejo EXACTO del filtro pendingOnly de listAllPaginated.
      if (pendingOnly && s.nasId !== null) return false;
      if (displayStatus && pppoeDisplayStatus(s.status, s.enforcedState) !== displayStatus) return false;
      if (nasId && s.nasId !== nasId) return false;
      if (searchLower) {
        const matchUsername = s.username.toLowerCase().includes(searchLower);
        const matchClient   = (s.customerName ?? '').toLowerCase().includes(searchLower);
        const matchIp       = s.remoteAddress ? s.remoteAddress.toLowerCase().includes(searchLower) : false;
        let matchMac = false;
        if (s.callerId && search && looksLikeMac(search)) {
          const callerIdLower = s.callerId.toLowerCase();
          matchMac = macSearchVariants(search).some(v => callerIdLower.includes(v.toLowerCase()));
        }
        if (!matchUsername && !matchClient && !matchIp && !matchMac) return false;
      }
      return true;
    });

    const sorted = [...filtered].sort((a, b) => a.username.localeCompare(b.username));
    return { ids: sorted.map(s => s.id), total: sorted.length };
  }

  async setContractId(id: string, contractId: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    found.contractId = contractId;
    return { ...found };
  }

  async clearContractId(id: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    found.contractId = null;
    return { ...found };
  }

  async setEnforcedState(id: string, state: EnforcedState): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    found.enforcedState = state;
    return { ...found };
  }

  async setCallerId(id: string, callerId: string): Promise<void> {
    const found = this.store.find(s => s.id === id);
    if (found) found.callerId = callerId;
  }

  async listByClientStatus(status: string): Promise<PppoeService[]> {
    return this.store
      .filter(s => s.contractId !== null && this.contractClientStatus.get(s.contractId) === status)
      .map(s => ({ ...s }));
  }

  /**
   * pppoe-move-nas (ajuste 3 — anti-resurrección): update NO-creador por id. Fila ausente → null.
   * pppoe-preprovision D7.3: `expectedNasId` PROVISTO ⇒ CAS por nasId actual (espejo del
   * `WHERE id AND nasId = ?` del adapter Prisma) — mismatch ⇒ null SIN tocar la fila.
   */
  async setNasAndIp(id: string, nasId: string, remoteAddress: string | null, ipMode: 'pool' | 'fixed', expectedNasId?: string | null, ipTypePreference?: IpKind): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    if (expectedNasId !== undefined && found.nasId !== expectedNasId) return null;
    found.nasId = nasId;
    found.remoteAddress = remoteAddress;
    found.ipMode = ipMode;
    // pppoe-move-ip-kind-aware: espejo EXACTO del adapter Prisma — la preferencia se toca SOLO
    // si el move convirtió la clase. Los dos adapters no pueden divergir.
    if (ipTypePreference !== undefined) found.ipTypePreference = ipTypePreference;
    return { ...found };
  }

  async deleteById(id: string): Promise<void> {
    const idx = this.store.findIndex(s => s.id === id);
    if (idx !== -1) this.store.splice(idx, 1);
  }

  /**
   * pppoe-full-management (W3): crea un PPPoE en el espejo rechazando si el username ya existe.
   * Lanza PppoeUsernameTakenError en vez de sobreescribir silenciosamente (anti-TOCTOU).
   */
  async createByUsername(data: PppoeServiceUpsert): Promise<PppoeService> {
    const existing = this.store.find(s => s.username === data.username);
    if (existing) throw new PppoeUsernameTakenError(data.username);
    return this.upsertByUsername(data);
  }

  /** pppoe-full-management: actualiza SOLO el username (para recrear-username). */
  async updateUsername(id: string, newUsername: string): Promise<PppoeService | null> {
    const found = this.store.find(s => s.id === id);
    if (!found) return null;
    found.username = newUsername;
    return { ...found };
  }

  /**
   * finance-growth fix-wave-2 — batch resolution using the SHARED domain
   * tie-break (`pickCurrentPppoeService`), never a locally-reimplemented
   * criterion (that's exactly what drifted from the Prisma adapter before).
   */
  async findCurrentProfilesByContractIds(contractIds: string[]): Promise<Map<string, string | null>> {
    const ids = new Set(contractIds);
    const byContract = new Map<string, PppoeService[]>();
    for (const s of this.store) {
      if (s.contractId === null || !ids.has(s.contractId)) continue;
      const list = byContract.get(s.contractId);
      if (list) list.push(s);
      else byContract.set(s.contractId, [s]);
    }
    const result = new Map<string, string | null>();
    for (const [contractId, rows] of byContract) {
      const winner = pickCurrentPppoeService(rows);
      if (winner) result.set(contractId, winner.profile ?? null);
    }
    return result;
  }
}
