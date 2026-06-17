import { NasServer } from '@domain/entities/nas';
import { NasTarget } from '@domain/ports/PppoeRouterGateway';

/** Mapea un NasServer al target del gateway (apiPort por defecto 8728 si está null). */
export function toNasTarget(nas: NasServer): NasTarget {
  return { ipAddress: nas.ipAddress, apiPort: nas.apiPort ?? 8728 };
}
