/**
 * iclassDateTime — parseo puro de los timestamps de IClass (`dd-MM-yyyy HH:mm:ss`).
 *
 * ## Por qué esto existe y no es `new Date(raw)`
 *
 * IClass emite sus fechas en **hora de Argentina** (verificado 2026-07-26: el último
 * breadcrumb reportaba `09:08:32` mientras el reloj local argentino marcaba `09:13`).
 * El container de PRODUCCIÓN corre en **UTC** (ver `deploy.yml`).
 *
 * Cualquier parseo que dependa de la TZ del proceso (`new Date('2026-07-26T09:08:32')`,
 * `getHours()`, `toLocaleString()` sin `timeZone`) produce un desplazamiento de 3 horas
 * en prod y NO en dev. Consecuencia concreta para este change: la ventana de trabajo de
 * una orden dejaría de contener los breadcrumbs correctos y la auditoría de presencia
 * devolvería veredictos falsos **sin ningún síntoma visible**.
 *
 * Es exactamente la clase de bug que rompió el password diario de Gestión Real
 * (`isoDate()` en `GestionRealClient.ts`), donde el sync devolvía 0 en la franja
 * nocturna argentina, de forma intermitente y silenciosa.
 *
 * Argentina no aplica horario de verano desde 2009 → offset fijo **UTC-3**. Al no haber
 * DST no hace falta ICU ni `Intl`: la aritmética de offset constante es exacta y no
 * depende de la tzdata del sistema operativo.
 *
 * ## Duplicación DELIBERADA con `parseIClassDate` de IClassClient.ts
 *
 * `infrastructure/adapters/iclass/IClassClient.ts` ya tiene un `parseIClassDate` que
 * también fija `-03:00` (y `formatCloseDate` fija `-0300`) — o sea, el equipo ya había
 * descubierto que IClass trabaja en hora argentina. NO se reusa acá por dos razones:
 *
 *  1. **DIP**: esto vive en el dominio y el dominio no puede importar de `infrastructure/`.
 *  2. **Contratos distintos**: aquel devuelve `string | null` (ISO) y acepta además
 *     formatos ISO y fechas sin hora; éste devuelve `Date | null`, exige el formato
 *     exacto de los breadcrumbs y rechaza calendarios imposibles.
 *
 * Unificarlos implicaría tocar el parseo del closure loop, que está en producción, por
 * una ganancia cosmética. Queda anotado para un refactor propio si alguna vez conviene.
 */

/** Offset fijo de Argentina respecto de UTC, en minutos (UTC-3, sin DST). */
const ARGENTINA_UTC_OFFSET_MINUTES = -180;

/** `dd-MM-yyyy HH:mm` con segundos opcionales. */
const ICLASS_DATETIME_RE = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * "dd-MM-yyyy HH:mm[:ss]" (hora Argentina) → `Date` en UTC.
 * Devuelve `null` ante cualquier entrada malformada o calendario imposible —
 * nunca un `Invalid Date`, que se propaga silencioso y explota lejos del origen.
 */
export function parseIClassDateTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;

  const match = ICLASS_DATETIME_RE.exec(raw.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // Se construye el instante como si los componentes fueran UTC y después se corrige
  // el offset argentino. Date.UTC no depende de la TZ del proceso.
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(asIfUtc - ARGENTINA_UTC_OFFSET_MINUTES * 60_000);

  // Date.UTC normaliza los desbordes (32-07 pasa a 01-08). Se rechaza el input en vez
  // de aceptar una fecha que el usuario nunca escribió.
  const roundTrip = new Date(asIfUtc);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

/** `Date` → "dd-MM-yyyy HH:mm:ss" en hora Argentina (inversa de parseIClassDateTime). */
export function formatIClassDateTime(date: Date): string {
  const local = new Date(date.getTime() + ARGENTINA_UTC_OFFSET_MINUTES * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${pad(local.getUTCDate())}-${pad(local.getUTCMonth() + 1)}-${local.getUTCFullYear()} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
  );
}

/** Fecha calendario argentina de un instante, como "yyyy-MM-dd" (para agrupar por jornada). */
export function argentinaCalendarDay(date: Date): string {
  const local = new Date(date.getTime() + ARGENTINA_UTC_OFFSET_MINUTES * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}
