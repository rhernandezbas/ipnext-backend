/**
 * Quita comentarios de bloque y de línea de un fuente TypeScript.
 *
 * POR QUÉ existe como helper compartido: los guards de composition-root leen app.ts como TEXTO
 * (bootear createApp() necesita una DB viva). Si el match corre sobre el fuente crudo, un
 * comentario que mencione el identificador SATISFACE la aserción y el guard miente. Ya pasó:
 * `gigared-composition.test.ts` tenía un bloque nuevo sin stripear y una regresión REAL —el wiring
 * correcto comentado y al lado una construcción sin las deps— lo atravesaba en verde, mientras el
 * guard viejo (que sí stripeaba) la cazaba.
 *
 * Vivía duplicado en `gigared-composition.cicReuse.test.ts`. Dos copias de la misma regla es
 * exactamente el patrón que hace que el test certifique una y producción corra la otra.
 *
 * El `(^|[^:])` del segundo replace es para no comerse el `//` de una URL (`http://x`).
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
