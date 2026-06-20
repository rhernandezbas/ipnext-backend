/**
 * ipMath — aritmética IPv4 pura del dominio (sin dependencias externas).
 *
 * Fuente única para:
 *   - el allocator (FindFreeIp): convertir IPs ↔ enteros, bordes del CIDR (network/broadcast),
 *   - los contadores de Gestión de Red IP (ListIpPools / ListIpNetworks): cuántas IPs usables
 *     tiene un rango/CIDR y cuántas de las IPs ASIGNADAS caen dentro.
 *
 * Todas las funciones de conteo DEGRADAN a 0 ante entradas no parseables (CIDR/rango basura):
 * un endpoint de listado NUNCA debe romperse por un dato sucio.
 */

/** IPv4 dotted-quad → entero sin signo de 32 bits. Lanza si la IP es inválida. */
export function ipToInt(ip: string): number {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) throw new Error(`IPv4 inválida: ${ip}`);
  let acc = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`IPv4 inválida: ${ip}`);
    }
    acc = acc * 256 + octet;
  }
  return acc >>> 0;
}

/** Entero de 32 bits → IPv4 dotted-quad. */
export function intToIp(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/** Network + broadcast de un CIDR "a.b.c.d/p". null si el CIDR no es parseable. */
export function networkEdges(cidr: string): { network: number; broadcast: number } | null {
  const [base, prefixStr] = cidr.split('/');
  if (!base || prefixStr === undefined) return null;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  let baseInt: number;
  try {
    baseInt = ipToInt(base);
  } catch {
    return null;
  }
  // mask de `prefix` bits. /0 → 0; /32 → 0xffffffff.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (baseInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, broadcast };
}

/**
 * IPs USABLES de un CIDR: el tamaño del bloque menos network y broadcast.
 * /31 y /32 → 0 (no quedan hosts asignables). CIDR basura → 0 (degrada).
 */
export function usableIpsInCidr(cidr: string): number {
  const edges = networkEdges(cidr);
  if (!edges) return 0;
  const size = edges.broadcast - edges.network + 1;
  const usable = size - 2; // network + broadcast no son asignables
  return usable > 0 ? usable : 0;
}

/**
 * IPs USABLES de un rango inclusivo [start, end]. end < start o bounds basura → 0 (degrada).
 */
export function usableIpsInRange(rangeStart: string, rangeEnd: string): number {
  let start: number;
  let end: number;
  try {
    start = ipToInt(rangeStart);
    end = ipToInt(rangeEnd);
  } catch {
    return 0;
  }
  if (end < start) return 0;
  return end - start + 1;
}

/** Set de enteros de las IPs parseables (descarta basura silenciosamente). */
function toIntSet(ips: string[]): Set<number> {
  const set = new Set<number>();
  for (const ip of ips) {
    try {
      set.add(ipToInt(ip));
    } catch {
      /* ignorar valores no-IPv4 */
    }
  }
  return set;
}

/**
 * Cuántas de las IPs `assigned` caen dentro del rango inclusivo [start, end].
 * Dedup automático (Set). bounds basura → 0.
 */
export function countAssignedInRange(assigned: string[], rangeStart: string, rangeEnd: string): number {
  let start: number;
  let end: number;
  try {
    start = ipToInt(rangeStart);
    end = ipToInt(rangeEnd);
  } catch {
    return 0;
  }
  if (end < start) return 0;
  let count = 0;
  for (const n of toIntSet(assigned)) {
    if (n >= start && n <= end) count++;
  }
  return count;
}

/**
 * Cuántas de las IPs `assigned` caen dentro del CIDR, EXCLUYENDO network y broadcast
 * (coherente con `usableIpsInCidr`, que tampoco los cuenta). CIDR basura → 0.
 */
export function countAssignedInCidr(assigned: string[], cidr: string): number {
  const edges = networkEdges(cidr);
  if (!edges) return 0;
  let count = 0;
  for (const n of toIntSet(assigned)) {
    if (n > edges.network && n < edges.broadcast) count++;
  }
  return count;
}
