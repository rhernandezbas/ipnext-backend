/**
 * derivePortalTaskTimeSlot — customer-portal-api (Fase 4, task 4.4).
 *
 * Dominio puro. `ScheduledTask` no modela una franja horaria dedicada (ver
 * prisma/schema.prisma) — v1 deriva un turno honesto (mañana/tarde) de la HORA
 * de `startDate` en vez de inventar un campo.
 *
 * Fix portal-timeslot-art: el caller real (`ListPortalTasks` via
 * `PrismaSchedulingRepository`) serializa `row.startDate.toISOString()`, o sea
 * strings UTC (`...Z`). Parsear el substring "THH:" leia la hora UTC como hora
 * de pared: 10:00 ART llegaba como `T13:...Z` => 'tarde' (mal), y 21:30 ART
 * como `T00:30Z` del dia siguiente => 'mañana'. La hora se deriva ahora en la
 * zona `America/Argentina/Buenos_Aires` REAL via `Intl.DateTimeFormat` (mismo
 * patron que `isoDate()` de `GestionRealClient.ts`) — NO `getHours()` (depende
 * de la TZ del proceso), NO parseo de substring. Funciona igual para strings
 * con offset explicito: `Date` normaliza al instante y el formatter lo proyecta
 * a hora ART.
 */
export type PortalTaskTimeSlot = 'mañana' | 'tarde';

const ART_HOUR_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Argentina/Buenos_Aires',
  hour: 'numeric',
  hour12: false,
});

export function derivePortalTaskTimeSlot(startDate: string | null): PortalTaskTimeSlot | null {
  if (!startDate) return null;
  const date = new Date(startDate);
  if (Number.isNaN(date.getTime())) return null;
  const hour = Number(ART_HOUR_FORMATTER.format(date));
  if (Number.isNaN(hour)) return null;
  return hour < 13 ? 'mañana' : 'tarde';
}
