import { IpKind, IpPool } from '@domain/entities/network';

/**
 * ipKindSupport — resuelve QUÉ CLASES DE IP puede asignar un NAS, y qué clase debe usar un
 * move hacia ese NAS. Dominio PURO: sin IO, sin excepciones.
 *
 * ⚠️ Por qué UNA sola función por concepto: la consumen los DOS caminos —
 *   - `MovePppoeToNas` (AUTORIDAD: decide de qué pool sacar la IP)
 *   - el DTO de NAS vía `NasLiveStatsProvider` (HINT: qué tipos ofrece el FE)
 * Si cada capa lo calculara por separado, el FE ofrecería una clase que el backend rechaza,
 * o esconderría una que aceptaría. Ese es exactamente el modo de falla que este módulo elimina.
 *
 * ⚠️ El predicado es IDÉNTICO al del allocator (`FindFreeIp` → `pools.filter(p => p.ipKind
 * === input.type)`): SOLO `ipKind`. La entidad `IpPool` del dominio no expone `status`, así
 * que no se filtra por él. Cualquier divergencia entre estos dos predicados reintroduce el bug.
 *
 * Contexto del bug que motivó esto (2026-07-29): `MovePppoeToNas` hardcodeaba `'cgnat'`. Cuando
 * el NE8000 migró a 100% públicas (julio 2026) quedó imposible mover un servicio ahí — 3272 de
 * los 5468 servicios de la red. Nada lo detectó porque los tests ejercitaban NAS con pools cgnat.
 */

/** Orden canónico. Fijo para que el FE renderice siempre igual (sin bailes de layout). */
const KIND_ORDER: readonly IpKind[] = ['cgnat', 'public'];

/**
 * Clases de IP que el NAS puede asignar, derivadas de sus pools.
 *
 * Derivado, NUNCA persistido: la fuente de verdad son los pools. Un pool que se agrega o se
 * borra cambia la respuesta sin migración ni caché que invalidar. Persistirlo crearía un
 * segundo lugar capaz de driftear del primero — el bug original, otra vez.
 *
 * @param pools pools del NAS (ya filtrados por `nasId` por el caller)
 * @returns las clases soportadas en orden canónico. `[]` = ninguna (NO se asume nada).
 */
export function supportedIpKinds(pools: readonly IpPool[]): IpKind[] {
  return KIND_ORDER.filter((kind) => pools.some((p) => p.ipKind === kind));
}

/**
 * Clase de pool que debe usar un move NORMAL (con NAS origen) hacia un NAS destino.
 *
 * ⚠️ SOLO para moves normales. La ADOPCIÓN de un pendiente (`nasId === null`) NO pasa por acá:
 * ahí el `ipTypePreference` es un REQUISITO, no una preferencia — un pendiente marcado 'public'
 * hacia un NAS sin pool público debe FALLAR (`NoPoolForNasTypeError`), no recibir una CGNAT en
 * silencio, porque eso violaría la intención explícita del operador. Ese camino sigue usando
 * `s.ipTypePreference` directo, intacto.
 *
 * Regla (deliberadamente CONSERVADORA — pineada por el test "regresión W1"):
 *   1. el destino soporta 'cgnat'  -> 'cgnat'   ← semántica W1 EXACTA, incluso si la
 *                                                 preferencia persistida es 'public'
 *   2. si no, soporta 'public'     -> 'public'  ← CONVERSIÓN (el fix del NE8000)
 *   3. ninguna                     -> null
 *
 * **Por qué la preferencia NO manda en un move normal:** la W1 lo decidió así a propósito y hay
 * un test que lo pinea. Un move normal es el operador eligiendo un destino explícitamente; el
 * cambio de clase se hace por su propio camino (el update con `ipTypePreference`). Honrar la
 * preferencia acá cambiaría el comportamiento de servicios existentes marcados 'public' que hoy
 * reciben cgnat al moverse — regresión silenciosa, fuera del alcance de este fix.
 *
 * @param supported clases soportadas por el NAS DESTINO (de `supportedIpKinds`)
 * @returns la clase a usar, o `null` si el move es imposible (el caller lo traduce al error
 *          tipado `NoPoolForNasTypeError` y aborta ANTES de mutar nada).
 */
export function resolveMovePoolType(supported: readonly IpKind[]): IpKind | null {
  if (supported.includes('cgnat')) return 'cgnat';
  if (supported.includes('public')) return 'public';
  return null;
}
