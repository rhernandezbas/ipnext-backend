import type {
  MessagingRatesConfig,
  MessagingRatesConfigRepository,
  MessagingRatesConfigPatch,
} from '@domain/ports/MessagingRatesConfigRepository';
import { MESSAGING_RATES_CONFIG_DEFAULTS } from '@domain/ports/MessagingRatesConfigRepository';
import { prisma } from '../../database/prisma';

const SINGLETON_ID = 'singleton';

/** Prisma Decimal — solo se usa `.toFixed(4)` (D2, frontera Decimal ↔ string). */
interface DecimalLike {
  toFixed(decimals: number): string;
}

interface ConfigRow {
  id: string;
  currency: string;
  utilityRate: DecimalLike;
  marketingRate: DecimalLike;
  authenticationRate: DecimalLike;
  providerFee: DecimalLike;
  updatedAt: Date;
}

function toEntity(row: ConfigRow): MessagingRatesConfig {
  return {
    currency: row.currency,
    utilityRate: row.utilityRate.toFixed(4),
    marketingRate: row.marketingRate.toFixed(4),
    authenticationRate: row.authenticationRate.toFixed(4),
    providerFee: row.providerFee.toFixed(4),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * twilio-credit-guard (1.7, D3.c) — molde EXACTO `PrismaExternalBulkMessagingConfigRepository`.
 * `get()` SIN fila persistida crea la fila PEREZOSAMENTE (fix F14 clonado — un
 * `updatedAt` fabricado es peor que uno ausente). `Decimal` ↔ **string** en la
 * frontera: `row.rate.toFixed(4)` al leer, string tal cual al escribir —
 * NUNCA `Number(row.rate)` (D2, mata el riesgo de float en origen).
 *
 * fix wave F1 (F4) — CERO fallback a defaults ante un error de DB: cualquier
 * fallo de `findUnique`/`upsert` SUBE. Adivinar una tarifa es peor que no
 * tener ninguna cuando la decisión de arriba es "¿gasto plata real?".
 */
export class PrismaMessagingRatesConfigRepository implements MessagingRatesConfigRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).messagingRatesConfig;
  }

  async get(): Promise<MessagingRatesConfig> {
    const row: ConfigRow | null = await this.table.findUnique({ where: { id: SINGLETON_ID } });
    if (row) return toEntity(row);
    // fix wave F1 (F4) — el `catch` que devolvía los defaults SE ELIMINÓ. Un
    // repo que "degrada a los defaults" cuando la DB no responde le MIENTE al
    // gate de crédito: `SendExternalBulk` gastaría plata real con una tarifa
    // INVENTADA (y `validate` mostraría un costo que la casa no cobra). El
    // error sube tal cual; el use case lo traduce (send → 503 fail-closed,
    // validate → `credit.unknown` + warning). El ÚNICO camino que devuelve los
    // defaults es este lazy-create FELIZ, con el `updatedAt` REAL de la fila.
    const created: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...MESSAGING_RATES_CONFIG_DEFAULTS },
      update: {},
    });
    return toEntity(created);
  }

  async set(patch: MessagingRatesConfigPatch): Promise<MessagingRatesConfig> {
    const data = {
      currency: patch.currency,
      utilityRate: patch.utilityRate,
      marketingRate: patch.marketingRate,
      authenticationRate: patch.authenticationRate,
      providerFee: patch.providerFee,
    };
    const row: ConfigRow = await this.table.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
    return toEntity(row);
  }
}
