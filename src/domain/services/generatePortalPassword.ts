/**
 * generatePortalPassword — customer-portal-api (Fase 2, task 2.1).
 *
 * Cryptographic, dictation-friendly password for a NEW/regenerated PortalAccount.
 * Format `XXXX-9999-XXXX`: 4 uppercase letters, 4 digits, 4 uppercase letters,
 * dash-separated. Ambiguous characters (O/0, I/1) are excluded from BOTH alphabets —
 * an operator reading this out over the phone/WhatsApp must never have to guess
 * "was that the letter O or the digit zero".
 *
 * `crypto.randomInt` (Node core, not a framework) — same precedent as
 * `sessionToken.ts`'s use of `crypto.createHash`. Pure domain: no DB, no network,
 * no clock dependency to inject (randomness itself is the only external input, same
 * as elsewhere in the domain that generates ids).
 */
import { randomInt } from 'crypto';

// A-Z minus O and I — 24 characters.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
// 2-9 — excludes 0 and 1 (visually confusable with O/I).
const DIGITS = '23456789';

function randomChars(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

export function generatePortalPassword(): string {
  const first = randomChars(LETTERS, 4);
  const middle = randomChars(DIGITS, 4);
  const last = randomChars(LETTERS, 4);
  return `${first}-${middle}-${last}`;
}
