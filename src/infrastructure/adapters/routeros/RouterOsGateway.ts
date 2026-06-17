import { RouterOSAPI } from 'node-routeros';
import {
  ActiveSession,
  NasTarget,
  PppoeRouterGateway,
  RouterSecret,
  SecretInput,
} from '@domain/ports/PppoeRouterGateway';
import { RouterUnreachableError } from '@domain/errors/pppoe';
import { config } from '@infrastructure/config';

/**
 * RouterOsGateway — adapter real del PppoeRouterGateway sobre RouterOS API (node-routeros).
 *
 * - Credenciales server-side (`config.router.apiUser/apiPassword`) — nunca viajan por HTTP.
 * - Una conexión efímera por operación (connect → write → close).
 * - Fallo de conexión (red/timeout/auth) → `RouterUnreachableError` (la ruta lo mapea a 502).
 * - `(rows as any)`: node-routeros tipa el retorno como `any[]`; el shape de `/ppp` es estable.
 */
export class RouterOsGateway implements PppoeRouterGateway {
  private async withConn<T>(nas: NasTarget, fn: (conn: RouterOSAPI) => Promise<T>): Promise<T> {
    const conn = new RouterOSAPI({
      host: nas.ipAddress,
      port: nas.apiPort,
      user: config.router.apiUser,
      password: config.router.apiPassword,
      timeout: 10,
    });
    try {
      await conn.connect();
    } catch {
      throw new RouterUnreachableError(nas.ipAddress);
    }
    try {
      return await fn(conn);
    } finally {
      try {
        conn.close();
      } catch {
        /* swallow close errors */
      }
    }
  }

  /** Resuelve el `.id` interno de RouterOS de un secret/sesión por su `name`. */
  private async findId(conn: RouterOSAPI, menu: string, username: string): Promise<string | null> {
    const rows = (await conn.write(`${menu}/print`, [`?name=${username}`, '=.proplist=.id'])) as any[];
    return rows[0]?.['.id'] ?? null;
  }

  async listSecrets(nas: NasTarget): Promise<RouterSecret[]> {
    return this.withConn(nas, async (conn) => {
      const rows = (await conn.write('/ppp/secret/print', [
        '=.proplist=name,profile,remote-address,disabled',
      ])) as any[];
      return rows.map((r) => ({
        username: r.name,
        profile: r.profile ?? null,
        remoteAddress: r['remote-address'] ?? null,
        disabled: r.disabled === 'true',
      }));
    });
  }

  async createSecret(nas: NasTarget, input: SecretInput): Promise<void> {
    return this.withConn(nas, async (conn) => {
      const params = [`=name=${input.username}`, `=password=${input.password}`, '=service=pppoe'];
      if (input.profile) params.push(`=profile=${input.profile}`);
      if (input.remoteAddress) params.push(`=remote-address=${input.remoteAddress}`);
      params.push(`=disabled=${input.disabled ? 'yes' : 'no'}`);
      await conn.write('/ppp/secret/add', params);
    });
  }

  async updateSecret(nas: NasTarget, username: string, patch: Partial<SecretInput>): Promise<void> {
    return this.withConn(nas, async (conn) => {
      const id = await this.findId(conn, '/ppp/secret', username);
      if (!id) return;
      const params = [`=.id=${id}`];
      if (patch.password !== undefined) params.push(`=password=${patch.password}`);
      if (patch.profile !== undefined) params.push(`=profile=${patch.profile ?? ''}`);
      if (patch.remoteAddress !== undefined) params.push(`=remote-address=${patch.remoteAddress ?? ''}`);
      if (patch.disabled !== undefined) params.push(`=disabled=${patch.disabled ? 'yes' : 'no'}`);
      if (params.length > 1) await conn.write('/ppp/secret/set', params);
    });
  }

  async removeSecret(nas: NasTarget, username: string): Promise<void> {
    return this.withConn(nas, async (conn) => {
      const id = await this.findId(conn, '/ppp/secret', username);
      if (id) await conn.write('/ppp/secret/remove', [`=.id=${id}`]);
    });
  }

  async listActiveSessions(nas: NasTarget): Promise<ActiveSession[]> {
    return this.withConn(nas, async (conn) => {
      const rows = (await conn.write('/ppp/active/print', [
        '=.proplist=name,address,caller-id,uptime',
      ])) as any[];
      return rows.map((r) => ({
        username: r.name,
        address: r.address ?? null,
        callerId: r['caller-id'] ?? null,
        uptime: r.uptime ?? null,
      }));
    });
  }

  async removeActiveSession(nas: NasTarget, username: string): Promise<void> {
    return this.withConn(nas, async (conn) => {
      const id = await this.findId(conn, '/ppp/active', username);
      if (id) await conn.write('/ppp/active/remove', [`=.id=${id}`]);
    });
  }
}
