import { parseOcrResponse } from '@infrastructure/adapters/ocr/parseOcrResponse';

describe('parseOcrResponse', () => {
  it('parses a ```json fenced reply', () => {
    const r = parseOcrResponse('```json\n{"mac":"DC8E8D156CE6","sn":"1100309242501444"}\n```');
    expect(r).toEqual({ mac: 'DC8E8D156CE6', sn: '1100309242501444', deviceType: null });
  });

  it('parses plain JSON with surrounding prose', () => {
    const r = parseOcrResponse('Here is the data: {"sn":"SN1","mac":"AA:BB"} hope it helps');
    expect(r).toEqual({ sn: 'SN1', mac: 'AA:BB', deviceType: null });
  });

  it('extracts device_type when present (raw, unnormalized)', () => {
    const r = parseOcrResponse('{"mac":"AA","sn":"BB","device_type":"ONU"}');
    expect(r).toEqual({ mac: 'AA', sn: 'BB', deviceType: 'ONU' });
  });

  it('device_type missing or non-string → null', () => {
    expect(parseOcrResponse('{"mac":"AA","sn":"BB"}').deviceType).toBeNull();
    expect(parseOcrResponse('{"mac":"AA","sn":"BB","device_type":123}').deviceType).toBeNull();
  });

  it('normalizes "null"/"N/A"/empty to null (never invents)', () => {
    expect(parseOcrResponse('{"mac":"null","sn":"  "}')).toEqual({ mac: null, sn: null, deviceType: null });
    expect(parseOcrResponse('{"mac":"N/A","sn":"X"}')).toEqual({ mac: null, sn: 'X', deviceType: null });
  });

  it('returns nulls on garbage / no JSON', () => {
    expect(parseOcrResponse('cannot read the label')).toEqual({ sn: null, mac: null, deviceType: null });
    expect(parseOcrResponse('{ broken')).toEqual({ sn: null, mac: null, deviceType: null });
  });
});
