/**
 * derivePortalTaskTimeSlot — customer-portal-api (Fase 4, task 4.4).
 *
 * Dominio puro. `ScheduledTask` no modela una franja horaria dedicada (ver
 * prisma/schema.prisma) — v1 deriva un turno honesto (mañana/tarde) de la HORA
 * de `startDate` en vez de inventar un campo.
 *
 * Parsea el substring "THH:" del ISO 8601 directamente (NO `new Date().getHours()`):
 * `startDate` llega "ISO 8601 with offset" — la hora escrita en el string YA es la
 * hora de pared real del evento. Convertir con `Date` reinterpreta esa hora en la
 * zona horaria del proceso Node (server), lo que puede correrla si el server no
 * corre en `America/Argentina/*`.
 */
export type PortalTaskTimeSlot = 'mañana' | 'tarde';

const HOUR_PATTERN = /T(\d{2}):/;

export function derivePortalTaskTimeSlot(startDate: string | null): PortalTaskTimeSlot | null {
  if (!startDate) return null;
  const match = HOUR_PATTERN.exec(startDate);
  if (!match) return null;
  const hour = Number(match[1]);
  if (Number.isNaN(hour)) return null;
  return hour < 13 ? 'mañana' : 'tarde';
}
