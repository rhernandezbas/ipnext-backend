# Proposal — IClass Ops Config (Mapeo Técnico↔Cuadrilla + Toggles de flags + Visibilidad del despacho)

> Change: `iclass-ops-config`
> Construye ENCIMA de lo ya en prod: el despacho `SendTaskToIClass`/`dispatchTaskToIClass`, las acciones de OS (`iclass-os-actions`, Olas 2/3, flags OFF), los catálogos `IClassStatusCatalog`/`IClassTeam`/`IClassSoType`/`IClassNode` y el mapeo proyecto→soType.
> Fecha: 2026-06-15

## Why

La integración con IClass ya despacha tareas, sincroniza catálogos y tiene las acciones de cierre/asignación construidas (flags OFF). Pero la **operación diaria** todavía tiene tres huecos que obligan al operador a entrar a IClass o a operar a ciegas:

1. **No hay vínculo Técnico↔Cuadrilla.** El técnico de Prominense (`RbacUser`, el `assigneeId` de la tarea) y la cuadrilla de IClass (`IClassTeam`, el `requiredTeam` de la OS) viven en universos separados. Hoy se asigna la cuadrilla a mano en la OS, replicando una decisión que YA se tomó al asignar el técnico en Prominense.
2. **Los flags de acciones no tienen UI.** `iclass-close-action` / `iclass-assign-action` se sembraron OFF por migración. No hay forma de prenderlos desde el panel; requieren tocar la DB. El endpoint `PATCH /api/admin/feature-flags/:key` (gate `admin.flags`) YA existe y el FE YA tiene el patrón `IClassFlagBody` + `useFeatureFlag`/`useSetFeatureFlag`.
3. **El despacho es una caja negra.** Lo que se envía al crear la OS (tipo de OS, nodo, customerCode, phone, descripción, soCode) está repartido entre el mapeo proyecto→soType, el catálogo de nodos y constantes hardcodeadas (`NETWORK_CUSTOMER_CODE='NETWORK'`, `NETWORK_PHONE='0000000000'`). El operador no tiene una vista consolidada de "qué le va a llegar a IClass cuando despache esta tarea".

## What changes

Un solo change, tres olas dependientes pero acotadas (ver `design.md` para el detalle y la matriz scenario→test).

### Ola A — Mapeo Técnico↔Cuadrilla + auto-asignar (BE + FE) — el corazón del change

- **Modelo del mapeo (decisión):** campo `iclassTeamLogin String?` en `RbacUser` (1 técnico → 1 cuadrilla). NO tabla de mapeo. Justificación en `design.md` (AD-1): la cardinalidad de negocio es 1:1, el FK lógico es soft (login, no id, para sobrevivir al re-sync del catálogo), y degrada solo. Una tabla N:N sería sobre-ingeniería sin caso de uso.
- **Sub-page de config "Técnicos → Cuadrillas"** (nueva sub-tab en `IClassSettingsBody`): tabla editable inline (patrón `IClassStatusCatalogBody`), una fila por técnico, `<select>` de cuadrillas activas+selectables. Auto-save por fila.
- **Endpoints nuevos (BE):**
  - `GET /api/admin/iclass/technician-teams` — lista técnicos con su cuadrilla mapeada (+ flag `teamActive` para degradar el render). Gate `iclass.read`.
  - `PATCH /api/admin/iclass/technician-teams/:userId` — body `{ iclassTeamLogin: string | null }`. Gate `iclass.manage`.
- **Auto-asignar (el músculo):** `UpdateTask` recibe un colaborador opcional `AutoAssignIClassTeamOnTaskUpdate` (port nuevo). Cuando el body cambia `assigneeId` (CAMBIO, no presencia) Y el técnico tiene `iclassTeamLogin` mapeada Y la tarea tiene `iclassOrderCode` Y el flag `iclass-assign-action` está ON → empuja la cuadrilla a IClass reusando la MISMA lógica de `AssignIClassTeam` (pre-check en vivo + `updateServiceOrder` + mapeo de errores + `withAuthRetry`). **BEST-EFFORT**: si IClass falla o la cuadrilla está inactiva, la asignación local del técnico NO se aborta — se registra el intento (actividad + log) y sigue.

### Ola B — Toggles de feature flags de acciones (FE-only)

