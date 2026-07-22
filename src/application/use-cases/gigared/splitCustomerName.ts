/**
 * B8 (D1, hardening OPCIONAL) — split del `Client.name` (campo único, `schema.prisma:174`, sin
 * `firstName`/`lastName` propios) en `{ firstName, lastName }` para alimentar el alta Gigared
 * (`RegisterGigaredAccount`) SIN depender del body del request.
 *
 * Convención APELLIDO-primero: el PRIMER token es el apellido, el resto (unido por espacio) es
 * el nombre. Verificado contra prod: "VACHERAND SILVIO GABRIEL" → apellido "VACHERAND";
 * "CENTENO MIGUEL ANGEL" → apellido "CENTENO" (el email del incidente `centeno12213` es
 * justamente el primer token). Espejo del helper FE `splitName` (`GigaredPanel.tsx:58-67`,
 * comentario "#47e B: the FIRST token is the lastName") — mismo criterio, ambos lados.
 *
 * Fallback: nombre vacío/null/undefined/solo espacios NUNCA tira — degrada al mismo criterio de
 * `normalizeLastName` (`gigaredPassword.ts`), que cae a `'cliente'` cuando no queda nada usable.
 */
const NAME_FALLBACK = 'cliente';

export function splitCustomerName(name: string | null | undefined): { firstName: string; lastName: string } {
  const collapsed = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!collapsed) return { firstName: NAME_FALLBACK, lastName: NAME_FALLBACK };

  const tokens = collapsed.split(' ');
  const lastName = tokens[0]!;
  const firstName = tokens.length > 1 ? tokens.slice(1).join(' ') : lastName;
  return { firstName, lastName };
}
