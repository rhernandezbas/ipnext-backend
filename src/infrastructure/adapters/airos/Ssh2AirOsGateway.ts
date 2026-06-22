import { Client } from 'ssh2';
import type { Algorithms } from 'ssh2';
import { AirOsGateway, AirOsInspectResult } from '@domain/ports/AirOsGateway';
import { AirOsUnreachableError } from '@domain/errors/airos';

/** Timeout duro (ms) para toda la operación SSH de inspección airOS. */
const SSH_TIMEOUT_MS = 10_000;

/**
 * Parser PURO de la salida de `mca-status` (airOS).
 * Retorna model (platform=) y ownMac (deviceId=).
 *
 * Exportado para testeo unitario sin abrir ninguna conexión SSH.
 *
 * Formato de salida real (una sola línea CSV):
 *   `deviceName=...,deviceId=78:8A:20:96:6A:AE,...,platform=LiteBeam 5AC Gen2,...`
 */
export function parseMcaStatus(text: string): { model: string | null; ownMac: string | null } {
  const platformMatch = /platform=([^,\n\r]+)/.exec(text);
  const deviceIdMatch = /deviceId=([^,\n\r]+)/.exec(text);

  return {
    model: platformMatch ? platformMatch[1].trim() : null,
    ownMac: deviceIdMatch ? deviceIdMatch[1].trim() : null,
  };
}

/**
 * Parser PURO de la tabla `/proc/net/arp` de airOS.
 * Retorna las MACs LAN (iface eth0, Flags=0x2, HW address no nulo, excluyendo ownMac).
 *
 * Exportado para testeo unitario sin abrir ninguna conexión SSH.
 *
 * Formato de cada fila:
 *   `192.168.11.193  0x1  0x2  c0:c9:e3:34:33:75  *  eth0`
 *
 * Criterios de inclusión:
 *   - Device = eth0 (LAN side, no la iface wireless ath0/ath1)
 *   - Flags = 0x2 (COMPLETE — entrada ARP viva)
 *   - HW address ≠ 00:00:00:00:00:00
 *   - HW address ≠ ownMac (no la antena misma)
 */
export function parseArpLan(text: string, ownMac: string | null): string[] {
  const ownMacNorm = ownMac ? ownMac.toLowerCase() : null;
  const result: string[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    // Saltar header y líneas vacías
    if (!line || line.startsWith('IP address')) continue;

    // Columnas separadas por espacios variables:
    // IP, HW type, Flags, HW address, Mask, Device
    const cols = line.split(/\s+/);
    if (cols.length < 6) continue;

    const flags  = cols[2];   // 0x2 = COMPLETE
    const hwAddr = cols[3];   // MAC
    const device = cols[5];   // eth0 / ath0 / br0 …

    if (flags !== '0x2') continue;
    if (device !== 'eth0') continue;
    if (!hwAddr || hwAddr === '00:00:00:00:00:00') continue;
    if (ownMacNorm && hwAddr.toLowerCase() === ownMacNorm) continue;

    result.push(hwAddr);
  }

  return result;
}

/**
 * Parser PURO del lease file de dnsmasq de airOS (`/tmp/dhcpd.leases`).
 * Retorna un mapa MAC (lowercase) → hostname. El hostname es lo que el router del cliente reporta en
 * el DHCP request (opción 12) — en la práctica, su MODELO (ej. `TL-WR820N`).
 *
 * Exportado para testeo unitario sin abrir ninguna conexión SSH.
 *
 * Formato de cada línea (dnsmasq):
 *   `<expiry-epoch> <mac> <ip> <hostname> <client-id>`
 *
 * Ignora líneas inválidas y `hostname = '*'` (router que no reportó nombre).
 */
export function parseDhcpLeases(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const macRe = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;

    const mac = cols[1];
    const hostname = cols[3];
    if (!macRe.test(mac)) continue;
    if (!hostname || hostname === '*') continue;

    result[mac.toLowerCase()] = hostname;
  }

  return result;
}

/**
 * Separa la salida combinada de `inspect()` en sus tres secciones (mca-status, ARP, leases).
 *
 * Los marcadores se reconocen como LÍNEAS EXACTAS (`---ARP---`, `---LEASES---`), NO como substrings:
 * así un `deviceName`/campo de mca-status o ARP que contenga `---ARP---` embebido en una línea de
 * contenido NO cambia de sección. Exportado para test unitario sin SSH.
 */
export function splitAirOsSections(raw: string): { mca: string; arp: string; leases: string } {
  const mca: string[] = [];
  const arp: string[] = [];
  const leases: string[] = [];
  let section: 'mca' | 'arp' | 'leases' = 'mca';

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '---ARP---') { section = 'arp'; continue; }
    if (t === '---LEASES---') { section = 'leases'; continue; }
    if (section === 'mca') mca.push(line);
    else if (section === 'arp') arp.push(line);
    else leases.push(line);
  }

  return { mca: mca.join('\n'), arp: arp.join('\n'), leases: leases.join('\n') };
}

