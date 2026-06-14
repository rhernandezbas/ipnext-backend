# contract-history-operator (#117)

## Why
En el modal "Historial de servicios" del contrato (`GET /api/contracts/:contractId/service-history`, #73/#110) cada evento tiene una columna **OPERADOR** que sale EN BLANCO. Screenshot del usuario: una fila TV "Contratado: 11 jun 2026 · Baja: 14 jun 2026 · CIC 0006870063 · Gigared Play Full", con TIPO Alta/Baja correctos pero OPERADOR vacío en ambos eventos.

El DTO YA expone el operador como `actorName` (`contract-services.dto.ts:86`, mapeo TV `:147`) y el FE ya lo renderiza. El campo llega en blanco. Es el mismo patrón de bug que el #106 ("Cliente: —"): el contrato de datos está bien, lo que falla es el ORIGEN del dato.

## Causa raíz confirmada (con evidencia)
El operador sale vacío por DOS razones que conviven (la dominante es la **B — read-side**):

### B (read-side) — DOMINANTE: la síntesis legacy hardcodea `actorName: ''`
`ListContractServiceHistory.synthesizeLegacyEvents` (`ListContractServiceHistory.ts:108-128`) genera eventos `activated`/`deactivated` con **`actorName: ''` literal** (líneas 115 y 123). Esta rama se dispara cuando un servicio NO tiene filas de evento en su tabla:
- TV (`tvLogin !== null`): si `tvEvents.length === 0` → síntesis (`ListContractServiceHistory.ts:78-80`).
- No-TV: si no hay eventos en `contract_service_events` → síntesis (`:87-88`).

El caso del screenshot encaja exacto: la **alta TV fue el 11 jun**, pero el recorder de eventos TV (`tv_activation_events`) recién existe desde el commit `a290d283` del **13 jun 2026** (`feat(tv): historial de altas/bajas TV`). El ledger no-TV (`contract_service_events`) existe desde `50c0fa28` del **14 jun**. Es decir: para ese contrato NO hay filas de evento de la alta → cae en síntesis → ambos eventos salen con `actorName: ''`.

### A (write-side) — PARCIAL/HISTÓRICA: eventos viejos sin actor + un gap condicional
1. **Eventos pre-recorder**: cualquier alta/baja anterior al 13/14 jun NO tiene fila de evento (no se grababa). No hay actor que recuperar — el dato nunca existió. (Mismo límite que #110/#73.)
2. **Eventos grabados con snapshot vacío**: los recorders defaultean a `actorName: ''` si el caller no threadea el actor:
   - `AddContractService.ts:60-61` → `actorName: actor?.actorName ?? ''`
   - `RegisterGigaredAccount.ts:201-202` → `actorName: input.actorName ?? ''`
   - `CancelTvJobRunner.ts:61-62` → `actorName: actor?.actorName ?? ''`
3. **Las rutas SÍ threadean el actor HOY** (verificado): `contractServices.routes.ts:28-33` (`actorOf(req)` con `req.user.username`), `gigared.routes.ts:304` (register), `gigared.routes.ts:469-472` (cancel → runner). `req.user.username` es real (`JwtAuthAdapter.getSession` → `username: payload.login`, `authMiddleware.ts:34`). Por lo tanto los eventos NUEVOS sí guardan el operador. **No hay un threading roto en el write-path actual** — el gap A es histórico (eventos viejos) y el riesgo residual es que un evento se grabe sin `req.user` (path system-initiated).

### Conclusión
- Eventos NUEVOS: el operador ya se graba bien (write-path OK). No requiere cambio funcional de write.
- Eventos VIEJOS con fila de evento pero `actorName=''` y `actorId` no nulo: recuperables al LEER con un JOIN `actor → RbacUser.login` (precedente #106 con `client.name`).
- Eventos VIEJOS sin fila de evento (síntesis): NO recuperables — el dato nunca se persistió. La síntesis seguirá sin operador (igual que la columna "Cliente: —" del #106 para legacy). Se documenta la limitación.

## What
1. **Read-side resolution (fix principal, patrón #106)**: en los adapters Prisma de ambos ledgers, agregar `include: { actor: { select: { login: true } } }` en las queries de lectura y, en el mapper `toEvent`, resolver `actorName = row.actorName || row.actor?.login || ''`. Esto recupera el operador de los eventos que tienen `actorId` aunque su snapshot `actorName` haya quedado vacío. Respeta la semántica snapshot: el snapshot tiene prioridad; el JOIN es fallback solo cuando el snapshot está vacío.
   - `PrismaContractServiceEventRepository.listByContract` (`PrismaContractServiceEventRepository.ts:34-41`).
   - `PrismaTvActivationEventRepository.listByContract` (`PrismaTvActivationEventRepository.ts:66-74`) — y por consistencia las otras lecturas (`listByClient`, `list`) que alimentan el modal de activaciones TV.
2. **Write-side hardening (defensa)**: garantizar que las rutas que pueden disparar un registro de evento NUNCA pierdan el actor cuando hay `req.user`. Verificar que los tres call-sites siguen threadeando y dejar el seam testeado de punta a punta (ruta → use-case → repo). No hay cambio de comportamiento esperado, pero se pinea con tests para evitar regresión.
3. **Sin migración de schema**: las columnas `actorId` (soft FK SetNull) y la relación `actor RbacUser?` YA existen en ambos modelos (`schema.prisma:2438-2439` TV, `:2464-2465` no-TV). El JOIN usa una relación ya declarada. No se toca el schema ni se crea migración.

## Permisos
La ruta `GET /api/contracts/:contractId/service-history` ya está gateada `requirePerm('clients', 'read')` (`contractServices.routes.ts:133`). **No hace falta permiso nuevo.** El JOIN a `RbacUser.login` no expone dato sensible (es el username del operador, ya visible en otros historiales como `tv_activation_events`/audit).

## Back-compat / limitación documentada
- **Eventos con `actorId` no nulo**: recuperan el operador al leer (JOIN), incluso si su snapshot quedó vacío. ✔
- **Eventos sintetizados (legacy sin fila)**: siguen sin operador — el dato nunca se persistió. La fila muestra TIPO + fechas, operador en blanco. Es la misma degradación elegante que #110 (síntesis) y #106 ("Cliente: —" para legacy). **NO hay back-fill posible.** ✔ documentado.
- **Contrato de wire INTACTO**: el campo sigue siendo `actorName` (string), mismo shape que consume el FE en prod. No se renombra ni se quita nada.

## Out of scope
- Cambiar el shape del DTO o el nombre del campo (`actorName` se mantiene).
- Back-fill de eventos históricos sin fila (imposible: el dato no existe).
- Migración de schema (la relación `actor` ya existe).
- Cambios de FE (ya renderiza `actorName`; ver "Coordinación FE").
- Registrar eventos en paths system-initiated que hoy no tienen `req.user` (no es el caso del screenshot; el operador humano siempre tiene sesión).

## Coordinación FE
**No requerida.** El FE ya consume y renderiza `actorName` en la columna OPERADOR (es el mismo DTO `ServiceEventDto` que el #110 cableó). El fix es 100% backend: poblar `actorName` desde el JOIN al leer. El contrato de wire no cambia. (Duda menor: confirmar que el FE muestra un placeholder razonable — ej. "—" — para los eventos sintetizados legacy que seguirán en blanco; eso es estética FE, no bloquea el fix BE.)
