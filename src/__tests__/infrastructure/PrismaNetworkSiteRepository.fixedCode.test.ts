/**
 * network-site-fixed-code (#51) — unit test for fixedCodeFor export.
 *
 * toSite() is not exported, but fixedCodeFor() is, and it's the only logic
 * involved in deriving fixedCode from siteNumber.
 *
 * REQ-FC-1: fixedCodeFor(n) === "NODO n"
 * REQ-FC-2: fixedCodeFor(0) === "NODO 0" (edge case)
 * REQ-FC-3: fixedCodeFor works for large numbers
 */
import { fixedCodeFor } from '../../infrastructure/adapters/prisma/PrismaNetworkSiteRepository';

describe('PrismaNetworkSiteRepository — fixedCodeFor', () => {
  it('REQ-FC-1: fixedCodeFor(1) === "NODO 1"', () => {
    expect(fixedCodeFor(1)).toBe('NODO 1');
  });

  it('REQ-FC-1: fixedCodeFor(12) === "NODO 12"', () => {
    expect(fixedCodeFor(12)).toBe('NODO 12');
  });

  it('REQ-FC-2: fixedCodeFor(0) === "NODO 0"', () => {
    expect(fixedCodeFor(0)).toBe('NODO 0');
  });

  it('REQ-FC-3: fixedCodeFor(9999) === "NODO 9999"', () => {
    expect(fixedCodeFor(9999)).toBe('NODO 9999');
  });
});
