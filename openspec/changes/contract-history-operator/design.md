# Design — contract-history-operator (#117)

## Diagnóstico (resumen ejecutivo con file:line)
El campo `actorName` (columna OPERADOR del modal) llega vacío. Cadena verificada:

- DTO correcto: `contract-services.dto.ts:86` (`ServiceEventDto.actorName`), `:147` (mapeo TV `actorName: tvEvent.actorName`), `ListContractServiceHistory.ts:48` (no-TV `actorName: ev.actorName`).
- Write-path actual OK para eventos nuevos:
  - `contractServices.routes.ts:28-33` `actorOf(req)` → `{ actorId: req.user?.id, actorName: req.user?.username ?? '' }`, threadeado en `:79, :112, :128`.
  - `gigared.routes.ts:304` (register), `:469-472` (cancel → runner).
  - `req.user.username` real: `JwtAuthAdapter.getSession` `username: payload.login`; `authMiddleware.ts:34`.
- **Causa raíz B (dominante)**: `ListContractServiceHistory.synthesizeLegacyEvents` (`ListContractServiceHistory.ts:108-128`) hardcodea `actorName: ''` (`:115`, `:123`). Se dispara para servicios SIN filas de evento (`:78-80` TV, `:87-88` no-TV). El screenshot (alta 11 jun, recorder TV existe desde `a290d283` del 13 jun) cae acá.
- **Causa raíz A (histórica)**: eventos viejos con fila pero `actorName=''` (caller sin actor). Los recorders defaultean a `''`: `AddContractService.ts:61`, `RegisterGigaredAccount.ts:202`, `CancelTvJobRunner.ts:62`.
- Read-path NO resuelve por JOIN hoy: `PrismaContractServiceEventRepository.toEvent` (`:45-56`) y `PrismaTvActivationEventRepository.toEvent` (`:78-92`) leen `row.actorName` directo, sin `include actor`.

## Decisión 1 — Fix principal: resolver el operador al LEER vía JOIN (patrón #106)
Precedente directo: `23f1e8bc fix(tv): el historial de activaciones resuelve el nombre del cliente (JOIN Client)` — el `customerName` se declaraba en el DTO pero el repo nunca hacía el JOIN; se resolvió con `include: { client: { select: { name: true } } }` y `customerName: row.client?.name ?? null` en el mapper. Eso recuperó el dato incluso para eventos viejos. Aplicamos el MISMO patrón al operador.

La relación `actor` YA existe en el schema (no hay que migrar):
- `TvActivationEvent.actor RbacUser? @relation("TvActivationEventActor", ...) onDelete: SetNull` (`schema.prisma:2439`).
- `ContractServiceEvent.actor RbacUser? @relation("ContractServiceEventActor", ...) onDelete: SetNull` (`schema.prisma:2465`).

