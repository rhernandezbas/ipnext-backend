import {
  ipToInt,
  intToIp,
  networkEdges,
  usableIpsInCidr,
  usableIpsInRange,
  countAssignedInRange,
  countAssignedInCidr,
} from '@domain/services/ipMath';

describe('ipMath', () => {
  describe('ipToInt / intToIp', () => {
    it('round-trips a dotted-quad', () => {
      expect(intToIp(ipToInt('100.64.10.42'))).toBe('100.64.10.42');
    });
    it('ipToInt rejects invalid IPv4', () => {
      expect(() => ipToInt('999.1.1.1')).toThrow();
      expect(() => ipToInt('1.2.3')).toThrow();
    });
  });

  describe('networkEdges', () => {
    it('returns network + broadcast of a /24', () => {
      const edges = networkEdges('100.64.10.0/24');
      expect(edges).not.toBeNull();
      expect(intToIp(edges!.network)).toBe('100.64.10.0');
      expect(intToIp(edges!.broadcast)).toBe('100.64.10.255');
    });
    it('returns null for a non-parseable CIDR', () => {
      expect(networkEdges('not-a-cidr')).toBeNull();
      expect(networkEdges('100.64.10.0/40')).toBeNull();
    });
  });

  describe('usableIpsInCidr', () => {
    it('a /24 has 254 usable IPs (minus network + broadcast)', () => {
      expect(usableIpsInCidr('192.168.1.0/24')).toBe(254);
    });
    it('a /16 has 65534 usable IPs', () => {
      expect(usableIpsInCidr('10.0.0.0/16')).toBe(65534);
    });
    it('a /31 has 0 usable IPs (network+broadcast cover all)', () => {
      expect(usableIpsInCidr('10.0.0.0/31')).toBe(0);
    });
    it('a /32 has 0 usable IPs', () => {
      expect(usableIpsInCidr('10.0.0.1/32')).toBe(0);
    });
    it('returns 0 for an unparseable CIDR (graceful)', () => {
      expect(usableIpsInCidr('garbage')).toBe(0);
    });
  });

  describe('usableIpsInRange', () => {
    it('counts inclusive range size', () => {
      expect(usableIpsInRange('100.64.10.2', '100.64.10.5')).toBe(4);
    });
    it('returns 0 when end < start', () => {
      expect(usableIpsInRange('100.64.10.5', '100.64.10.2')).toBe(0);
    });
    it('returns 0 on unparseable bounds (graceful)', () => {
      expect(usableIpsInRange('x', '100.64.10.2')).toBe(0);
    });
  });

  describe('countAssignedInRange', () => {
    it('counts only IPs that fall inside [start, end]', () => {
      const assigned = ['100.64.10.3', '100.64.10.5', '100.64.99.1', 'garbage'];
      expect(countAssignedInRange(assigned, '100.64.10.2', '100.64.10.5')).toBe(2);
    });
    it('dedupes repeated IPs', () => {
      const assigned = ['100.64.10.3', '100.64.10.3'];
      expect(countAssignedInRange(assigned, '100.64.10.2', '100.64.10.5')).toBe(1);
    });
  });

  describe('countAssignedInCidr', () => {
    it('counts IPs inside the CIDR, excluding network + broadcast', () => {
      const assigned = ['100.64.10.0', '100.64.10.5', '100.64.10.255', '10.0.0.1'];
      // .0 (network) and .255 (broadcast) excluded; .5 inside; 10.0.0.1 outside
      expect(countAssignedInCidr(assigned, '100.64.10.0/24')).toBe(1);
    });
    it('returns 0 for an unparseable CIDR (graceful)', () => {
      expect(countAssignedInCidr(['1.2.3.4'], 'garbage')).toBe(0);
    });
  });
});
