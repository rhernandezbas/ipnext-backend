import { matchEquipment, EquipmentCandidate } from '@application/services/matchEquipment';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

/** Item factory with sensible defaults; override what each case needs. */
const item = (over: Partial<ContractInstalledItem>): ContractInstalledItem => ({
  id: 'i1',
  contractId: 'C1',
  type: 'ANTENA',
  serialNumber: null,
  mac: null,
  model: null,
  source: 'MANUAL',
  sourceTaskId: null,
  addedByUserId: null,
  confirmedAt: '2026-06-01T00:00:00Z',
  status: 'active',
  notes: null,
  replacesItemId: null,
  assetId: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  ...over,
});

const cand = (over: Partial<EquipmentCandidate>): EquipmentCandidate => ({
  type: 'ANTENA',
  serialNumber: null,
  mac: null,
  ...over,
});

describe('matchEquipment', () => {
  it('matches same_device by MAC (active item)', () => {
    const items = [item({ id: 'a1', mac: '78:8A:20:96:6A:AE' })];
    const r = matchEquipment(cand({ mac: '78:8a:20:96:6a:ae' }), items);
    expect(r.status).toBe('same_device');
    expect(r.item!.id).toBe('a1');
  });

  it('matches same_device by SN (active item)', () => {
    const items = [item({ id: 'a1', serialNumber: 'SN-001' })];
    const r = matchEquipment(cand({ serialNumber: 'sn001' }), items);
    expect(r.status).toBe('same_device');
    expect(r.item!.id).toBe('a1');
  });

  it('normalizes SN: SN-001 == sn001', () => {
    const items = [item({ id: 'a1', serialNumber: 'sn001' })];
    const r = matchEquipment(cand({ serialNumber: 'SN-001' }), items);
    expect(r.status).toBe('same_device');
  });

  it('normalizes MAC: aa:bb == AABB', () => {
    const items = [item({ id: 'a1', mac: 'AABBCCDDEEFF' })];
    const r = matchEquipment(cand({ mac: 'aa:bb:cc:dd:ee:ff' }), items);
    expect(r.status).toBe('same_device');
  });

  it('prefers an ACTIVE same_device over a REMOVED same_device', () => {
    const items = [
      item({ id: 'removed', mac: 'AA:BB:CC:DD:EE:FF', status: 'removed' }),
      item({ id: 'active', mac: 'AA:BB:CC:DD:EE:FF', status: 'active' }),
    ];
    const r = matchEquipment(cand({ mac: 'aabbccddeeff' }), items);
    expect(r.status).toBe('same_device');
    expect(r.item!.id).toBe('active');
  });

  it('matches same_device on a REMOVED item when no active one shares identity (revive)', () => {
    const items = [item({ id: 'removed', mac: 'AA:BB:CC:DD:EE:FF', status: 'removed' })];
    const r = matchEquipment(cand({ mac: 'aabbccddeeff' }), items);
    expect(r.status).toBe('same_device');
    expect(r.item!.id).toBe('removed');
  });

  it('matches same_type when no identity coincides (active)', () => {
    const items = [item({ id: 'a1', type: 'ANTENA', serialNumber: 'SN-OTHER' })];
    const r = matchEquipment(cand({ type: 'ANTENA', mac: '78:8A:20:96:6A:AE' }), items);
    expect(r.status).toBe('same_type');
    expect(r.item!.id).toBe('a1');
  });

  it('prefers an ACTIVE same_type over a REMOVED same_type', () => {
    const items = [
      item({ id: 'removed', type: 'ANTENA', status: 'removed' }),
      item({ id: 'active', type: 'ANTENA', status: 'active' }),
    ];
    const r = matchEquipment(cand({ type: 'ANTENA', mac: '78:8A:20:96:6A:AE' }), items);
    expect(r.status).toBe('same_type');
    expect(r.item!.id).toBe('active');
  });

  it('matches same_type on a REMOVED item when no active same_type exists', () => {
    const items = [item({ id: 'removed', type: 'ANTENA', status: 'removed' })];
    const r = matchEquipment(cand({ type: 'ANTENA', mac: '78:8A:20:96:6A:AE' }), items);
    expect(r.status).toBe('same_type');
    expect(r.item!.id).toBe('removed');
  });

  it('same_device wins over same_type', () => {
    const items = [
      item({ id: 'sametype', type: 'ANTENA', serialNumber: 'SN-OTHER' }),
      item({ id: 'samedevice', type: 'ANTENA', mac: 'AA:BB:CC:DD:EE:FF' }),
    ];
    const r = matchEquipment(cand({ type: 'ANTENA', mac: 'aabbccddeeff' }), items);
    expect(r.status).toBe('same_device');
    expect(r.item!.id).toBe('samedevice');
  });

  it('returns null when nothing matches', () => {
    const items = [item({ id: 'a1', type: 'ROUTER', serialNumber: 'SN-X' })];
    const r = matchEquipment(cand({ type: 'ANTENA', mac: '78:8A:20:96:6A:AE' }), items);
    expect(r.status).toBeNull();
    expect(r.item).toBeNull();
  });

  it('returns null on empty items', () => {
    const r = matchEquipment(cand({ type: 'ANTENA', mac: 'AA:BB:CC:DD:EE:FF' }), []);
    expect(r.status).toBeNull();
    expect(r.item).toBeNull();
  });

  it('does NOT match same_type to a replaced item (only active/removed participate)', () => {
    const items = [item({ id: 'replaced', type: 'ANTENA', status: 'replaced' })];
    const r = matchEquipment(cand({ type: 'ANTENA', mac: 'AA:BB:CC:DD:EE:FF' }), items);
    expect(r.status).toBeNull();
  });
});
