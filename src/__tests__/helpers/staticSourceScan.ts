/**
 * Shared scanner for the static-source architecture guards (NOT a test file — it lives
 * outside the `*.test.ts` pattern on purpose).
 *
 * FIX-F / FIX-G(b) (fix wave 2 W1a) — `stripComments` and the balanced-delimiter parser
 * were COPY-PASTED per guard: `taskClosureGuard.test.ts` had the good version and
 * `closureRecorderWiring.test.ts` a weaker one, so a fix to one left the sibling broken
 * (memoria: "fix wave: buscar el hermano"). One implementation, imported by both.
 */

/**
 * Remove `//` and block comments — WITHOUT touching what lives inside a string,
 * template or regex literal.
 *
 * FIX-F — the first version was two blind regexes over raw text
 * (`/\/\*[\s\S]*?\*\//g` + `/\/\/.*$/gm`). Any `//` inside a string literal — an
 * ordinary `'https://wiki/...'` — was treated as a comment opener and everything after
 * it on that line was DELETED, taking a real violation on the same line with it; a
 * `/*` inside a string swallowed whole LINES up to the next closer. Both are silent
 * FALSE NEGATIVES: the guard stays green over source that closes the task by hand.
 *
 * So this is a small tokenizer instead: it walks the source once, tracking whether it
 * is inside a `'`/`"`/`` ` `` literal (honouring backslash escapes) or a regex literal,
 * and only recognises a comment opener in ordinary code position. Regex literals are
 * detected with the classic heuristic — a `/` starts a regex when the previous
 * significant character cannot end an expression — because `/['"]/` would otherwise
 * look like an unterminated string and desync everything after it.
 *
 * MEDIUM-2 (fix wave 3) — the "previous significant character" is not enough: after a
 * KEYWORD (`return /re/`, `await /re/`, `typeof /re/`, `case /re/`…) that character is a
 * plain LETTER, so the `/` read as a division and the literal went untokenized. With the
 * commonest regex of all — one matching a URL, `/https:\/\//` — the last two characters
 * of the literal are `//`, which the stripper then took for a line-comment opener and
 * DELETED the rest of the line, taking any violation living on that same line with it.
 * Same silent false negative as FIX-F, different door. Now a `/` also opens a regex when
 * the preceding token is one of those keywords, matched as a WHOLE WORD (an identifier
 * ending in `return`, or a property named `.in`, must stay a division).
 *
 * Residual, on purpose: the heuristic is not a full JS parser. It is exercised against
 * the whole production tree on every run, and the two allowlisted adapters carry an
 * EXACT-COUNT pin (FIX-E) that goes red the moment the stripper starts swallowing their
 * closure write — that pair is the live canary for a desync, not this comment.
 */

/**
 * MEDIUM-2 — keywords after which a `/` can only start a REGEX, never a division: none of
 * them can END an expression. Deliberately excludes anything ambiguous (an identifier, a
 * `)`, a `]`) — when in doubt the safe side is "division", which never deletes a line.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'void',
  'delete', 'do', 'else', 'instanceof', 'new', 'throw', 'yield', 'await',
]);

/**
 * The trailing identifier of already-emitted text, ignoring trailing whitespace. Returns
 * '' when there is none or when it is a PROPERTY access (`cfg.in`) — a property named like
 * a keyword is an ordinary value and a `/` after it is a division. O(word length): it
 * walks backwards a handful of characters, never the whole buffer.
 */
function trailingWord(out: string): string {
  const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
  let end = out.length;
  while (end > 0 && /\s/.test(out[end - 1]!)) end--;
  let start = end;
  while (start > 0 && isIdent(out[start - 1]!)) start--;
  if (start === end) return '';
  if (start > 0 && out[start - 1] === '.') return ''; // cfg.in / 2 → división
  return out.slice(start, end);
}

