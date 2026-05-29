# Spec: GR Client Reconcile (read-only diagnosis)

**Capability**: `gr-client-reconcile` (NEW)
**Change**: `gr-clients-full-universe`
**Summary**: Endpoint de diagnóstico read-only que compara el universo completo de clientes de Gestión Real (GR) contra el espejo local y devuelve el set-diff bidireccional (`localOnly` + `grOnly`) con sus conteos. NO escribe datos.

---

## Added Requirements

### REQ-REC-PORT-1: Use case read-only sobre puertos de dominio

El sistema MUST exponer un use case `ReconcileGrClients` en `src/application/use-cases/` que:

- Dependa de `GestionRealPort` (lectura del universo completo de GR, reusando `fetchClients` paginado SIN filtro de estado) y de un puerto read-only para listar los `grClienteId` locales (`MirrorCountsRepository` extendido o un nuevo `ClientMirrorReadRepository` — la decisión es de `design`).
- NO reciba inyectado ningún puerto de escritura. El use case MUST ser estructuralmente incapaz de insertar, actualizar o borrar (DIP — config rule `design`: `application` no importa de `@infrastructure/*`).
- Devuelva un DTO (`ReconcileReportDTO`), NUNCA entidades Prisma ni el JSON crudo de GR.

### REQ-REC-DIFF-1: El set-diff es bidireccional sobre el universo COMPLETO

El reconcile MUST computar la diferencia de conjuntos sobre el **universo completo** de GR (todos los estados, sin filtro de `GR_SYNC_ESTADOS`), comparando el conjunto de `grClienteId` locales contra el conjunto de `grClienteId` de GR.

#### Scenario: localOnly = local − gr (huérfanos)

**Given** que GR (universo completo) devuelve los `grClienteId` `{A, B, C}`
**And** que el espejo local contiene los `grClienteId` `{A, B, C, X, Y}`
**When** se ejecuta `ReconcileGrClients`
**Then** `localOnly` MUST ser exactamente `{X, Y}` (presentes localmente, ausentes en GR)
**And** `localOnlyCount` MUST ser `2`

#### Scenario: grOnly = gr − local (inserts faltantes)

**Given** que GR (universo completo) devuelve los `grClienteId` `{A, B, C, Z}`
**And** que el espejo local contiene los `grClienteId` `{A, B, C}`
**When** se ejecuta `ReconcileGrClients`
**Then** `grOnly` MUST ser exactamente `{Z}` (presentes en GR, ausentes localmente — p.ej. bajas nunca traídas)
**And** `grOnlyCount` MUST ser `1`

#### Scenario: Conjuntos idénticos → ambos diffs vacíos

**Given** que GR y el espejo local contienen el mismo conjunto `{A, B, C}`
**When** se ejecuta `ReconcileGrClients`
**Then** `localOnly` y `grOnly` MUST ser ambos `[]`
**And** `localOnlyCount` y `grOnlyCount` MUST ser ambos `0`
**And** `localTotal` y `grTotal` MUST ser ambos `3`

#### Scenario: El diff NO se filtra por estado

**Given** que GR contiene clientes en estados `1,2,3,4,6` (universo completo)
**And** que el reconcile se ejecuta con `GR_SYNC_ESTADOS=1,2` configurado para el sync
**When** se ejecuta `ReconcileGrClients`
**Then** `grTotal` MUST contar TODOS los estados de GR (no solo `1,2`)
**And** la comparación MUST ser apples-to-apples: ambos lados cuentan el universo completo

> Rationale: el sync regular puede estar filtrado, pero el reconcile siempre compara universos completos para que el conteo sea comparable.

### REQ-REC-ENDPOINT-1: Contrato del endpoint `POST /reconcile-report`

El sistema MUST exponer `POST /api/admin/gr-sync/reconcile-report` en `gr-sync.routes.ts`, junto al endpoint existente `reset-clients-cursor`, cableado en `app.ts`.

