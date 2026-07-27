/**
 * haversine — distancia geodésica pura del dominio (sin dependencias externas).
 *
 * Es el núcleo del veredicto de presencia en sitio (capability `iclass-presence-audit`):
 * responde "¿a qué distancia estuvo el técnico del domicilio?" y nada más. No sabe de
 * IClass, de HTTP ni de Prisma — por eso los casos verificados contra la API real se
 * pueden testear acá directamente, sin levantar infraestructura.
 *
 * Precisión: la fórmula de haversine sobre una Tierra esférica (R = 6.371.008,8 m, radio
 * medio IUGG) tiene un error de hasta ~0,5% frente a un modelo elipsoidal. A las escalas
 * que importan acá (decenas de metros para "en sitio", kilómetros para "fuera de sitio")
 * ese error es irrelevante: nunca decide un veredicto. Lo que SÍ decide veredictos es la
 * precisión del GPS (`raio`, de 4 a 100 m), que se resta aparte en presenceEvaluation.
 */

/** Radio medio terrestre IUGG, en metros. */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Distancia sobre la superficie terrestre entre dos puntos, en metros.
 * Siempre >= 0 y simétrica.
 */
export function haversineMeters(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const phiA = toRadians(latA);
  const phiB = toRadians(latB);
  const deltaPhi = toRadians(latB - latA);
  const deltaLambda = toRadians(lonB - lonA);

  const sinHalfPhi = Math.sin(deltaPhi / 2);
  const sinHalfLambda = Math.sin(deltaLambda / 2);

  const a =
    sinHalfPhi * sinHalfPhi +
    Math.cos(phiA) * Math.cos(phiB) * sinHalfLambda * sinHalfLambda;

  // clamp defensivo: el redondeo de punto flotante puede empujar `a` apenas por
  // encima de 1 en puntos antipodales y volver NaN el asin.
  const clamped = Math.min(1, Math.max(0, a));

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(clamped));
}
