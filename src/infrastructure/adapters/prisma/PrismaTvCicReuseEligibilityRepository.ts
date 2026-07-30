import type { TvCicReuseEligibilityRepository } from '@domain/ports/TvCicReuseEligibilityRepository';
import { prisma } from '../../database/prisma';

/**
 * Prisma adapter de TvCicReuseEligibilityRepository (gigared-tv-cic-reuse).
 *
 * Las TRES condiciones de la invariante viajan en UNA sola query. Resolverlas por separado
 * abriría una ventana TOCTOU entre "está dado de baja" y "no tiene fila de TV activa".
 *
 * `contracts: { none: { contractServices: { some: ... } } }` es load-bearing:
 *   - `none`  → ningún contrato del cliente tiene una fila de TV activa  ← lo que queremos
 *   - `some`  → significaría lo CONTRARIO
 *   - `every` → sería vacuamente cierto para un cliente sin contratos por otra razón
 * Un cliente SIN contratos satisface `none` correctamente (no tiene ninguna fila activa).
 *
 * La identidad de "fila de TV" es la señal canónica `serviceCatalog.name === 'TV'` (#135):
 * `tvLogin` se limpia en la baja y `notes` es texto libre, así que ninguno de los dos sirve
 * como discriminador estable.
 *
 * Usa `(prisma as any)` igual que el resto de los adapters del módulo, para compilar antes de
 * que se regenere el Prisma Client.
 */
export class PrismaTvCicReuseEligibilityRepository implements TvCicReuseEligibilityRepository {
  async isEligibleForCicReuse(clientId: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: { id: string } | null = await (prisma as any).client.findFirst({
      where: {
        id: clientId,
        tvCancelledAt: { not: null },
        contracts: {
          none: {
            contractServices: {
              some: { status: 'active', serviceCatalog: { name: 'TV' } },
            },
          },
        },
      },
      select: { id: true },
    });
    return row !== null;
  }
}
