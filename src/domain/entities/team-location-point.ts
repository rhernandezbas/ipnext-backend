/**
 * Un breadcrumb GPS de una cuadrilla, tal como lo emite IClass (`TeamLocationDTO`).
 *
 * El rastro pertenece a la CUADRILLA, no a la orden de servicio: un técnico registra
 * puntos toda la jornada haya o no haya órdenes (verificado: 233 puntos entre las 06:07
 * y las 21:53 de un día en que la OS asociada ocupaba 2 minutos). La OS es un filtro de
 * consulta sobre el rastro, nunca su origen.
 */
export interface TeamLocationPoint {
  /** Login de la cuadrilla en IClass — clave de negocio estable (el `id` llega `null`). */
  teamLogin: string;
  latitude: number;
  longitude: number;
  /** Instante del fix, ya normalizado a UTC desde la hora argentina que emite IClass. */
  recordedAt: Date;
  /**
   * Precisión reportada por IClass (`raio`), en metros. Se conserva VERBATIM.
   * Rango observado en producción: 3,8 a 102,5 m.
   *
   * **`null` = DESCONOCIDA**, y eso NO es lo mismo que 0. Mapear una precisión ausente
   * a 0 la convierte en "GPS perfecto" y habilita la lectura más dura posible contra el
   * técnico — el default invertido respecto de todo el resto del diseño. Un punto con
   * precisión desconocida puede PROBAR presencia, pero nunca puede condenar.
   */
  accuracyMeters: number | null;
  /**
   * Fuentes del fix (`origem`). Es una lista porque IClass emite el MISMO punto físico
   * por dos vías distintas: se observaron `origem` 1 y 3 con timestamp y coordenadas
   * idénticas. La deduplicación los colapsa en una fila conservando ambos orígenes.
   */
  sources: number[];
}

/** Coordenada de un domicilio (el `endereco` de una orden de servicio). */
export interface GeoCoordinate {
  latitude: number;
  longitude: number;
}

/** Ventana temporal de trabajo de una orden, derivada de su histórico de estados. */
export interface TimeWindow {
  from: Date;
  to: Date;
}

/** Link de Google Maps para un punto — mismo formato que ya devuelve IClass en `maps`. */
export function mapsUrlFor(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}