#### Scenario: Request autenticado devuelve el reporte completo

**Given** un request autenticado `POST /api/admin/gr-sync/reconcile-report`
**When** se procesa
**Then** MUST responder `200` con el siguiente shape:

```json
{
  "localTotal": 5122,
  "grTotal": 5119,
  "localOnlyCount": 5,
  "grOnlyCount": 2,
  "localOnly": ["<grClienteId>", "..."],
  "grOnly": ["<grClienteId>", "..."]
}
```

**And** `localOnly` MUST ser un array de `grClienteId` (strings) presentes localmente y ausentes en GR
**And** `grOnly` MUST ser un array de `grClienteId` (strings) presentes en GR y ausentes localmente
**And** `localOnlyCount` MUST ser igual a `localOnly.length`
**And** `grOnlyCount` MUST ser igual a `grOnly.length`

### REQ-REC-AUTH-1: Endpoint protegido

#### Scenario: Sin token válido → 401

**Given** un `POST /api/admin/gr-sync/reconcile-report` sin token válido
**When** se procesa
**Then** MUST responder `401` (mismo `authMiddleware` que el resto de `/api/admin/gr-sync`)

### REQ-REC-READONLY-1: Cero escrituras (invariante de seguridad)

El endpoint MUST ser puramente diagnóstico: NO MUST realizar ningún insert, update ni delete sobre `Client` ni ninguna tabla relacionada.

#### Scenario: Ejecutar el reconcile no muta el espejo

**Given** un espejo local con N filas de `Client` con `grClienteId`
**And** que GR devuelve un universo con huérfanos (`localOnly` no vacío)
**When** se ejecuta `ReconcileGrClients` (o se llama el endpoint)
**Then** el conteo de filas locales MUST permanecer en N (sin alta, baja ni modificación)
**And** ningún `Client.status` MUST cambiar como efecto del reconcile

### REQ-REC-FK-1: El reconcile nunca dispara cascadas de FK

El reconcile MUST NOT borrar filas de `Client`. Como consecuencia, las cascadas `onDelete: Cascade` hacia `Invoice`, `Service` y `ClientLog` NUNCA se disparan por este endpoint.

#### Scenario: Huérfano con facturas no pierde datos

**Given** un cliente huérfano (`localOnly`) que tiene `Invoice` y `Service` asociados (FK `onDelete: Cascade`)
**When** se ejecuta el reconcile y el cliente aparece en `localOnly`
**Then** el cliente MUST seguir existiendo localmente
**And** sus `Invoice`, `Service` y `ClientLog` MUST permanecer intactos
**And** la remediación (soft-flag vs. delete) queda EXPLÍCITAMENTE diferida a un cambio futuro

> Rationale: el endpoint es read-only precisamente para evitar destruir facturas/servicios por cascada.

### REQ-REC-PAGINATION-1: Universo completo paginado

El use case MUST recorrer el universo completo de GR mediante paginación secuencial (mismo patrón que `SyncGestionRealClients`), sin filtro de estado, hasta agotar las páginas.

#### Scenario: Más de una página de GR

**Given** que GR devuelve el universo en múltiples páginas (p.ej. 100/página)
**When** se ejecuta `ReconcileGrClients`
**Then** `grTotal` MUST reflejar la suma de TODAS las páginas (no solo la primera)
**And** `grOnly`/`localOnly` MUST computarse sobre el universo completo agregado

---

## Appendix: Response field reference

| Campo | Tipo | Significado |
|-------|------|-------------|
| `localTotal` | number | Cantidad de `grClienteId` en el espejo local |
| `grTotal` | number | Cantidad de `grClienteId` en el universo completo de GR |
| `localOnlyCount` | number | `localOnly.length` — huérfanos locales |
| `grOnlyCount` | number | `grOnly.length` — inserts faltantes |
| `localOnly` | string[] | `grClienteId` locales ausentes en GR |
| `grOnly` | string[] | `grClienteId` de GR ausentes localmente |
