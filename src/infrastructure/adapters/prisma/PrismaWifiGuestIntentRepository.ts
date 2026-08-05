import { prisma } from '../../database/prisma';
import type {
  WifiGuestIntent,
  WifiGuestIntentAction,
  WifiGuestIntentRepository,
  ReplaceWifiGuestIntentInput,
} from '@domain/ports/WifiGuestIntentRepository';

interface WifiGuestIntentRow {
  id: string;
  sn: string;
  action: string;
  port: string;
  since: Date;
  retriedAt: Date | null;
}

function toEntity(row: WifiGuestIntentRow): WifiGuestIntent {
  return {
    id: row.id,
    sn: row.sn,
    // Basura al valor SEGURO: un action desconocido cae a 'creating' — se
    // autolimpia a los 10 min sin verificar ni re-pushear nada.
    action: row.action === 'deleting' ? 'deleting' : ('creating' as WifiGuestIntentAction),
    port: row.port,
    since: row.since.toISOString(),
    retriedAt: row.retriedAt ? row.retriedAt.toISOString() : null,
  };
}

/**
 * wifi-guest-pending — registro Prisma del intent de cambio de la red de
 * visitas. `replace` = upsert por el unique `sn` (UN intent por ONU): el
 * reintento sobre un 'unconfirmed' PISA el intent viejo y resetea `retriedAt`
 * a null (presupuesto de re-push fresco). Mismo molde que
 * `PrismaOnuWifiCredentialRepository`.
 */
export class PrismaWifiGuestIntentRepository implements WifiGuestIntentRepository {
  async findBySn(sn: string): Promise<WifiGuestIntent | null> {
    const row = await prisma.wifiGuestIntent.findUnique({ where: { sn } });
    return row ? toEntity(row as unknown as WifiGuestIntentRow) : null;
  }

  async replace(input: ReplaceWifiGuestIntentInput): Promise<WifiGuestIntent> {
    const row = await prisma.wifiGuestIntent.upsert({
      where: { sn: input.sn },
      create: {
        sn: input.sn,
        action: input.action,
        port: input.port,
        since: new Date(input.since),
      },
      update: {
        action: input.action,
        port: input.port,
        since: new Date(input.since),
        retriedAt: null,
      },
    });
    return toEntity(row as unknown as WifiGuestIntentRow);
  }

  async markRetried(id: string, retriedAtIso: string): Promise<void> {
    await prisma.wifiGuestIntent.update({
      where: { id },
      data: { retriedAt: new Date(retriedAtIso) },
    });
  }

  async deleteBySn(sn: string): Promise<void> {
    // deleteMany y no delete: idempotente — cerrar un intent ya cerrado
    // (dos GETs concurrentes) no puede tirar P2025.
    await prisma.wifiGuestIntent.deleteMany({ where: { sn } });
  }
}
