/**
 * RouterOsGateway — adapter real para RouterOS API (node-routeros).
 *
 * Estado: STUB estructural — implementa el port `PppoeRouterGateway` en forma y tipo,
 * pero las operaciones se implementan cuando `node-routeros` se agregue como dep de producción.
 *
 * Fases:
 *   - Fase B (management): listSecrets / createSecret / updateSecret / removeSecret
 *   - Fase C (enforcement): listActiveSessions / removeActiveSession
 *
 * Credenciales: server-side via env `ROUTER_API_USER` / `ROUTER_API_PASSWORD`.
 * El adapter las resuelve en cada operación — NUNCA viajan por HTTP.
 *
 * Para habilitar el adapter real:
 *   1. `npm install node-routeros`
 *   2. Agregar `ROUTER_API_USER` y `ROUTER_API_PASSWORD` a `config.ts` (fail-fast).
 *   3. Reemplazar el body de cada método con la llamada a `RouterOSAPI`.
 */
import {
  ActiveSession,
  NasTarget,
  PppoeRouterGateway,
  RouterSecret,
  SecretInput,
} from '@domain/ports/PppoeRouterGateway';
import { RouterUnreachableError } from '@domain/errors/pppoe';

export class RouterOsGateway implements PppoeRouterGateway {
  /**
   * Lista los secrets PPPoE del router. (stub — implementar con node-routeros)
   */
  async listSecrets(_nas: NasTarget): Promise<RouterSecret[]> {
    throw new RouterUnreachableError(_nas.ipAddress);
  }

  /**
   * Crea un secret PPPoE en el router. (stub — implementar con node-routeros)
   */
  async createSecret(_nas: NasTarget, _input: SecretInput): Promise<void> {
    throw new RouterUnreachableError(_nas.ipAddress);
  }

  /**
   * Aplica un patch al secret PPPoE en el router. (stub — implementar con node-routeros)
   */
  async updateSecret(_nas: NasTarget, _username: string, _patch: Partial<SecretInput>): Promise<void> {
    throw new RouterUnreachableError(_nas.ipAddress);
  }

  /**
   * Elimina un secret PPPoE del router. (stub — implementar con node-routeros)
   */
  async removeSecret(_nas: NasTarget, _username: string): Promise<void> {
    throw new RouterUnreachableError(_nas.ipAddress);
  }

  /**
   * Lista las sesiones activas PPPoE. (Fase C — implementar con node-routeros)
   */
  async listActiveSessions(_nas: NasTarget): Promise<ActiveSession[]> {
    throw new RouterUnreachableError(_nas.ipAddress);
  }

  /**
   * Desconecta una sesión activa PPPoE. (Fase C — implementar con node-routeros)
   */
  async removeActiveSession(_nas: NasTarget, _username: string): Promise<void> {
    throw new RouterUnreachableError(_nas.ipAddress);
  }
}
