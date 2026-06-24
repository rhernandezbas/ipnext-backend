/**
 * TDD — pppoeDisplayStatus (internet-history).
 *
 * Pure domain function: maps the RADIUS-level `status` (enabled|disabled|terminated) + the
 * enforcement `enforcedState` (active|reduced|blocked) into a single BUSINESS status the UI
 * understands: 'active' | 'reduced' | 'blocked' | 'baja' | 'inactive'.
 *
 * Precedence (exact, top wins):
 *   1. status === 'terminated'                              → 'baja'
 *   2. status === 'disabled' OR enforcedState === 'blocked' → 'blocked'
 *   3. enforcedState === 'reduced'                          → 'reduced'
 *   4. status === 'enabled' AND enforcedState === 'active'  → 'active'
 *   5. default (defensive)                                  → 'inactive'
 */
import { pppoeDisplayStatus } from '@domain/entities/pppoeService';

describe('pppoeDisplayStatus — business status (internet-history)', () => {
  it("terminated → 'baja' (takes precedence over everything)", () => {
    expect(pppoeDisplayStatus('terminated', 'active')).toBe('baja');
    expect(pppoeDisplayStatus('terminated', 'reduced')).toBe('baja');
    expect(pppoeDisplayStatus('terminated', 'blocked')).toBe('baja');
  });

  it("disabled secret → 'blocked'", () => {
    expect(pppoeDisplayStatus('disabled', 'active')).toBe('blocked');
    expect(pppoeDisplayStatus('disabled', 'reduced')).toBe('blocked');
    expect(pppoeDisplayStatus('disabled', 'blocked')).toBe('blocked');
  });

  it("enforcedState blocked → 'blocked' (even if secret enabled)", () => {
    expect(pppoeDisplayStatus('enabled', 'blocked')).toBe('blocked');
  });

  it("enforcedState reduced (secret enabled) → 'reduced'", () => {
    expect(pppoeDisplayStatus('enabled', 'reduced')).toBe('reduced');
  });

  it("blocked precedence beats reduced — disabled + reduced → 'blocked'", () => {
    expect(pppoeDisplayStatus('disabled', 'reduced')).toBe('blocked');
  });

  it("enabled + active → 'active'", () => {
    expect(pppoeDisplayStatus('enabled', 'active')).toBe('active');
  });

  it("default defensive → 'inactive' for unknown status with active enforcement", () => {
    expect(pppoeDisplayStatus('weird', 'active')).toBe('inactive');
    expect(pppoeDisplayStatus('', 'active')).toBe('inactive');
  });
});
