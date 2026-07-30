# Design — `gigared-tv-cic-reuse`

## D1 — Helpers puros de dominio (sin dependencias)

### `src/domain/gigared/tvIdentity.ts` (MODIFICADO)

Se agrega el **inverso** de `currentTvInternalId`:

```ts
export function parseTvInternalId(internalId: string): { clientId: string; seq: number } | null
```

- `^{uuid}$`            → `{ clientId, seq: 0 }`
- `^{uuid}-{digits}$`   → `{ clientId, seq: N }`
- cualquier otra cosa   → `null`

`{uuid}` = `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`.

> **Estricto por diseño.** Si no parsea, la identidad **no es nuestra** y el CIC no se reutiliza. La basura cae al lado seguro (el que no puede causar daño), no al permisivo.

### `src/domain/gigared/cicFormat.ts` (NUEVO)

```ts
export function isValidCicFormat(cic: string | null | undefined): boolean  // /^\d+$/
```

Clase de caracteres, **no** longitud — ver el rationale en `CIC-1` del spec.

### `src/domain/gigared/poolCandidate.ts` (NUEVO)

Clasificador **puro** de la parte síncrona:

```ts
export type CicCandidateKind = 'limpio' | 'malformado' | 'ajeno' | 'requiere-verificacion';

export function classifyPoolEntry(entry: { cic?: string | null; internalId?: string | null }): {
  kind: CicCandidateKind;
  clientId?: string;   // sólo en 'requiere-verificacion'
}
```

Orden de guardas (pinneado): formato del cic → unstamped → parseo de identidad → `requiere-verificacion`.

La tercera condición de la invariante (elegibilidad del cliente) es **asíncrona** y NO vive acá.

## D2 — Puerto nuevo: elegibilidad de reutilización

### `src/domain/ports/TvCicReuseEligibilityRepository.ts` (NUEVO)

```ts
export interface TvCicReuseEligibilityRepository {
  /**
   * True SÓLO si: el cliente existe && tiene tvCancelledAt seteado
   * && NO tiene ninguna fila de ContractService de TV activa.
   * Las tres condiciones se evalúan en la MISMA consulta.
   */
  isEligibleForCicReuse(clientId: string): Promise<boolean>;
}
```

**Por qué un puerto propio y no reusar `ClientTvCancellationRepository.isCancelled`:** la invariante son tres condiciones y una de ellas cruza `ContractService`. Resolverlas por separado en el use case abre una ventana TOCTOU y ensucia la capa de aplicación con lógica de consulta. El puerto expresa la **pregunta de negocio**, no sus partes.

Adapters: `PrismaTvCicReuseEligibilityRepository` (una query con los tres predicados) + `InMemoryTvCicReuseEligibilityRepository` (tests).

> **DIP:** `RegisterGigaredAccount` ya arrastra una violación conocida (importa `@infrastructure/security/gigaredPassword` — deuda registrada en `sdd-init`). **Este change NO agrega ninguna nueva**: todo lo nuevo entra por `@domain`.

## D3 — Errores nuevos

`src/domain/errors/gigared.ts`:

| Error | Código | HTTP | Cuándo |
|---|---|---|---|
| `TvPoolUnavailableError` | `TV_POOL_UNAVAILABLE` | **503** | el listado del pool falló (reintentable) |
| `TvNoUsableCicError` | `TV_NO_USABLE_CIC` | **422** | se agotaron los candidatos del reintento |

`TvPoolPoisonedError` (422) y `NoCicAvailableError` se conservan tal cual.

## D4 — Reescritura de `resolveGigaredAccount`

Orden de guardas **pinneado** (extiende el actual, no lo reemplaza):

```
probe idempotente (sin cambios)
  → listado del pool           [try → TvPoolUnavailableError]
  → clasificación síncrona     [D1]
  → verificación async de los 'requiere-verificacion'   [D2]
  → orden de candidatos: TODOS los 'limpio' primero, después los 'reutilizable'
  → loop acotado (máx 3):
        register → activate → setInternalId → verify post-stamp
        GigaredNotFoundError en `register` → descartar candidato y seguir
        cualquier otro error → propagar
  → candidatos agotados → TvNoUsableCicError
```

