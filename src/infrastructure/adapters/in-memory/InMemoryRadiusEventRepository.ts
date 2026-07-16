import { randomUUID } from 'crypto';
import { RadiusEvent } from '@domain/entities/radius-event';
import {
  RadiusEventRepository,
  RadiusEventFilters,
  RadiusEventUpsert,
  PaginatedResult,
  LastConnectionSummary,
} from '@domain/ports/RadiusEventRepository';

/**
 * InMemoryRadiusEventRepository — test seam para RadiusEventRepository.
 *
 * - upsertMany es idempotente por `sourceUniqueId` (Map-backed).
 * - list aplica todos los filtros declarados en RadiusEventFilters.
 * - lastEventByUsername devuelve el evento con startedAt más reciente por username+nasId.
 * - deleteOlderThan elimina por startedAt < cutoff (retención).
 */
export class InMemoryRadiusEventRepository implements RadiusEventRepository {
  /** Map sourceUniqueId → RadiusEvent (almacenado con valores de dominio) */
  private readonly store = new Map<string, RadiusEvent>();

  async upsertMany(rows: RadiusEventUpsert[]): Promise<number> {
    for (const row of rows) {
      const existing = this.store.get(row.sourceUniqueId);
      const event: RadiusEvent = existing
        ? {
            // ── UPDATE: campos INMUTABLES preservados del registro existente (fidelidad con Prisma) ──
            // FIX7: Prisma NO incluye username/nasIpAddress/startedAt en el update block porque
            // son identidad de la sesión RADIUS (el acctstarttime/username no cambian al cerrar).
            // El in-memory debe comportarse igual para que los tests en-memoria sean fieles.
            id:             existing.id,
            sourceUniqueId: existing.sourceUniqueId,
            username:       existing.username,       // INMUTABLE
            nasIpAddress:   existing.nasIpAddress,   // INMUTABLE
            startedAt:      existing.startedAt,      // INMUTABLE
            createdAt:      existing.createdAt,      // INMUTABLE
            // ── Campos MUTABLES: se actualizan ─────────────────────────────────
            nasId:          row.nasId,
            framedIp:       row.framedIp,
            macAddress:     row.macAddress,
            vlanId:         row.vlanId,
            stoppedAt:      row.stoppedAt ? row.stoppedAt.toISOString() : null,
            sessionTime:    row.sessionTime,
            bytesIn:        row.bytesIn,
            bytesOut:       row.bytesOut,
            eventType:      row.eventType,
            status:         row.status,
            updatedAt:      new Date().toISOString(),
          }
        : {
            // ── INSERT: todos los campos del row ─────────────────────────────
            id:             randomUUID(),
            sourceUniqueId: row.sourceUniqueId,
            username:       row.username,
            nasIpAddress:   row.nasIpAddress,
            nasId:          row.nasId,
            framedIp:       row.framedIp,
            macAddress:     row.macAddress,
            vlanId:         row.vlanId,
            startedAt:      row.startedAt.toISOString(),
            stoppedAt:      row.stoppedAt ? row.stoppedAt.toISOString() : null,
            sessionTime:    row.sessionTime,
            bytesIn:        row.bytesIn,
            bytesOut:       row.bytesOut,
            eventType:      row.eventType,
            status:         row.status,
            createdAt:      new Date().toISOString(),
            updatedAt:      new Date().toISOString(),
          };
      this.store.set(row.sourceUniqueId, event);
    }
    return rows.length;
  }

  async list(filters: RadiusEventFilters): Promise<PaginatedResult<RadiusEvent>> {
    let items = [...this.store.values()];

    if (filters.username !== undefined) {
      items = items.filter((e) => e.username === filters.username);
    }
    if (filters.nasId !== undefined) {
      items = items.filter((e) => e.nasId === filters.nasId);
    }
    if (filters.vlanId !== undefined) {
      items = items.filter((e) => e.vlanId === filters.vlanId);
    }
    if (filters.status !== undefined) {
      items = items.filter((e) => e.status === filters.status);
    }
    if (filters.eventType !== undefined) {
      items = items.filter((e) => e.eventType === filters.eventType);
    }
    if (filters.from !== undefined) {
      const fromMs = filters.from.getTime();
      items = items.filter((e) => new Date(e.startedAt).getTime() >= fromMs);
    }
    if (filters.to !== undefined) {
      const toMs = filters.to.getTime();
      items = items.filter((e) => new Date(e.startedAt).getTime() <= toMs);
    }

    // FIX3: orden DESC igual que PrismaRadiusEventRepository (startedAt DESC, sourceUniqueId ASC).
    // El orden debe vivir en el REPO, no en el use case, para que la paginación cross-página
    // sea correcta (antes: InMemory ASC + use case re-ordena solo la página → cross-página roto).
    items.sort((a, b) => {
      const cmp = b.startedAt.localeCompare(a.startedAt);
      return cmp !== 0 ? cmp : a.sourceUniqueId.localeCompare(b.sourceUniqueId);
    });

    const total = items.length;
    const { page, pageSize } = filters;
    const skip  = (page - 1) * pageSize;
    const data  = items.slice(skip, skip + pageSize).map((e) => ({ ...e }));

    return { data, total, page, pageSize };
  }

