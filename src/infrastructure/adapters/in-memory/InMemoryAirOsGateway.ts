import { AirOsGateway, AirOsInspectResult } from '@domain/ports/AirOsGateway';

/**
 * InMemoryAirOsGateway — test seam para AirOsGateway.
 *
 * Configurable con:
 *   - `result`: devuelve este resultado siempre.
 *   - `throws`: lanza este error al llamar `inspect()` (simula antena offline/unreachable).
 */
export class InMemoryAirOsGateway implements AirOsGateway {
  private readonly _result: AirOsInspectResult | null;
  private readonly _throws: Error | null;

  constructor(opts?: { result?: AirOsInspectResult; throws?: Error }) {
    this._result = opts?.result ?? null;
    this._throws = opts?.throws ?? null;
  }

  async inspect(_ip: string): Promise<AirOsInspectResult> {
    if (this._throws) throw this._throws;
    return this._result ?? { model: null, ownMac: null, lanMacs: [], leases: {} };
  }
}
