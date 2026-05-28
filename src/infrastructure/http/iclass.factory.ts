import { IClassPort } from '@domain/ports/IClassPort';
import { IClassClient } from '../adapters/iclass/IClassClient';
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