  async lastEventByUsername(
    nasId: string,
    usernames: string[],
  ): Promise<Map<string, LastConnectionSummary>> {
    const result = new Map<string, LastConnectionSummary>();
    if (usernames.length === 0) return result;

    const usernameSet = new Set(usernames);

    // Acumulamos por username: el evento más reciente (cualquier tipo) + el último cerrado
    const latestByUser  = new Map<string, RadiusEvent>();
    const lastClosedByUser = new Map<string, RadiusEvent>();
    const hasOnlineByUser  = new Map<string, boolean>();

    for (const event of this.store.values()) {
      if (event.nasId !== nasId) continue;
      if (!usernameSet.has(event.username)) continue;

      // Evento más reciente (cualquier tipo)
      const current = latestByUser.get(event.username);
      if (!current || event.startedAt > current.startedAt) {
        latestByUser.set(event.username, event);
      }

      // Último evento cerrado
      if (event.stoppedAt !== null) {
        const lastClosed = lastClosedByUser.get(event.username);
        if (!lastClosed || event.startedAt > lastClosed.startedAt) {
          lastClosedByUser.set(event.username, event);
        }
      }

      // ¿Tiene alguna sesión activa?
      if (event.stoppedAt === null) {
        hasOnlineByUser.set(event.username, true);
      }
    }

    for (const username of usernameSet) {
      const latest = latestByUser.get(username);
      if (!latest) continue;

      const lastClosed = lastClosedByUser.get(username);
      const summary: LastConnectionSummary = {
        lastStartedAt:  latest.startedAt,
        lastStoppedAt:  lastClosed ? lastClosed.stoppedAt : null,
        currentlyOnline: hasOnlineByUser.get(username) ?? false,
        lastFramedIp:   latest.framedIp,
        lastVlanId:     latest.vlanId,
      };
      result.set(username, summary);
    }

    return result;
  }

  /**
   * CAS-1 — réplica JS de la semántica Prisma `DISTINCT ON (username) ... ORDER BY username,
   * ("stoppedAt" IS NULL) DESC, "startedAt" DESC`: por username, gana el evento online
   * (stoppedAt IS NULL); si no hay ninguno, el de startedAt más reciente. Solo eventos con
   * macAddress != null entran en la comparación. Usernames sin ningún evento con mac quedan
   * AUSENTES del Map.
   */
  async latestMacByUsernames(usernames: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (usernames.length === 0) return result;
    const usernameSet = new Set(usernames);

    const best = new Map<string, { isOnline: boolean; startedAt: string; mac: string }>();

    for (const event of this.store.values()) {
      if (!usernameSet.has(event.username)) continue;
      if (event.macAddress === null) continue;

      const isOnline = event.stoppedAt === null;
      const current = best.get(event.username);

      if (!current) {
        best.set(event.username, { isOnline, startedAt: event.startedAt, mac: event.macAddress });
        continue;
      }
      if (isOnline && !current.isOnline) {
        best.set(event.username, { isOnline, startedAt: event.startedAt, mac: event.macAddress });
        continue;
      }
      if (!isOnline && current.isOnline) {
        continue; // el online ya ganador se mantiene
      }
      // Mismo "nivel" online/closed: gana el startedAt más reciente.
      if (event.startedAt > current.startedAt) {
        best.set(event.username, { isOnline, startedAt: event.startedAt, mac: event.macAddress });
      }
    }

    for (const [username, entry] of best) {
      result.set(username, entry.mac);
    }

    return result;
  }

  async deleteOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    const cutoffMs = cutoff.getTime();
    let deleted = 0;

    for (const [key, event] of this.store.entries()) {
      // FIX6/FIX7: respetar batchSize — igual que Prisma que hace findMany(take: batchSize).
      // Esto permite que el use case detecte "hay más por borrar" cuando deleted === batchSize.
      if (deleted >= batchSize) break;
      if (new Date(event.startedAt).getTime() < cutoffMs) {
        this.store.delete(key);
        deleted++;
      }
    }

    return deleted;
  }
}