### Decisiones cargadas de significado

- **Limpio primero (`POOL-1.6`).** Reutilizar es correcto pero deja un alias permanente. Mientras haya un CIC limpio, se usa ese. La reutilización es el **fallback**, no el default. Esto acota directamente el riesgo aceptado.
- **El reintento sólo cubre `register`.** Un 403/404 ahí prueba que la cuenta no es nuestra ⇒ nada se creó ⇒ reintentar es seguro. Un fallo en `activate` o `setInternalId` ocurre sobre una cuenta que **sí** existe: reintentar con otro CIC dejaría una cuenta huérfana a medio registrar. Esos siguen yendo a `TvIdentityStampUnverifiedError` (503 reintentable), que el probe idempotente resuelve.
- **La verificación async se hace ANTES del loop**, no dentro. Así el conjunto de candidatos es estable y el orden limpio-primero es determinístico.
- **El pick aleatorio se conserva DENTRO de cada grupo** (limpio / reutilizable) para no concentrar la carga en un mismo CIC. Se mantiene el seam `pick` inyectable para los tests.

## D5 — Observabilidad del adapter

`GigaredClient.mapError` — hoy:

```ts
if (type.endsWith('/cic-ownership-error')) return new GigaredNotFoundError();   // ← retorna ANTES del warn
...
if (status !== 404) console.warn('[gigared] upstream', status, type, detail);   // ← nunca ve los 404
```

Se agrega el `console.warn` en la rama `cic-ownership-error` y se cambia la condición del warn genérico para que cubra los 404 **excepto** `empty-accounts_list` (que es un cero-filas esperado y hoy correctamente silencioso).

**Cambio de comportamiento, no de contrato:** `GigaredNotFoundError` se sigue devolviendo igual. Sólo deja de ser mudo.

## D6 — Auditoría

Al completar un alta sobre un CIC **reutilizado**:

1. `AuditEvent` con `action='tv.cic_reused'`, `entityType='GigaredAccount'`, `entityId=cic`, y en el payload el `internal_id` previo + el `clientId` del dueño anterior. Es la fuente **queryable** (el filtro por `entityType` ya existe desde la Fase F del hub).
2. En el `TvActivationEvent`, se appendea `reusedFrom:{internalIdPrevio}` al `reason` — misma convención que el breadcrumb `renewCic:{newCic}` que ya usa `CancelTvJobRunner`, para que el operador lo vea en el Historial de TV.

> **Nota sobre el delimitador:** el `reason` se une con `' · '`, igual que hoy. La deuda de delimitador sin escapar registrada el 2026-07-27 aplica a `ContractService.notes` (`cicFromNotes`), que es **otro campo**. Acá no se introduce parsing nuevo: sólo se escribe.

Ambos son **best-effort**: su fallo nunca aborta un alta ya completada (`AUD-1.3`).

## D7 — Wiring

`app.ts` — inyectar `PrismaTvCicReuseEligibilityRepository` en `RegisterGigaredAccount`.

> **Lección W6 del EPIC #38 (no negociable):** un parámetro nuevo y opcional que no se cablea deja la feature **muerta en producción con el CI en verde**, porque los tests inyectan su propio wiring. Por eso:
>
> 1. La dependencia se cablea explícitamente en `app.ts`.
> 2. Se agrega un **composition-root test** que falla si `RegisterGigaredAccount` se construye sin ella.
>
> Sin ese test, este diseño repite exactamente el fallo que ya nos costó una feature muerta.

## D8 — Qué NO cambia

`CancelTv`, `SetOttStatus`, `AddTvService`, `RemoveTvService`, `GetGigaredCustomerAccount`, el schema de Prisma (**sin migración**), y el contrato del DTO que consume el frontend.

El `setInternalId(newCic, '')` de la baja queda **tal cual**: es un no-op (el partner rechaza el internal_id vacío) y con B1 refinado ya no hace falta que funcione. Tocarlo sería ruido en un change que no toca la baja.
