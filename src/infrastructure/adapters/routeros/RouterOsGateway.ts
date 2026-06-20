import { RouterOSAPI } from 'node-routeros';
import { Client } from 'ssh2';
import {
  ActiveSession,
  NasTarget,
  PppoeRouterGateway,
  RouterSecret,
  SecretInput,
} from '@domain/ports/PppoeRouterGateway';
import { RouterUnreachableError } from '@domain/errors/pppoe';
import { config } from '@infrastructure/config';

/** Timeout duro (ms) para toda la operación SSH de lectura de IPs. */
const SSH_TIMEOUT_MS = 15_000;

/**
 * Parser PURO de la salida de `/ppp secret print terse without-paging` (RouterOS).
 * Devuelve la lista de `remote-address` NO vacíos, uno por secret.
 *
 * Formato `terse`: una fila por secret, tokens `clave=valor` separados por espacios, con un
 * prefijo de índice + flags (ej. ` 0   ` / ` 0 X `). Un secret con IP dinámica del pool NO trae
 * el token `remote-address` → se omite. `remote-address=""` o vacío también se omite.
 *
 * Exportado para testear sin abrir ninguna conexión (los tests del allocator usan el in-memory).
 */
export function parsePppSecretRemoteAddresses(output: string): string[] {
  const result: string[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // remote-address=<valor>, donde <valor> va hasta el próximo espacio (terse no escapa IPs).
    const match = /(?:^|\s)remote-address=("?)([^"\s]*)\1/.exec(line);
    if (!match) continue;
    const ip = match[2];
    if (ip.length > 0) result.push(ip);
  }
  return result;
}

/**
 * RouterOsGateway — adapter real del PppoeRouterGateway sobre RouterOS API (node-routeros).
 *
 * - Credenciales server-side (`config.router.apiUser/apiPassword`) — nunca viajan por HTTP.
 * - Una conexión efímera por operación (connect → write → close).
 * - Fallo de conexión (red/timeout/auth) → `RouterUnreachableError` (la ruta lo mapea a 502).
 * - `(rows as any)`: node-routeros tipa el retorno como `any[]`; el shape de `/ppp` es estable.
 *
 * GOTCHA `!empty` (cazado en el dry-run de Fase C contra Canepa): un `/print` con filtro
 * (`?name=`) que NO matchea ninguna fila hace que RouterOS responda `!empty`, y node-routeros
 * lo tira como excepción DENTRO del handler del socket → **NO capturable** con try/catch (crashea
 * el proceso). Pasa SIEMPRE en el kick de un usuario OFFLINE. Solución: NUNCA usar `?name=`;
 * hacer `print` COMPLETO (que sobre menú vacío devuelve `!done` → `[]`) y filtrar por `name` en JS.
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

  /**
   * Resuelve el `.id` interno de RouterOS de un secret/sesión por su `name`.
   * Print COMPLETO + filtro en JS (ver GOTCHA `!empty` arriba: un `?name=` sin match crashea
   * el proceso de forma no capturable; esto pasa en cada kick de un usuario offline).
   */
  private async findId(conn: RouterOSAPI, menu: string, username: string): Promise<string | null> {
    const rows = (await conn.write(`${menu}/print`, ['=.proplist=.id,name'])) as any[];
    const row = rows.find((r) => r.name === username);
    return row?.['.id'] ?? null;
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

  /**
   * IPs asignadas en el router vía SSH (NO node-routeros): lee los `remote-address` de
   * `/ppp secret`. La API 8728 CUELGA contra RouterOS 7.x al hacer este print; SSH responde al
   * instante. Cualquier error/timeout → RouterUnreachableError (la ruta lo mapea a 502).
   *
   * Credenciales server-side (`config.router.sshUser/sshPort/sshKey`); el host sale del NasTarget.
   * host-key checking permisivo: la key del router NO está pineada acá (red interna de gestión).
   */
  async listAssignedIps(nas: NasTarget): Promise<string[]> {
    const { sshKey, sshUser, sshPort } = config.router;
    if (!sshKey) throw new RouterUnreachableError(nas.ipAddress);

    return new Promise<string[]>((resolve, reject) => {
      const conn = new Client();
      let settled = false;

      const fail = () => {
        if (settled) return;
        settled = true;
        try {
          conn.end();
        } catch {
          /* swallow */
        }
        reject(new RouterUnreachableError(nas.ipAddress));
      };

      const hardTimeout = setTimeout(fail, SSH_TIMEOUT_MS);

      conn.on('ready', () => {
        conn.exec('/ppp secret print terse without-paging', (err, stream) => {
          if (err) {
            clearTimeout(hardTimeout);
            return fail();
          }
          let stdout = '';
          stream
            .on('close', () => {
              clearTimeout(hardTimeout);
              if (settled) return;
              settled = true;
              try {
                conn.end();
              } catch {
                /* swallow */
              }
              resolve(parsePppSecretRemoteAddresses(stdout));
            })
            .on('data', (chunk: Buffer) => {
              stdout += chunk.toString('utf8');
            })
            // stderr de RouterOS no rompe el print; lo descartamos.
            .stderr.on('data', () => {
              /* swallow */
            });
        });
      });

      conn.on('error', () => {
        clearTimeout(hardTimeout);
        fail();
      });

      conn.connect({
        host: nas.ipAddress,
        port: sshPort,
        username: sshUser,
        privateKey: sshKey,
        readyTimeout: SSH_TIMEOUT_MS,
      });
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