/**
 * Ssh2AirOsGateway — implementación real de AirOsGateway con `ssh2`.
 *
 * Conecta a las antenas airOS usando los algoritmos legacy que soportan
 * (versiones viejas de OpenSSH que solo tienen DHG1/sha1, cipher 3DES/AES-CBC/AES-CTR).
 * Probado y verificado en vivo contra antenas Ubiquiti con airOS WA.v8.x.
 *
 * Constructor: `{ user, passwords, timeoutMs? }`.
 * - `passwords`: se prueba cada una hasta que una conecta (distintas antenas pueden tener distinta clave).
 * - `timeoutMs`: timeout de conexión (default 10s).
 *
 * Fallo de conexión (todas las passwords fallan / timeout / IP no alcanzable) → `AirOsUnreachableError`.
 */
export class Ssh2AirOsGateway implements AirOsGateway {
  private readonly user: string;
  private readonly passwords: string[];
  private readonly timeoutMs: number;

  constructor(opts: { user: string; passwords: string[]; timeoutMs?: number }) {
    this.user = opts.user;
    this.passwords = opts.passwords.length > 0 ? opts.passwords : ['ubnt'];
    this.timeoutMs = opts.timeoutMs ?? SSH_TIMEOUT_MS;
  }

  /**
   * Los algoritmos legacy que soporta airOS WA.v8.x (verificados en vivo).
   * Sin esta lista, ssh2 v1.x negocia algo más nuevo y la conexión falla silenciosamente.
   * Cast explícito a `Algorithms` para satisfacer los string-literal types de @types/ssh2.
   */
  private get sshAlgorithms(): Algorithms {
    return {
      kex: [
        'diffie-hellman-group14-sha1',
        'diffie-hellman-group1-sha1',
        'diffie-hellman-group-exchange-sha1',
      ] as Algorithms['kex'],
      serverHostKey: ['ssh-rsa', 'ssh-dss'] as Algorithms['serverHostKey'],
      cipher: ['aes128-ctr', 'aes128-cbc', '3des-cbc', 'aes256-cbc'] as Algorithms['cipher'],
      hmac: ['hmac-sha1', 'hmac-sha1-96'] as Algorithms['hmac'],
    };
  }

  /**
   * Intenta conectar con una contraseña y ejecuta un comando. Resuelve con la salida stdout.
   * Rechaza con el error SSH si la conexión/auth/exec falla.
   */
  private execWithPassword(ip: string, password: string, command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const conn = new Client();
      let settled = false;

      const done = (result: string | Error) => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch { /* swallow */ }
        if (typeof result === 'string') {
          resolve(result);
        } else {
          reject(result);
        }
      };

      const hardTimeout = setTimeout(() => done(new Error('timeout')), this.timeoutMs);

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(hardTimeout);
            done(err);
            return;
          }
          let stdout = '';
          stream
            .on('close', () => {
              clearTimeout(hardTimeout);
              done(stdout);
            })
            .on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); })
            .stderr.on('data', () => { /* swallow stderr */ });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(hardTimeout);
        done(err);
      });

      conn.connect({
        host: ip,
        port: 22,
        username: this.user,
        password,
        readyTimeout: this.timeoutMs,
        algorithms: this.sshAlgorithms,
        // Host-key checking permisivo: las antenas de campo no tienen key pineada.
        hostVerifier: () => true,
      });
    });
  }

  /**
   * Ejecuta un comando en la antena probando cada password en orden.
   * Retorna la salida stdout de la primera que conecta exitosamente.
   * Si todas fallan, lanza AirOsUnreachableError.
   */
  private async execWithFallback(ip: string, command: string): Promise<string> {
    let lastErr: Error = new Error('no passwords configured');
    for (const password of this.passwords) {
      try {
        return await this.execWithPassword(ip, password, command);
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw new AirOsUnreachableError(ip, `No se pudo conectar a ${ip}: ${lastErr.message}`);
  }

  async inspect(ip: string): Promise<AirOsInspectResult> {
    // Tres comandos en una sola sesión SSH (minimiza el costo de auth con algos legacy):
    //   mca-status        → modelo + MAC de la antena
    //   /proc/net/arp     → MAC del router del cliente
    //   /tmp/dhcpd.leases → hostname (modelo) del router, si la antena hace DHCP (dnsmasq)
    // Si la conexión falla del todo → AirOsUnreachableError.
    let rawOutput: string;
    try {
      rawOutput = await this.execWithFallback(
        ip,
        'mca-status; echo "---ARP---"; cat /proc/net/arp; echo "---LEASES---"; cat /tmp/dhcpd.leases 2>/dev/null',
      );
    } catch (err) {
      if (err instanceof AirOsUnreachableError) throw err;
      throw new AirOsUnreachableError(ip);
    }

    // Separar las tres secciones por sus líneas-marcador (robusto a marcadores embebidos en el
    // contenido — ver splitAirOsSections).
    const { mca, arp, leases: leaseText } = splitAirOsSections(rawOutput);

    const { model, ownMac } = parseMcaStatus(mca);
    const lanMacs = parseArpLan(arp, ownMac);
    const leases = parseDhcpLeases(leaseText);

    return { model, ownMac, lanMacs, leases };
  }
}
