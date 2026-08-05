import type {
  WifiGuestIntent,
  WifiGuestIntentRepository,
  ReplaceWifiGuestIntentInput,
} from '@domain/ports/WifiGuestIntentRepository';

/**
 * wifi-guest-pending — fake in-memory del intent de cambio de la red de
 * visitas. Clave del Map = sn (unique real de la tabla `WifiGuestIntent`):
 * UN intent por ONU — `replace` PISA el anterior y resetea `retriedAt` a null
 * (mismo contrato que el upsert Prisma).
 */
export class InMemoryWifiGuestIntentRepository implements WifiGuestIntentRepository {
  private readonly rows = new Map<string, WifiGuestIntent>();
  private seq = 0;

  async findBySn(sn: string): Promise<WifiGuestIntent | null> {
    const row = this.rows.get(sn);
    return row ? { ...row } : null;
  }

  async replace(input: ReplaceWifiGuestIntentInput): Promise<WifiGuestIntent> {
    const row: WifiGuestIntent = {
      id: `intent-${++this.seq}`,
      sn: input.sn,
      action: input.action,
      port: input.port,
      since: input.since,
      retriedAt: null,
    };
    this.rows.set(input.sn, row);
    return { ...row };
  }

  async markRetried(id: string, retriedAtIso: string): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.id === id) {
        row.retriedAt = retriedAtIso;
        return;
      }
    }
  }

  async deleteBySn(sn: string): Promise<void> {
    this.rows.delete(sn);
  }

  /** Test seam: todos los intents persistidos. */
  all(): WifiGuestIntent[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}
