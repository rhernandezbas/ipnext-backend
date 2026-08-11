import type { ClientTvRegisterStatusRepository, TvRegisterStatusRow, TvRegisterStatusValue } from '@domain/ports/ClientTvRegisterStatusRepository';
import { prisma } from '../../database/prisma';

/**
 * Adapter Prisma de ClientTvRegisterStatusRepository (gigared-alta-asincrona W1.2).
 *
 * Persiste el estado del job de ALTA asíncrona en cuatro columnas nullable de Client:
 *   tvRegisterStatus      — TEXT?      ('pending'|'running'|'done'|'failed')
 *   tvRegisterResult      — JSONB?     (TvRegisterJobResult en done; {error} en failed)
 *   tvRegisterStartedAt   — TIMESTAMP? (cuándo se encoló; inmutable mientras el job vive)
 *   tvRegisterHeartbeatAt — TIMESTAMP? (última señal de vida: lease + fence token)
 *
 * ⚠️ Las DOS escrituras son `updateMany` con `WHERE` condicional y se ramifican por el `count`. Es
 * lo único que hace atómicas la reserva (dos POST concurrentes = dos `register` reales = cliente
 * quemado) y el fencing (un runner zombi pisando el estado del nuevo). Un `findUnique` + `update`
 * compilaría igual y pasaría todos los tests con el adapter in-memory: el race sólo aparecería en
 * producción. NO degradar a `update`.
 *
 * Usa `(prisma as any).client` para compilar antes de regenerar el cliente Prisma
 * (mismo patrón que PrismaClientTvCancelStatusRepository).
 *
 * El sync de GR NUNCA escribe estas columnas — son mirror-only.
 */
const VIVOS = ['pending', 'running'];

export class PrismaClientTvRegisterStatusRepository implements ClientTvRegisterStatusRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).client;
  }

  async getStatus(clientId: string): Promise<TvRegisterStatusRow | null> {
    const row: {
      tvRegisterStatus: string | null;
      tvRegisterResult: unknown;
      tvRegisterStartedAt: Date | null;
      tvRegisterHeartbeatAt: Date | null;
    } | null = await this.table.findUnique({
      where: { id: clientId },
      select: {
        tvRegisterStatus: true,
        tvRegisterResult: true,
        tvRegisterStartedAt: true,
        tvRegisterHeartbeatAt: true,
      },
    });
    if (!row || row.tvRegisterStatus === null) return null;
    return {
      status: row.tvRegisterStatus as TvRegisterStatusValue,
      result: row.tvRegisterResult as TvRegisterStatusRow['result'] ?? undefined,
      startedAt: row.tvRegisterStartedAt ?? undefined,
      heartbeatAt: row.tvRegisterHeartbeatAt ?? undefined,
    };
  }

  async tryReserve(clientId: string, startedAt: Date, ttlMs: number): Promise<boolean> {
    // El corte se calcula sobre el `startedAt` de ESTE intento, no sobre un now() propio: así el
    // reloj de la reserva y el que la ruta usa para el guard son el MISMO.
    const corte = new Date(startedAt.getTime() - ttlMs);
    const res: { count: number } = await this.table.updateMany({
      where: {
        id: clientId,
        OR: [
          // nunca se encoló un alta para este cliente
          { tvRegisterStatus: null },
          // el último alta terminó (done/failed) → re-encolable
          { tvRegisterStatus: { notIn: VIVOS } },
          // pending/running sin señal de vida desde hace más que el TTL → job huérfano.
          // NOTA: un heartbeat NULL no matchea `lt` en SQL, así que bloquea — misma decisión que
          // `isTvRegisterJobActive` toma para una fila sin sellos (lado seguro).
          { AND: [{ tvRegisterStatus: { in: VIVOS } }, { tvRegisterHeartbeatAt: { lt: corte } }] },
        ],
      },
      data: {
        tvRegisterStatus: 'pending',
        tvRegisterStartedAt: startedAt,
        tvRegisterHeartbeatAt: startedAt,
        // el error del intento anterior se limpia: si sobreviviera, el polling del alta nueva
        // mostraría el fallo de la vieja.
        tvRegisterResult: null,
      },
    });
    return res.count === 1;
  }

  async compareAndSet(clientId: string, expectedHeartbeatAt: Date, row: TvRegisterStatusRow): Promise<boolean> {
    const res: { count: number } = await this.table.updateMany({
      // El fence token es el heartbeat vigente: si otra generación reservó el alta, el sello cambió
      // y este write (de un runner zombi) NO aplica.
      where: { id: clientId, tvRegisterHeartbeatAt: expectedHeartbeatAt },
      data: {
        tvRegisterStatus: row.status,
        tvRegisterResult: row.result !== undefined ? (row.result as object) : null,
        tvRegisterStartedAt: row.startedAt ?? null,
        tvRegisterHeartbeatAt: row.heartbeatAt ?? null,
      },
    });
    return res.count === 1;
  }
}
