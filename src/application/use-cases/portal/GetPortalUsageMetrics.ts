import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { UsageMetricsReader, UsageDailyBucket } from '@domain/ports/UsageMetricsReader';
import { pickCurrentPppoeService } from '@domain/entities/pppoeService';
import { UsageContractNotFoundError } from '@domain/errors/usage';
import type { PortalUsageMetricsDto, PortalUsageDailyDto } from '@application/dto/portal/portalUsage.dto';
import { currentArgentinaMonthPeriod, type PortalUsagePeriod } from './portalUsagePeriod';

/**
 * portal-usage-metrics — "Mi consumo" de Mis servicios
 * (`GET /api/portal/usage/:contractId`).
 *
 * Orden de pasos (cada uno es un caso de la spec):
 *
 *  1. ANTI-IDOR ESTRUCTURAL: el `contractId` viene por PARAM y se verifica
 *     SIEMPRE contra los contratos del `clientId` DEL TOKEN. Ajeno o inexistente
 *     -> `UsageContractNotFoundError` (404 indistinguible). Es lo PRIMERO: sin
 *     esto un `contractId` ajeno llegaría a la query de consumo. Mismo criterio
 *     que `/equipment/:contractId` y `/wifi/:contractId`.
 *
 *  2. contrato -> username de RADIUS: el `username` de `RadiusEvent` ES el login
 *     PPPoE, y el vínculo con el contrato ya existe en el modelo
 *     (`PppoeService.contractId`). Se usa ESE camino (`findByContract`), no un
 *     join nuevo. Cuando el contrato tiene VARIOS PPPoE se resuelve con
 *     `pickCurrentPppoeService`, el mismo desempate canónico del dominio que usa
 *     el snapshot de finanzas — para que "el PPPoE actual del contrato" no
 *     signifique dos cosas distintas según quién pregunte.
 *
 *  3. Sin PPPoE resoluble, o sin NINGUNA sesión en el mes -> `available:false`
 *     con todo en 0/[]/null. Es un ESTADO NORMAL (200), no un error: mismo
 *     criterio que la elegibilidad WiFi.
 *
 *  4. El `UsageMetricsReader` devuelve SOLO los días con tráfico; acá se rellena
 *     el calendario completo del mes con ceros. Los totales se suman DESDE
 *     `daily`, no desde los buckets crudos: el número grande y el gráfico salen
 *     de la misma fuente y no pueden discrepar.
 *
 * SIMPLIFICACIÓN DOCUMENTADA (reparto por día): una sesión cuenta ENTERA en el
 * día en que ARRANCÓ (`startedAt`). Una sesión PPPoE que dura 9 días le carga
 * los 9 días de tráfico al primero. Con los eventos `interim` se podría prorratear
 * de verdad (cada interim trae el acumulado a su hora, así que la diferencia entre
 * interims consecutivos ES el consumo de ese tramo) — pero eso es otra query y
 * otro modelo, y no se hace ahora. El TOTAL del mes es correcto igual; lo que se
 * distorsiona es el reparto del gráfico diario.
 *
 * NO expone "velocidad máxima": el accounting de RADIUS no la trae.
 */
export class GetPortalUsageMetrics {
  constructor(
    private readonly customers: Pick<CustomerRepository, 'listContracts'>,
    private readonly pppoe: Pick<PppoeServiceRepository, 'findByContract'>,
    private readonly usage: UsageMetricsReader,
    /** Inyectable para los tests — el período depende de "ahora". */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(clientId: string, contractId: string): Promise<PortalUsageMetricsDto> {
    const contracts = await this.customers.listContracts(clientId);
    if (!contracts.some((c) => c.id === contractId)) {
      // "No existe" y "es de otro cliente" comparten error y respuesta.
      throw new UsageContractNotFoundError();
    }

    const now = this.now();
    const period = currentArgentinaMonthPeriod(now);

    const service = pickCurrentPppoeService(await this.pppoe.findByContract(contractId));
    if (!service) {
      return unavailable(period);
    }

    const buckets = await this.usage.dailyUsageByUsername({
      username: service.username,
      from: period.fromUtc,
      to: now,
    });
    if (buckets.length === 0) {
      return unavailable(period);
    }

    const byDate = new Map<string, UsageDailyBucket>(buckets.map((b) => [b.date, b]));
    const daily: PortalUsageDailyDto[] = period.days.map((date) => {
      const bucket = byDate.get(date);
      return {
        date,
        downloadBytes: Number(bucket?.downloadBytes ?? 0n),
        uploadBytes: Number(bucket?.uploadBytes ?? 0n),
      };
    });

    let downloadBytes = 0;
    let uploadBytes = 0;
    for (const d of daily) {
      downloadBytes += d.downloadBytes;
      uploadBytes += d.uploadBytes;
    }

    return {
      available: true,
      period: { from: period.from, to: period.to },
      downloadBytes,
      uploadBytes,
      totalBytes: downloadBytes + uploadBytes,
      daily,
      peakDay: peakDayOf(daily),
    };
  }
}

function unavailable(period: PortalUsagePeriod): PortalUsageMetricsDto {
  return {
    available: false,
    period: { from: period.from, to: period.to },
    downloadBytes: 0,
    uploadBytes: 0,
    totalBytes: 0,
    daily: [],
    peakDay: null,
  };
}

/**
 * El día de MAYOR total (descarga + subida), no el de mayor descarga. Empate ->
 * el más TEMPRANO (el `>` estricto conserva al primero). `null` si todo el mes
 * dio cero — un "día pico de 0 bytes" no es información, es ruido.
 */
function peakDayOf(daily: PortalUsageDailyDto[]): { date: string; totalBytes: number } | null {
  let best: { date: string; totalBytes: number } | null = null;
  for (const d of daily) {
    const totalBytes = d.downloadBytes + d.uploadBytes;
    if (totalBytes > 0 && (best === null || totalBytes > best.totalBytes)) {
      best = { date: d.date, totalBytes };
    }
  }
  return best;
}
