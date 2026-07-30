/**
 * gigared-tv-cic-reuse — clasificador PURO de una entrada del pool `unregistered` del partner.
 *
 * Refina el filtro anti-veneno B1 (nacido del incidente Centeno), que rechazaba TODO cic
 * estampado sin mirar de quién era la identidad. B1 no distinguía dos casos que no se parecen:
 *
 *   - PELIGROSO — el cic carga la identidad de un tercero VIVO: se asignaría en silencio a otro
 *     cliente y nadie se enteraría. Es el incidente Centeno. SIGUE BLOQUEADO.
 *   - SEGURO — el cic carga la identidad de un cliente NUESTRO ya severado localmente
 *     (`tvCancelledAt`). Reutilizarlo es exactamente el comportamiento deseado: es lo que la
 *     baja produce a propósito (`renewCic` borra los datos y devuelve el slot al pool).
 *
 * Este módulo resuelve la parte SÍNCRONA de la clasificación. La tercera condición de la
 * invariante —la elegibilidad del cliente— es asíncrona y vive detrás de
 * `TvCicReuseEligibilityRepository`, porque cruza el mirror local.
 *
 * Helper PURO de dominio: sin dependencias externas, sin I/O, sin mutación de la entrada.
 */
import { isValidCicFormat } from './cicFormat';
import { parseTvInternalId } from './tvIdentity';

export type CicCandidateKind =
  /** cic válido y sin identidad colgada — el candidato PREFERIDO. */
  | 'limpio'
  /** el cic en sí no sirve (vacío o con caracteres no numéricos). Nunca candidato. */
  | 'malformado'
  /** la identidad colgada no es nuestra, o no supera la verificación. Nunca candidato. */
  | 'ajeno'
  /** la identidad es nuestra: falta preguntarle al mirror si el cliente es elegible. */
  | 'requiere-verificacion';

export interface PoolEntryClassification {
  kind: CicCandidateKind;
  /** Presente SÓLO en `requiere-verificacion`: el Client.id derivado del internal_id. */
  clientId?: string;
}

export interface PoolEntryLike {
  cic?: string | null;
  internalId?: string | null;
}

/**
 * F5(b) del hardening previo — un `internalId` "sin estampar": null, undefined o ''.
 * El shape real del adapter puede devolver `undefined`, así que `== null` cubre ambos.
 */
export function isUnstamped(
  internalId: string | null | undefined,
): internalId is '' | null | undefined {
  // La firma es un TYPE GUARD a propósito: el discriminador por email de RegisterGigaredAccount
  // depende de que el `else` narrowee `internalId` a `string` (si no, `TvEmailOwnedByOtherError`
  // recibiría `string | null`). Degradarla a `boolean` compila acá y rompe allá.
  return internalId == null || internalId === '';
}

/**
 * ORDEN DE GUARDAS (pinneado — hay un test que lo fija):
 *   formato del cic → sin estampar → identidad parseable → requiere-verificacion.
 *
 * El formato va PRIMERO a propósito: un cic inservible no sirve para nada, aunque su
 * identidad hubiera sido reutilizable.
 */
export function classifyPoolEntry(entry: PoolEntryLike): PoolEntryClassification {
  if (!isValidCicFormat(entry.cic)) return { kind: 'malformado' };
  if (isUnstamped(entry.internalId)) return { kind: 'limpio' };

  const parsed = parseTvInternalId(entry.internalId);
  if (parsed === null) return { kind: 'ajeno' };

  return { kind: 'requiere-verificacion', clientId: parsed.clientId };
}
