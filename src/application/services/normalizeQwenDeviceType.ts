import { DeviceType, VALID_DEVICE_TYPES } from '@domain/entities/device-type';

const VALID = new Set<string>(VALID_DEVICE_TYPES);

/**
 * Valida la clasificación de equipo que devuelve el modelo de visión contra el
 * enum conocido. Desconocido / vacío / null → null (NO 'OTROS': el null distingue
 * "el modelo no matcheó un tipo concreto" de "es genuinamente otro"). Puro, no throw.
 */
export function normalizeQwenDeviceType(raw: string | null | undefined): DeviceType | null {
  if (!raw || typeof raw !== 'string') return null;
  const u = raw.trim().toUpperCase();
  return VALID.has(u) ? (u as DeviceType) : null;
}
