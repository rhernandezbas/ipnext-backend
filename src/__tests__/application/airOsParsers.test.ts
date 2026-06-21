/**
 * airOsParsers.test.ts — TDD
 *
 * Tests de las funciones de parsing PURO (sin SSH) del Ssh2AirOsGateway.
 * Usa la salida real verificada en vivo (de la proposal).
 *
 * Funciones bajo test (exportadas del adapter):
 *   parseMcaStatus(text): { model, ownMac }
 *   parseArpLan(text, ownMac): string[]
 */
import {
  parseMcaStatus,
  parseArpLan,
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
