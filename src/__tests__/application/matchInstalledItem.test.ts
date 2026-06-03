import { normSn, normMac, matchInstalledItem, toSuggestionMatch, MatchResult } from '@application/services/matchInstalledItem';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

const makeItem = (over: Partial<ContractInstalledItem> = {}): ContractInstalledItem => ({
  id: 'i1', contractId: 'svc1', type: 'ROUTER', serialNumber: null, mac: null, model: null,
  source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
  status: 'active', notes: null, createdAt: 'x', updatedAt: 'x',
  replacesItemId: null,
  ...over,
});

const makeSug = (over: Partial<TaskInventorySuggestion> = {}): TaskInventorySuggestion => ({
  id: 's1', taskId: 't1', kind: 'DEVICE', deviceType: 'ROUTER', qwenDeviceType: null,
  serialNumber: null, mac: null,
  materialDesc: null, quantity: null, unit: null, source: 'OCR', photoUrl: null,
  status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z',
  ...over,
});

describe('normSn', () => {
  it('trims and uppercases', () => expect(normSn('  abc123  ')).toBe('ABC123'));
  it('empty string → null', () => expect(normSn('')).toBeNull());
  it('null → null', () => expect(normSn(null)).toBeNull());
  it('undefined → null', () => expect(normSn(undefined)).toBeNull());
  it('whitespace-only → null', () => expect(normSn('   ')).toBeNull());
});

describe('normMac', () => {
  it('strips colons and uppercases', () => expect(normMac('aa:bb:cc:dd:ee:ff')).toBe('AABBCCDDEEFF'));
  it('strips dashes and uppercases', () => expect(normMac('AA-BB-CC')).toBe('AABBCC'));
  it('empty string → null', () => expect(normMac('')).toBeNull());
  it('null → null', () => expect(normMac(null)).toBeNull());
  it('whitespace-only → null', () => expect(normMac('   ')).toBeNull());
});

describe('matchInstalledItem', () => {
  it('MATERIAL suggestion → { status: null, item: null }', () => {
    const s = makeSug({ kind: 'MATERIAL', deviceType: null });
    const result = matchInstalledItem(s, [makeItem()]);
    expect(result.status).toBeNull();
    expect(result.item).toBeNull();
  });

  it('same_device by SN', () => {
    const s = makeSug({ serialNumber: 'R1' });
    const item = makeItem({ serialNumber: 'R1' });
    const result = matchInstalledItem(s, [item]);
    expect(result.status).toBe('same_device');
    expect(result.item).toBe(item);
  });

  it('same_device by MAC', () => {
    const s = makeSug({ mac: 'aa:bb:cc:dd:ee:ff', serialNumber: 'OTHER' });
    const item = makeItem({ mac: 'AABBCCDDEEFF', serialNumber: 'DIFFERENT' });
    const result = matchInstalledItem(s, [item]);
    expect(result.status).toBe('same_device');
    expect(result.item).toBe(item);
  });

  it('same_device wins over same_type when SN matches', () => {
    const itemById = makeItem({ id: 'i1', serialNumber: 'R1', type: 'ROUTER' });
    const itemByType = makeItem({ id: 'i2', serialNumber: 'DIFFERENT', type: 'ROUTER' });
    const s = makeSug({ serialNumber: 'R1', deviceType: 'ROUTER' });
    const result = matchInstalledItem(s, [itemById, itemByType]);
    expect(result.status).toBe('same_device');
    expect(result.item!.id).toBe('i1');
  });

  it('same_type when SN differs but type matches', () => {
    const item = makeItem({ id: 'i1', type: 'ROUTER', serialNumber: 'SN_OTHER' });
    const s = makeSug({ deviceType: 'ROUTER', serialNumber: 'SN_DIFF' });
    const result = matchInstalledItem(s, [item]);
    expect(result.status).toBe('same_type');
    expect(result.item).toBe(item);
  });

  it('no match → { status: null, item: null }', () => {
    const item = makeItem({ type: 'ONU', serialNumber: 'SN_ONU' });
    const s = makeSug({ deviceType: 'ROUTER', serialNumber: 'SN_ROUTER' });
    const result = matchInstalledItem(s, [item]);
    expect(result.status).toBeNull();
    expect(result.item).toBeNull();
  });

  it('item with status=replaced is NOT matched (caller must pass active-only)', () => {
    // The helper matches whatever is passed; active-only is enforced by the caller.
    // Here we test that if the caller passes only active items, replaced items are excluded.
    const replacedItem = makeItem({ id: 'i1', type: 'ROUTER', serialNumber: 'R1', status: 'replaced' });
    const activeItems = [] as ContractInstalledItem[]; // replaced not passed
    const s = makeSug({ deviceType: 'ROUTER', serialNumber: 'R1' });
    const result = matchInstalledItem(s, activeItems);
    expect(result.status).toBeNull();
    expect(result.item).toBeNull();
  });

  it('item with status=removed is NOT matched (caller must pass active-only)', () => {
    const activeItems = [] as ContractInstalledItem[]; // removed not passed
    const s = makeSug({ deviceType: 'ROUTER', serialNumber: 'R1' });
    const result = matchInstalledItem(s, activeItems);
    expect(result.status).toBeNull();
  });
});

describe('toSuggestionMatch', () => {
  it('MatchResult with null status → null', () => {
    const r: MatchResult = { status: null, item: null };
    expect(toSuggestionMatch(r)).toBeNull();
  });

  it('MatchResult with item → { status, itemId, serial }', () => {
    const item = makeItem({ id: 'i1', serialNumber: 'SN1' });
    const r: MatchResult = { status: 'same_device', item };
    const match = toSuggestionMatch(r);
    expect(match).not.toBeNull();
    expect(match!.status).toBe('same_device');
    expect(match!.itemId).toBe('i1');
    expect(match!.serial).toBe('SN1');
  });

  it('same_type match → { status: "same_type", itemId, serial }', () => {
    const item = makeItem({ id: 'i2', serialNumber: null });
    const r: MatchResult = { status: 'same_type', item };
    const match = toSuggestionMatch(r);
    expect(match!.status).toBe('same_type');
    expect(match!.itemId).toBe('i2');
    expect(match!.serial).toBeNull();
  });
});