**Cambio en los adapters Prisma (read):**
- `PrismaContractServiceEventRepository.listByContract` (`:34-41`): agregar `include: { actor: { select: { login: true } } }`.
- `PrismaTvActivationEventRepository`: agregar el `include` en `listByContract` (`:66-74`) y — por consistencia con el modal de activaciones TV (#5/#106) — también en `listByClient` (`:33-41`) y `list` (`:43-63`). Ya tienen `include: { client: { select: { name: true } } }`; se agrega `actor: { select: { login: true } }` al mismo objeto.

**Cambio en el mapper `toEvent` (ambos repos):**
```ts
actorName: row.actorName || row.actor?.login || '',
```
Semántica (CRÍTICA — respeta snapshot vs soft-FK):
1. `row.actorName` snapshot tiene PRIORIDAD (sobrevive rename/delete del user → no se pisa con el login actual).
2. Solo si el snapshot está vacío (`''`/null) se cae al JOIN `row.actor?.login` (recupera eventos viejos que tienen `actorId` pero snapshot vacío).
3. Si tampoco hay `actor` (actorId null, o user borrado con SetNull) → `''` (degradación elegante).

NOTA `prisma as any`: ambos repos ya usan `(prisma as any).<model>` porque el client no se regenera en el worktree junction (comentario en `PrismaContractServiceEventRepository.ts:14-16`). El `include.actor` se agrega dentro de ese acceso `any` — sin fricción de tipos.

## Decisión 2 — Resolución en el READ-MODEL, NO en el use-case
El JOIN va en el ADAPTER Prisma, no en `ListContractServiceHistory`. Razones:
- DIP intacto: el use-case sigue dependiendo de los ports (`ContractServiceEventRepository`, `TvActivationEventRepository`); no conoce RbacUser.
- El read-model (`ContractServiceEvent`, `TvActivationEvent`) ya tiene el campo `actorName: string` — el adapter lo POBLA correctamente; el use-case lo consume sin cambios.
- El InMemory repo no tiene JOIN: para tests del use-case, se siembra `actorName` directo (como hoy). El JOIN es una preocupación de persistencia, no de dominio. Paridad: el InMemory NO necesita resolver actorId→login (los tests in-memory siembran el snapshot ya resuelto); si se quisiera testear el fallback, se puede sembrar `actorName: ''` + `actorId` y el InMemory simplemente devuelve `''` (el JOIN solo aplica en Prisma). Documentar esa diferencia explícita en el test de paridad.

**Implicancia**: el use-case `ListContractServiceHistory.ts` NO cambia para el fix de read (sigue mapeando `actorName: ev.actorName`). La síntesis legacy (`:108-128`) tampoco cambia funcionalmente: sus eventos sintéticos seguirán con `actorName: ''` (no hay dato). Eso es esperado y documentado.

## Decisión 3 — Write-side hardening: pinear el threading, sin cambio de comportamiento
El write-path actual YA threadea el actor en los tres orígenes. NO se cambia la lógica. Lo que se agrega es COBERTURA de test del SEAM completo (lección #27/#28: testear el viaje real, no las puntas) para evitar regresión futura:
- Test de ruta real (supertest) `POST /contracts/:id/services` → repo in-memory → `GET .../service-history` → assert `actorName` poblado de punta a punta.
- Idem para `PATCH`/`DELETE` (no-TV) y, si la batería de gigared lo permite con repos in-memory, register/cancel.

Si durante la implementación se detecta un call-site que NO threadea (p.ej. un path system-initiated o un default `?? ''` alcanzable con `req.user` presente), se corrige ahí — pero la evidencia actual dice que el threading está completo. No se introduce lógica nueva especulativa.

## Decisión 4 — Sin migración de schema
La relación `actor RbacUser?` y la columna `actorId` ya existen en ambos modelos. El JOIN reusa relaciones declaradas. **No se crea migración, no se corre `migrate dev`/`migrate diff`.** Cambio puramente de query + mapper.

## Archivos a tocar (exactos)
| Archivo | Cambio |
|---------|--------|
| `src/infrastructure/adapters/prisma/PrismaContractServiceEventRepository.ts` | `listByContract`: `include: { actor: { select: { login: true } } }`; `toEvent`: `actorName: row.actorName || row.actor?.login || ''` |
| `src/infrastructure/adapters/prisma/PrismaTvActivationEventRepository.ts` | agregar `actor: { select: { login: true } }` al `include` en `listByContract`/`listByClient`/`list`; `toEvent`: `actorName: row.actorName || row.actor?.login || ''` |
| (sin cambio funcional) `src/application/use-cases/ListContractServiceHistory.ts` | el use-case ya consume `actorName`; NO se modifica salvo que un test del SEAM exponga un gap |
| (sin cambio esperado) `src/infrastructure/http/routes/contractServices.routes.ts`, `gigared.routes.ts`, `src/infrastructure/scheduling/CancelTvJobRunner.ts` | solo se VERIFICAN/pinean por test; cambio únicamente si se detecta un threading roto |

DTO (`contract-services.dto.ts`): **sin cambio** — `actorName` ya está en `ServiceEventDto` y los mappers ya lo propagan.

## Impacto en adapters in-memory
- `InMemoryContractServiceEventRepository` y `InMemoryTvActivationEventRepository`: **sin cambio funcional**. No tienen JOIN (no conocen RbacUser); devuelven el `actorName` sembrado. La resolución por `actorId→login` es exclusiva del adapter Prisma. Esto se documenta en el test de paridad para que no se interprete como divergencia accidental: la paridad aplica a record/orden/filtro, NO a la resolución de operador (que es persistencia-specific, igual que el JOIN `customerName` del #106 que tampoco está en el InMemory).

## Plan de tests (STRICT TDD: red → green)
Mapeo scenario → test:

| # | Scenario (spec) | Test | Tipo |
|---|-----------------|------|------|
| T1 | Evento no-TV/TV con snapshot poblado muestra operador | `ListContractServiceHistory.test.ts`: seed evento con `actorName:"jperez"` → item.events[].actorName = "jperez" | use-case, InMemory |
| T2 | tvPassword sigue ausente con operador resuelto | mismo test + assert sin `tvPassword` | use-case |
| T3 | Adapter Prisma resuelve `actorName` vacío vía JOIN `actor.login` | test del mapper/adapter: `toEvent({ actorName:'', actor:{ login:'admin' } })` → `actorName:'admin'`; `toEvent({ actorName:'real', actor:{ login:'admin' } })` → `actorName:'real'` (snapshot gana); `toEvent({ actorName:'', actor:null })` → `''` | adapter (test unitario del mapper o con prisma mock mínimo del shape de fila) |
| T4 | SEAM completo no-TV: POST services → GET service-history con operador | `contractHistoryOperator.routes.test.ts`: supertest, repos in-memory, user "jperez" → `actorName:"jperez"` en la respuesta | ruta (supertest) |
| T5 | SEAM completo PATCH (deactivated/reactivated) y DELETE con operador | misma suite supertest | ruta |
| T6 | Síntesis legacy sigue con `actorName:''` (no se inventa) | `ListContractServiceHistory.test.ts`: servicio sin eventos → events sintéticos con `actorName:''` | use-case |
| T7 | Permisos sin cambio: 401 sin auth, 403 sin clients.read | supertest | ruta |
| T8 | (si aplica con in-memory) register/cancel TV graban y exponen operador | supertest gigared (reusar patrón `gigared.activation-history.routes.test.ts`) | ruta |

Sobre T3 (adapter): el repo usa `(prisma as any)`. Para el test del mapper, la opción más limpia y sin DB es extraer/testear la función `toEvent` con filas simuladas (`{ actorName, actor }`), o un test de adapter con un stub mínimo del cliente Prisma que devuelva la fila con la forma `{ ..., actor: { login } }`. Decidir en implementación; lo esencial es pinear las TRES ramas del fallback (`snapshot || actor.login || ''`).

NOTA SEAM (lección #27/#28): el test T4/T5 DEBE recorrer ruta real → use-case real → repo in-memory → ruta de historial real. NO mockear el use-case ni el repo intermedio. Es exactamente el viaje que rompió el #106 (puntas OK, medio sin JOIN).

## Gates (no se ejecutan en planificación; los corre apply/verify)
- `npx tsc --noEmit` 0 errores.
- jest targeted verde (use-case + adapters + ruta SEAM).
- NO se corre `migrate dev`/`migrate diff` (no hay cambio de schema).
- Confirmar (grep) que `actorName` sigue siendo el único nombre de campo del operador en el wire (no se introduce alias que rompa FE).
