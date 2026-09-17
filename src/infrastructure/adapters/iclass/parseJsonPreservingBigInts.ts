import axios, { AxiosInstance } from 'axios';

const BIG_DIGIT_RUN = /\d{16}/;
const NUMBER_CHAR = /[0-9.eE+-]/;
const INTEGER = /^-?(0|[1-9]\d*)$/;

/**
 * JSON.parse that returns integers outside Number's safe range as exact strings.
 * IClass ids (pesquisaId, osStatusId) have 18 digits; parsed as numbers they round
 * to the nearest 64 and distinct ids collide.
 */
export function parseJsonPreservingBigInts(text: string): unknown {
  if (!BIG_DIGIT_RUN.test(text)) return JSON.parse(text);

  const out: string[] = [];
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== '-' && (ch < '0' || ch > '9')) continue;

    let end = i + 1;
    while (end < text.length && NUMBER_CHAR.test(text[end])) end++;
    const token = text.slice(i, end);
    if (INTEGER.test(token) && !Number.isSafeInteger(Number(token))) {
      out.push(text.slice(start, i), `"${token}"`);
      start = end;
    }
    i = end - 1;
  }
  out.push(text.slice(start));
  return JSON.parse(out.join(''));
}

function parseBody(data: unknown): unknown {
  if (typeof data !== 'string' || data.trim() === '') return data;
  try {
    return parseJsonPreservingBigInts(data);
  } catch {
    return data;
  }
}

export function createIClassHttp(opts: { baseUrl: string; timeoutMs: number }): AxiosInstance {
  return axios.create({
    baseURL: opts.baseUrl,
    timeout: opts.timeoutMs,
    headers: { 'Content-Type': 'application/json' },
    transformResponse: [parseBody],
  });
}
