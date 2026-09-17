import { parseJsonPreservingBigInts, createIClassHttp } from '@infrastructure/adapters/iclass/parseJsonPreservingBigInts';
import { IClassClient, parseChecklist, parseHistoryEntry } from '@infrastructure/adapters/iclass/IClassClient';

// Real ids from production: both round to 487893560676504500 as a JS number, which
// made two different surveys collide on the unique iclassSurveyId column.
const SURVEY_A = '487893560676504488';
const SURVEY_B = '487893560676504500';

describe('parseJsonPreservingBigInts', () => {
  it('keeps integers beyond Number.MAX_SAFE_INTEGER as exact strings', () => {
    const parsed = parseJsonPreservingBigInts(`[{"pesquisaId":${SURVEY_A}},{"pesquisaId":${SURVEY_B}}]`) as Array<{ pesquisaId: unknown }>;

    expect(parsed[0].pesquisaId).toBe(SURVEY_A);
    expect(parsed[1].pesquisaId).toBe(SURVEY_B);
    expect(parsed[0].pesquisaId).not.toBe(parsed[1].pesquisaId);
  });

  it('leaves safe integers, decimals, negatives and exponents as numbers', () => {
    const parsed = parseJsonPreservingBigInts('{"id":101040838503,"lat":-34.64948,"n":-7,"e":1.5e3,"max":9007199254740991}');

    expect(parsed).toEqual({ id: 101040838503, lat: -34.64948, n: -7, e: 1500, max: 9007199254740991 });
  });

  it('does not touch digits inside strings, including escaped quotes', () => {
    const parsed = parseJsonPreservingBigInts(`{"obs":"code ${SURVEY_A} \\"q\\" 12345678901234567890","v":${SURVEY_A}}`);

    expect(parsed).toEqual({ obs: `code ${SURVEY_A} "q" 12345678901234567890`, v: SURVEY_A });
  });

  it('preserves big negative integers', () => {
    expect(parseJsonPreservingBigInts('[-487893560676504488]')).toEqual(['-487893560676504488']);
  });

  it('still rejects invalid JSON such as big integers with leading zeros', () => {
    expect(() => parseJsonPreservingBigInts('{"id":01234567890123456789}')).toThrow(SyntaxError);
  });
});

describe('createIClassHttp', () => {
  const transform = (body: unknown) => {
    const http = createIClassHttp({ baseUrl: 'http://iclass.test', timeoutMs: 1000 });
    const fns = http.defaults.transformResponse as Array<(d: unknown) => unknown>;
    return fns.reduce((acc, fn) => fn(acc), body);
  };

  it('parses JSON bodies preserving big ids', () => {
    expect(transform(`{"objects":[{"pesquisaId":${SURVEY_A}}]}`)).toEqual({ objects: [{ pesquisaId: SURVEY_A }] });
  });

  it('returns non-JSON and empty bodies unchanged', () => {
    expect(transform('<html>maintenance</html>')).toBe('<html>maintenance</html>');
    expect(transform('')).toBe('');
  });

  it('is the transport IClassClient builds when no http is injected', () => {
    const client = new IClassClient({ baseUrl: 'http://iclass.test', username: 'u', password: 'p', thirdPartyId: '1' });
    const fns = (client as unknown as { http: { defaults: { transformResponse: Array<(d: unknown) => unknown> } } }).http.defaults.transformResponse;

    expect(fns.reduce<unknown>((acc, fn) => fn(acc), `{"pesquisaId":${SURVEY_A}}`)).toEqual({ pesquisaId: SURVEY_A });
  });

  it('feeds exact ids into the closure-loop parsers', () => {
    const body = transform(`{"pesquisaId":${SURVEY_A},"perguntas":[]}`) as Record<string, unknown>;
    const history = transform(`{"osStatusId":487910040685075843,"data":"17-09-2026 02:51:00","statusOS":{"codigo":"4"}}`) as Record<string, unknown>;

    expect(parseChecklist(body).iclassSurveyId).toBe(SURVEY_A);
    expect(parseHistoryEntry(history).iclassOsStatusId).toBe('487910040685075843');
  });
});
