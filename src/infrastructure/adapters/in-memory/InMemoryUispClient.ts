import type { UispClient } from '@domain/ports/UispClient';
import type { UispSite, UispDevice } from '@domain/entities/uisp';

/**
 * In-memory UispClient for tests.
 * Pre-populated via constructor or setters.
 */
export class InMemoryUispClient implements UispClient {
  private _sites: UispSite[];
  private _devices: UispDevice[];

  constructor(sites: UispSite[] = [], devices: UispDevice[] = []) {
    this._sites = sites;
    this._devices = devices;
  }

  setSites(sites: UispSite[]): void {
    this._sites = sites;
  }

  setDevices(devices: UispDevice[]): void {
    this._devices = devices;
  }

  async listSites(): Promise<UispSite[]> {
    return [...this._sites];
  }

  async listDevices(): Promise<UispDevice[]> {
    return [...this._devices];
  }
}
