import { finalizeOcrResult } from '@infrastructure/adapters/ocr/finalizeOcrResult';

describe('finalizeOcrResult', () => {
  it('accepts a well-formed read and canonicalizes the MAC (real qwen2.5vl router)', () => {
    const r = finalizeOcrResult('```json\n{"mac":"DC8E8D156CE6","sn":"1100309242501444"}\n```');
    expect(r.sn).toBe('1100309242501444');
    expect(r.mac).toBe('DC:8E:8D:15:6C:E6');
    expect(r.confidence).toBe(0.8);
  });

  it('nulls a truncated MAC and "null" SN → confidence 0 (real gemma3 antenna)', () => {
    const r = finalizeOcrResult('```json\n{"mac":"E0:63:D4:BE:8E","sn":"null"}\n```');
    expect(r.sn).toBeNull();
    expect(r.mac).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('keeps a valid SN but nulls a malformed MAC (real gemma3 router)', () => {
    const r = finalizeOcrResult('{"mac":"00:24:56:BEA1:92:44","sn":"SN0300245014A"}');
    expect(r.sn).toBe('SN0300245014A');
    expect(r.mac).toBeNull();
    expect(r.confidence).toBe(0.8);
  });

  it('returns nulls and confidence 0 on garbage', () => {
    const r = finalizeOcrResult('cannot read the label');
    expect(r).toMatchObject({ sn: null, mac: null, confidence: 0 });
  });

  it('preserves the raw output for audit', () => {
    const raw = 'some raw {"mac":"DC8E8D156CE6"} text';
    expect(finalizeOcrResult(raw).rawOutput).toBe(raw);
  });
});