- Nueva sub-tab "Acciones" (o renombrar/extender "Integración") en `IClassSettingsBody` con dos toggles, clon de `IClassFlagBody`: `iclass-close-action` y `iclass-assign-action`.
- **Decisión:** agrupar los flags en una sección "Acciones de OS" SEPARADA del flag `iclass-integration` (que gobierna el despacho, no las acciones). El flag `iclass-integration` queda donde está (sub-tab "Integración"). Razón: distinta semántica (despacho vs. acciones de escritura sobre la OS) y distinto riesgo (las acciones nunca se probaron en vivo).
- **BE:** sin cambios. Verificado: `PATCH /api/admin/feature-flags/:key` (`SetFeatureFlag`, gate `admin.flags`) y `GET /api/admin/feature-flags/:key` ya existen y el hook FE ya los consume.

### Ola C — Visibilidad del despacho "Qué se envía a IClass" (BE-read + FE)

- **Alcance CONCRETO y acotado (read-mostly):** una sub-page "Qué se envía a IClass" que consolida, **por proyecto**, lo que `dispatchTaskToIClass` arma al despachar una tarea de CLIENTE. Una fila por proyecto que tenga `iclassSoType` mapeado, mostrando:
  - **Tipo de OS** (`project.iclassSoType.code` + descripción) — configurable (link al mapeo existente).
  - **Nodo / microárea** — se resuelve por `customerCity` contra el catálogo de nodos en runtime (NO está fijado por proyecto). Se muestra como "resuelto por ciudad del cliente" + link al catálogo de nodos.
  - **Estado inicial** — VERIFICADO: Prominense NO manda estado inicial; IClass lo pone. Se documenta explícitamente en la página ("el estado inicial lo asigna IClass").
  - **Campos derivados/hardcodeados:** `customerCode` (= contractCode ?? customerCode), `phone` (= `customerPhone`; en RED/FIBRA `'0000000000'` hardcodeado), `soCode` (= `sequenceNumber`). Se muestran con su origen y se marca cuáles son hardcodeados.
- **Agrupar el catálogo de estados DEVUELTOS (Fase 1):** la sub-page enlaza/embebe la vista del catálogo `IClassStatusCatalog` ("Estados de IClass") como "lo que IClass nos devuelve", cerrando el círculo enviado↔devuelto en un solo lugar. No se duplica: se referencia la sub-tab existente.
- **Endpoint nuevo (BE, read-only):** `GET /api/admin/iclass/dispatch-preview` — devuelve, por proyecto mapeado, el resumen consolidado (soType, si resuelve nodo por ciudad, customerCode source, phone source, estado inicial = "IClass-assigned", flags relevantes). Gate `iclass.read`.
- **Fuera de alcance (explícito):** NO se hace configurable el `customerCode`/`phone`/`soCode` hardcodeado (visibilidad primero; cambiarlos toca `dispatchTaskToIClass`, fuera de este change). NO se agrega preview por-tarea-individual (sería un endpoint de simulación; out of scope). NO se toca el despacho de RED/FIBRA en esta página (la consolidación es CLIENTE; RED/FIBRA se nota como caso aparte con su sustitución de campos).

### Permisos (decisión)

Reusar los gates `iclass.read` (lectura de catálogos/preview) y `iclass.manage` (edición del mapeo), siguiendo el precedente de `IClassStatusCatalog`/`IClassTeam`. NO se crean permisos nuevos. El toggle de flags ya está gateado por `admin.flags` (existente). La actividad de auto-asignar reusa el recorder existente.

## Impact

- **Affected specs**: nuevo capability `iclass-ops-config`.
- **Affected code (BE)**:
  - `prisma/schema.prisma` (campo `iclassTeamLogin` en `RbacUser`) + migración aditiva.
  - `src/domain/ports/RbacUserRepository.ts` (lectura/escritura del nuevo campo) + adapters Prisma/in-memory.
  - `src/domain/entities/rbac.ts` (`RbacUser.iclassTeamLogin?`).
  - Use cases nuevos: `ListTechnicianTeamMappings`, `SetTechnicianTeamMapping`, `GetIClassDispatchPreview`, y `AutoAssignIClassTeamOnTaskUpdate` (port + use case extraído de `AssignIClassTeam`).
  - `UpdateTask` (colaborador opcional best-effort para auto-asignar).
  - DTOs: `technicianTeamMapping.dto.ts`, `iclassDispatchPreview.dto.ts`.
  - Rutas: router `iclassTechnicianTeams.routes.ts` + `iclassDispatchPreview.routes.ts` (montados en `/api/admin/iclass`), wiring en `scheduling.routes.ts` para el auto-asignar.
  - `app.ts` (wiring), `errorHandler.ts` (sin códigos nuevos — reusa los de IClass).