export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  /** Last emitted non-whitespace char — decides `/` = regex vs division. */
  let lastSignificant = '';
  const canPrecedeRegex = (ch: string): boolean =>
    ch === '' || '([{,;:=!&|?+-*%~^<>'.includes(ch);
  /** MEDIUM-2 — …or the previous TOKEN is a keyword that cannot end an expression. */
  const inRegexPosition = (): boolean =>
    canPrecedeRegex(lastSignificant) || REGEX_PRECEDING_KEYWORDS.has(trailingWord(out));

  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];

    // ── comment openers (only reachable in code position) ──
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue; // keep the '\n' so line-oriented reading still works
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // ── string / template literal: copy verbatim to the matching quote ──
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i]!;
        if (c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue; }
        out += c;
        i++;
        if (c === ch) break;
        // A plain quote never spans lines; bail on the newline instead of eating the
        // rest of the file (an apostrophe in prose, a typo…).
        if (c === '\n' && ch !== '`') break;
      }
      lastSignificant = ch;
      continue;
    }

    // ── regex literal: `/['"]/` must not look like an unterminated string ──
    if (ch === '/' && inRegexPosition()) {
      let j = i + 1;
      let closed = false;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        const c = src[j]!;
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) {
        out += src.slice(i, j);
        i = j;
        lastSignificant = '/';
        continue;
      }
      // Not a regex after all (a stray division) — fall through as a plain char.
    }

    out += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }
  return out;
}

/**
 * Extract the FULL argument text of every call to `<token>(`, balancing (), {} and []
 * and skipping ' " ` string literals. Unlike a non-greedy regex this never truncates on
 * a nested call and never needs a lookahead for what follows the closing paren.
 */
export function extractCallArgs(src: string, token: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const hit = src.indexOf(token, from);
    if (hit === -1) break;
    let i = hit + token.length; // just past the '('
    const start = i;
    let depth = 1;
    let quote: string | null = null;
    while (i < src.length && depth > 0) {
      const ch = src[i]!;
      if (quote) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '(' || ch === '{' || ch === '[') {
        depth++;
      } else if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
      }
      i++;
    }
    // depth===0 → i is one past the matching ')'. Unbalanced (truncated file) → skip.
    if (depth === 0) out.push(src.slice(start, i - 1));
    from = hit + token.length;
  }
  return out;
}

/**
 * Split an argument text on its TOP-LEVEL commas (the ones not nested inside (), {},
 * [] or a string). `f(a, {b: 1, c: 2}, [x, y])` → `['a', '{b: 1, c: 2}', '[x, y]']`.
 */
export function splitTopLevelArgs(callArgs: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < callArgs.length; i++) {
    const ch = callArgs[i]!;
    if (quote) {
      current += ch;
      if (ch === '\\') { current += callArgs[i + 1] ?? ''; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

/**
 * Top-level entries of an object literal text (`'{ ...spread(), a: 1 }'` →
 * `['...spread()', 'a: 1']`). Returns null when the text is not an object literal.
 */
export function objectLiteralEntries(text: string): string[] | null {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  return splitTopLevelArgs(t.slice(1, -1).trim()).filter(e => e.length > 0);
}

/**
 * FIX-E — extract the BODY of `async <name>(...)` with balanced braces, skipping string
 * literals. Lets an allowlist be checked per CALL (is the write inside the method that
 * is allowed to do it?) instead of per FILE.
 */
export function methodBody(src: string, name: string): string | null {
  const hit = src.indexOf(`async ${name}(`);
  if (hit === -1) return null;
  let i = hit + `async ${name}`.length; // at the '('
  let depth = 0;
  let quote: string | null = null;
  // 1) walk the parameter list + return type until the '{' that opens the body
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '{' && depth === 0) break;
  }
  if (i >= src.length) return null;
  // 2) balance braces from the body opener
  const start = i;
  let braces = 0;
  quote = null;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') braces++;
    else if (ch === '}') {
      braces--;
      if (braces === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
