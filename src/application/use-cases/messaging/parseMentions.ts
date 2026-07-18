/**
 * note-mentions (Ola 6b) — parser PURO de menciones de una nota interna.
 *
 * FORMATO DEL TOKEN (contrato con el FE): `@[Display Name](userId)`
 *   - `Display Name` = texto libre SIN el carácter `]` (lo que el FE muestra inline).
 *   - `userId`       = el id (uuid) del RbacUser mencionado, SIN el carácter `)`.
 * Ej.: `Consultale a @[Juan Pérez](3f2a9c10-...-uuid) sobre el pago`.
 *
 * Se eligió este molde markdown-style (el mismo que usan editores tipo Chatwoot/Slack para
 * serializar menciones) porque es INAMBIGUO frente a texto libre: ni un `@juan` suelto ni un
 * email `juan@empresa.com` ni un `(paréntesis)` cualquiera matchean — SÓLO el token completo
 * `@[...](...)`. Así el parseo nunca "inventa" una mención a partir de prosa normal.
 *
 * Devuelve los userIds ÚNICOS en orden de PRIMERA aparición (dedup: mencionar dos veces al
 * mismo usuario en la misma nota registra una sola mención — refuerza el UNIQUE(message,user)
 * del repositorio). Un token con userId vacío se descarta.
 */
const MENTION_TOKEN = /@\[[^\]]*\]\(([^)]*)\)/g;

export function parseMentions(content: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of content.matchAll(MENTION_TOKEN)) {
    const userId = (match[1] ?? '').trim();
    if (userId === '' || seen.has(userId)) continue;
    seen.add(userId);
    result.push(userId);
  }
  return result;
}