- **Affected code (FE)**: 3 sub-pages nuevas en `IClassSettingsBody` (mapeo técnico↔cuadrilla, toggles de acciones, visibilidad del despacho) + hooks (`useTechnicianTeamMappings`, `useIClassDispatchPreview`, reuso de `useFeatureFlag`/`useSetFeatureFlag`/`useRbacUsers`/`useIClassTeams`).
- **Contrato BE↔FE**: 100% aditivo. No rompe endpoints existentes. `UpdateTask` mantiene su contrato (el auto-asignar es un side-effect best-effort transparente).

## ⚠️ RIESGO CRÍTICO — el auto-asignar dispara ESCRITURAS a IClass al cambiar el assignee

Cambiar el técnico de una tarea es una operación **local y frecuente** (drag&drop, edición de detalle, reasignación masiva). Engancharle una escritura a IClass introduce riesgos que el diseño DEBE neutralizar:

- **(a) Best-effort no negociable.** El auto-asignar NUNCA aborta `UpdateTask`. Si `updateServiceOrder` falla (rechazo, IClass caído, cuadrilla inactiva, OS ya cerrada), la asignación local del técnico se persiste igual y el fallo se registra (actividad `iclass_team_auto_assign_failed` + log). El operador VE que el push falló, pero su edición local no se pierde.
- **(b) Triple cerrojo antes de tocar IClass.** flag `iclass-assign-action` ON + tarea con `iclassOrderCode` + técnico con cuadrilla `active && selectable`. Si falta cualquiera → no se llama a IClass (silencioso o avisado según el caso; ver spec).
- **(c) Degradación por cuadrilla inactiva.** El sync de teams puede `markInactiveExcept` una cuadrilla mapeada. El auto-asignar NO empuja una cuadrilla inactiva: registra `iclass_team_auto_assign_skipped` (reason: team-inactive). La sub-page de mapeo MARCA en rojo las cuadrillas inactivas para que el operador re-mapee.
- **(d) Solo en CAMBIO real de assignee.** El guard dispara únicamente cuando `assigneeId` cambia respecto del valor actual (mismo patrón #40/#66 del propio `UpdateTask`), NO en cada save del form de edición (que reenvía el body completo). Evita escrituras redundantes a IClass.
- **(e) `withAuthRetry` + pre-check en vivo.** Reusa la MISMA mecánica de `AssignIClassTeam` (pre-check `getServiceOrder` para no asignar sobre OS cerrada, 429/401 con backoff). No se reinventa el push.
- **(f) Reasignación masiva.** Si una operación masiva cambia N assignees, son N escrituras a IClass best-effort. El diseño nota que el auto-asignar se engancha en `UpdateTask` (single-task); para bulk, cada update pasa por el mismo camino (acotado, secuencial, best-effort). NO se hace fan-out paralelo a IClass.

## Decisiones tomadas (resumen)

1. **Un solo change, tres olas.** A (mapeo + auto-asignar) es el núcleo y la de más riesgo; se hace primero y se valida con flag OFF→ON controlado. B (toggles) es FE-only y trivial, habilita probar A en vivo. C (visibilidad) es read-mostly y desacoplada. Razón: B desbloquea la prueba en vivo de A; C no depende de A ni B.
2. **Modelo de mapeo = campo en `RbacUser` (1:1), soft FK por `login`.** No tabla N:N. Degradación: cuadrilla inactiva → no auto-asigna, avisa. (AD-1).
3. **Auto-asignar best-effort enganchado en `UpdateTask` vía colaborador opcional**, reusando la lógica de `AssignIClassTeam` (extraída a un use case compartido). Nunca aborta la operación local. (AD-2, AD-3).
4. **Flags agrupados aparte del despacho.** Sección "Acciones de OS" separada de "Integración". (Ola B).
5. **Visibilidad primero, configurabilidad después.** La Ola C muestra lo hardcodeado pero NO lo hace configurable (fuera de alcance). Estado inicial verificado: lo pone IClass. (Ola C).
