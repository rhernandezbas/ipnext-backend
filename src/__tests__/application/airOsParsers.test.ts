/**
 * airOsParsers.test.ts — TDD
 *
 * Tests de las funciones de parsing PURO (sin SSH) del Ssh2AirOsGateway.
 * Usa la salida real verificada en vivo (de la proposal).
 *
 * Funciones bajo test (exportadas del adapter):
 *   parseMcaStatus(text): { model, ownMac }
 *   parseArpLan(text, ownMac): string[]
 *   parseDhcpLeases(text): Record<mac, hostname>
 */
import {
  parseMcaStatus,
  parseArpLan,
  parseDhcpLeases,
  splitAirOsSections,
} from '@infrastructure/adapters/airos/Ssh2AirOsGateway';

// ── Sample real output (from proposal, validated in vivo) ─────────────────────

const REAL_MCA_STATUS = [
  'deviceName=CPE-CLIENTE,deviceId=78:8A:20:96:6A:AE,firmwareVersion=WA.v8.7.9,',
  'platform=LiteBeam 5AC Gen2,deviceIp=192.168.10.1,uptime=123456,',
].join('');

const REAL_ARP_TABLE = `
IP address       HW type     Flags       HW address            Mask     Device
192.168.11.193   0x1         0x2         c0:c9:e3:34:33:75     *        eth0
192.168.11.194   0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0
192.168.11.1     0x1         0x2         78:8a:20:96:6a:ae     *        ath0
192.168.11.2     0x1         0x0         00:00:00:00:00:00     *        eth0
`;

// Salida real de /tmp/dhcpd.leases verificada en vivo (formato dnsmasq).
const REAL_DHCPD_LEASES = `1717679707 00:5f:67:fc:34:d5 10.22.22.31 TL-WR820N 01:00:5f:67:fc:34:d5
1634034323 00:eb:d8:49:ae:39 10.22.22.116 MW305R 01:00:eb:d8:49:ae:39`;

describe('parseMcaStatus', () => {
  it('extrae platform como model y deviceId como ownMac', () => {
    const result = parseMcaStatus(REAL_MCA_STATUS);
    expect(result.model).toBe('LiteBeam 5AC Gen2');
    expect(result.ownMac).toBe('78:8A:20:96:6A:AE');
  });

  it('retorna nulls para texto vacío', () => {
    const result = parseMcaStatus('');
    expect(result.model).toBeNull();
    expect(result.ownMac).toBeNull();
  });

  it('maneja output sin platform', () => {
    const result = parseMcaStatus('deviceId=78:8A:20:96:6A:AE,firmwareVersion=1.0');
    expect(result.model).toBeNull();
    expect(result.ownMac).toBe('78:8A:20:96:6A:AE');
  });
});

describe('parseArpLan', () => {
  it('retorna solo MACs de eth0 con Flags=0x2, excluyendo la ownMac y zeros', () => {
    const result = parseArpLan(REAL_ARP_TABLE, '78:8A:20:96:6A:AE');
    expect(result).toEqual(['c0:c9:e3:34:33:75', 'aa:bb:cc:dd:ee:ff']);
  });

  it('excluye la ownMac de la antena (case insensitive)', () => {
    // La ownMac aparece en eth0 si también tiene iface LAN
    const arp = `
IP address       HW type     Flags       HW address            Mask     Device
192.168.1.1      0x1         0x2         78:8A:20:96:6A:AE     *        eth0
192.168.1.2      0x1         0x2         c0:c9:e3:34:33:75     *        eth0
`;
    const result = parseArpLan(arp, '78:8a:20:96:6a:ae');
    expect(result).toEqual(['c0:c9:e3:34:33:75']);
  });

  it('retorna array vacío si no hay entradas LAN válidas', () => {
    const arp = `
IP address       HW type     Flags       HW address            Mask     Device
192.168.1.1      0x1         0x0         c0:c9:e3:34:33:75     *        eth0
`;
    const result = parseArpLan(arp, null);
    expect(result).toEqual([]);
  });

  it('retorna array vacío para tabla ARP vacía', () => {
    expect(parseArpLan('', null)).toEqual([]);
  });
});

describe('parseDhcpLeases', () => {
  it('mapea MAC (lowercase) → hostname del lease real', () => {
    const result = parseDhcpLeases(REAL_DHCPD_LEASES);
    expect(result['00:5f:67:fc:34:d5']).toBe('TL-WR820N');
    expect(result['00:eb:d8:49:ae:39']).toBe('MW305R');
  });

  it('normaliza la MAC a minúsculas para el cruce', () => {
    const result = parseDhcpLeases('1717679707 AA:BB:CC:DD:EE:FF 10.0.0.5 MiRouter 01:aa');
    expect(result['aa:bb:cc:dd:ee:ff']).toBe('MiRouter');
  });

  it('ignora hostname "*" (router que no reportó nombre)', () => {
    const result = parseDhcpLeases('1717679707 00:5f:67:fc:34:d5 10.22.22.31 * 01:00:5f:67:fc:34:d5');
    expect(result['00:5f:67:fc:34:d5']).toBeUndefined();
  });

  it('ignora líneas inválidas y vacías', () => {
    const result = parseDhcpLeases('basura\n\n1717679707 zz:zz 10.0.0.1 X');
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('retorna objeto vacío para texto vacío', () => {
    expect(parseDhcpLeases('')).toEqual({});
  });
});

describe('splitAirOsSections', () => {
  it('separa las 3 secciones por líneas-marcador exactas', () => {
    const raw = [
      'deviceId=78:8A:20:96:6A:AE,platform=LiteBeam 5AC Gen2',
      '---ARP---',
      'IP address  HW type  Flags  HW address  Mask  Device',
      '10.22.22.31  0x1  0x2  c0:c9:e3:34:33:75  *  eth0',
      '---LEASES---',
      '1717679707 c0:c9:e3:34:33:75 10.22.22.31 TL-WR820N 01:c0',
    ].join('\n');
    const { mca, arp, leases } = splitAirOsSections(raw);
    expect(mca).toContain('platform=LiteBeam 5AC Gen2');
    expect(arp).toContain('c0:c9:e3:34:33:75');
    expect(arp).not.toContain('TL-WR820N'); // el ARP NO se traga el lease
    expect(leases).toContain('TL-WR820N');
  });

  it('un marcador embebido en una línea de contenido NO cambia de sección', () => {
    const raw = [
      'deviceName=cliente---ARP---raro,deviceId=78:8A:20:96:6A:AE',
      '---ARP---',
      '10.0.0.1  0x1  0x2  c0:c9:e3:34:33:75  *  eth0',
    ].join('\n');
    const { mca, arp } = splitAirOsSections(raw);
    expect(mca).toContain('deviceName=cliente---ARP---raro'); // sigue en mca: la línea no es EXACTA
    expect(arp).toContain('c0:c9:e3:34:33:75');
  });

  it('sin sección de leases (antena en bridge) → leases vacío', () => {
    const raw = 'deviceId=X\n---ARP---\n10.0.0.1  0x1  0x2  c0:c9:e3:34:33:75  *  eth0';
    expect(splitAirOsSections(raw).leases).toBe('');
  });
});
