import { IClassPort } from '@domain/ports/IClassPort';
import type { TeamLocationSource } from '@domain/ports/TeamLocationSource';
import { IClassClient } from '../adapters/iclass/IClassClient';
import { IClassTeamLocationSource } from '../adapters/iclass/IClassTeamLocationSource';
import { InMemoryIClassClient } from '../adapters/in-memory/InMemoryIClassClient';
import { config } from '../config';

/**
 * Resolves the IClass upstream adapter for DI.
 *
 * The runtime on/off decision lives in the `iclass-integration` feature flag,
 * NOT here — this factory only provides the dependency. When credentials are
 * configured we wire the real HTTP client; otherwise we fall back to an inert
 * in-memory client so the server boots without IClass credentials (the flag,
 * default OFF, prevents it from ever being called in that case).
 */
export function buildIClassClient(): IClassPort {
  const { baseUrl, username, password, thirdPartyId } = config.iclass;
  if (username && password && thirdPartyId) {
    return new IClassClient({ baseUrl, username, password, thirdPartyId });
  }
  return new InMemoryIClassClient();
}

/**
 * Fuente del rastro GPS de cuadrillas (change iclass-gps-audit).
 *
 * Se construye aparte de `buildIClassClient()` porque los métodos de ubicación viven en
 * la clase CONCRETA `IClassClient`, no en el `IClassPort`. Sumarlos al port obligaría a
 * `InMemoryIClassClient` a implementarlos sin necesidad — la ubicación es una capability
 * distinta, con su propio port (`TeamLocationSource`) y su propio consumidor.
 *
 * Devuelve `null` cuando no hay credenciales: sin IClass no hay rastro que traer, y el
 * caller debe poder decidir no montar la feature en vez de recibir un stub que miente.
 */
export function buildTeamLocationSource(): TeamLocationSource | null {
  const { baseUrl, username, password, thirdPartyId } = config.iclass;
  if (!username || !password || !thirdPartyId) return null;
  return new IClassTeamLocationSource(
    new IClassClient({ baseUrl, username, password, thirdPartyId }),
  );
}
