import type { UispSite, UispDevice } from '@domain/entities/uisp';

/**
 * Port for the UISP API client.
 * Implementations: UispClient (axios, real API) and InMemoryUispClient (tests).
 * Errors → UispUnavailableError.
 */
export interface UispClient {
  listSites(): Promise<UispSite[]>;
  listDevices(): Promise<UispDevice[]>;
}
