import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import type { UsageMetricsReader } from '@domain/ports/UsageMetricsReader';
import { UsageContractNotFoundError } from '@domain/errors/usage';
import type { PortalUsageMetricsDto, PortalUsageDailyDto } from '@application/dto/portal/portalUsage.dto';
import { currentArgentinaMonthPeriod, type PortalUsagePeriod } from './portalUsagePeriod';
import { prorateUsageSessions } from './usageProration';

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
 *  2. contrato -> usernames de RADIUS: el `username` de `RadiusEvent` ES el
 *     login PPPoE, y el vínculo con el contrato ya existe en el modelo
 *     (`PppoeService.contractId`). Se usa ESE camino (`findByContract`) y se
 *     toman TODOS los usernames del contrato — vigente + históricos — no solo el
 *     canónico (fix C1, multi-username): una re-provisión a mitad de mes crea un
 *     username NUEVO, y mirar solo ese borraba el consumo de la primera
 *     quincena. Sumar los históricos es seguro: sus sesiones son del MISMO
 *     contrato.
 *
 *  3. Sin PPPoE resoluble, o sin NINGUNA sesión que SOLAPE el mes ->
 *     `available:false` con todo en 0/[]/null. Es un ESTADO NORMAL (200), no un
 *     error: mismo criterio que la elegibilidad WiFi.
 *
 *  4. El `UsageMetricsReader` devuelve las sesiones SOLAPANTES crudas (fix C1:
 *     `startedAt < to AND (stoppedAt IS NULL OR stoppedAt >= from)` — la sesión
 *     always-on nacida el mes anterior ENTRA; antes el filtro `startedAt >=
 *     from` la excluía y el cliente veía 0 bytes). `prorateUsageSessions` — LA
 *     función compartida con el gemelo in-memory — atribuye al período la
 *     FRACCIÓN temporal solapada de cada sesión y reparte uniforme entre sus
 *     días vivos; si alguna fracción fue < 1, el DTO viaja con
 *     `approximate:true` y la app muestra "aproximado". Ver el docblock de
 *     `usageProration.ts`: es una ESTIMACIÓN documentada — el total de una
 *     sesión que cruza el borde del mes no es exacto (los contadores acumulados
 *     no dicen cuánto pasó adentro), es la mejor atribución disponible sin otro
 *     modelo de datos.
 *
 *  5. Acá se rellena el calendario completo del mes con ceros. Los totales se
 *     suman DESDE `daily`, no desde las sesiones: el número grande y el gráfico
 *     salen de la misma fuente y no pueden discrepar (el reparto conserva la
 *     suma byte a byte). `peakDay` sale de los daily nuevos.
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

    // TODOS los usernames del contrato (vigente + históricos), dedupeados.
    const services = await this.pppoe.findByContract(contractId);
    const usernames = [...new Set(services.map((s) => s.username))];
    if (usernames.length === 0) {
      return unavailable(period);
    }

    const sessions = await this.usage.sessionsOverlappingRange({
      usernames,
      from: period.fromUtc,
      to: now,
    });
    if (sessions.length === 0) {
      return unavailable(period);
    }

    const prorated = prorateUsageSessions(sessions, { from: period.fromUtc, to: now });

    const daily: PortalUsageDailyDto[] = period.days.map((date) => {
      const bucket = prorated.daily.get(date);
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
      approximate: prorated.approximate,
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
    approximate: false,
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
