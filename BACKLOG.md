# Backlog — IPNext (Prominense)

> Backlog de trabajo sobre los dos repos (`ipnext-backend` + `ipnext-frontend`).
> Arrancó el 2026-06-03 con 14 ítems; +2 (#15, #16) → 16; +1 (#17); +2 (#18, #19); +1 (#20); +2 (#21, #22); +2 (#23, #24); +2 (#25, #26); +1 (#27); +1 (#28) → 28; +9 (#29–#37, sesión 2026-06-08: cierre de OS async/resiliente + página de Reconciliar + observabilidad) → **37 totales**; +8 (#40–#47, sesión 2026-06-11: Tareas Nodos + estados generales + redesigns contratos/tickets + servicios x contrato + mapper ciudades + integración TV) → **45 totales**; +19 (#48–#66) +5 (#67–#71) +2 (#72/#73) +6 (#74–#79, noche 2: renew=baja completa + columnas de la lista de tickets: área pos2, timer SLA, link cliente, fuera Tipo, datos→comentario) → 87; +13 (#88–#100, jornada 2026-06-13 tarde: TV errores espurios + register modal + cancel async + historial de altas + archivar/bulk + statuses→config + recaptación v2) → 100; +8 (#101–#108, refinamientos 2026-06-13 sobre el batch #88–#100: archive visible + TV historial modal/chip/CIC/cliente + recaptación estado/asignado/CSV/reasignar) → **108 totales — TODOS HECHOS** (jornada 2026-06-12/13: 31 shippeados + #57 no-bug, BE PRs #118–#134 / FE PRs #97–#122, 11 migraciones 20260701–20260713). Único pendiente NO-código: escalamiento a Gigared (ver Pendientes).
> **38 hechos (en prod, #39 incluido) · EPIC #38 COMPLETO (7/7 waves) · UISP V1 EN PROD (2026-06-10, BE #99 + FE #71 — flag `uisp-sync` OFF, rotar token post-activación).**  (#17, #7, #22, #18, #14, #11, #12, #25, #20, #19, #23, #29, #31, #30, #32, #33, #34, #35, #36, #37 cerrados vía SDD.)

---

## 📋 Pendientes

> **Pendientes IClass (2026-06-15):** #119 (dropdown cuadrillas vacío), #121 (código de OS = ID de contrato), y `iclass-intermediate-states` (✅ EN PROD: estados intermedios → Stage + fix del closeDate). La **cosa 1 (auto-aprobar OS)** quedó **DESCARTADA** tras verificación a fondo — ver el ítem abajo.

### #119 — Técnico↔Cuadrilla: el dropdown de cuadrillas sale vacío (bug del iclass-ops-config ola A) — ✅ RESUELTO (operativo) *(2026-06-16)*
> **RESUELTO**: era la hipótesis (1) — el catálogo `IClassTeam` estaba sin sincronizar. Diagnóstico verificado: el sync es manual (clon de `IClassNode`) y hardcodea `active: true` (`SyncIClassTeams.ts:70`, ignora el `status` de IClass — los 10 teams reales están Inativo/Espera/Cancelado pero igual entran). Acción: el usuario corrió "Sincronizar cuadrillas" → catálogo poblado → el dropdown de Técnico↔Cuadrilla funciona y el mapeo se hace en Config. El comportamiento de la cuadrilla EN LA TAREA pasa al #122.
> En Config → IClass → "Técnicos → Cuadrillas", al seleccionar la cuadrilla de un técnico el dropdown sale **vacío**. El selector se alimenta del catálogo `IClassTeam` (FE: `useIClassTeams()` — ver `iclassTechnicianTeams.routes.ts:66` "resolved by FE via useIClassTeams()"). Causa probable (verificar en orden): (1) el catálogo `IClassTeam` está **vacío** porque nunca se corrió "Sincronizar" desde `GET /teams` (Fase 3 de `iclass-os-actions`), mismo patrón que el sync de estados; (2) hay teams pero el FE los filtra por `active && selectable` y ninguno califica (el auto-asignar exige `active&selectable`); (3) bug de wiring del endpoint/hook. **Acción**: sincronizar teams primero y reconfirmar; si sigue vacío, revisar el listado de teams (BE) + el hook `useIClassTeams` (FE). Cross-repo.

### #121 — Enviar a IClass: el código de la OS debe ser el ID del contrato del servicio, NO el `sequenceNumber` — PENDIENTE
> Pedido del usuario (2026-06-15, énfasis fuerte). Hoy el despacho manda `soCode = String(task.sequenceNumber)` como código de la OS (`dispatchTaskToIClass.ts:147`); el `customerCode` ya es `Contract.grContratoId` (#55, `:128`/`:148`). El usuario quiere que **el identificador de la OS enviado a IClass sea el ID del contrato del servicio (`grContratoId`), no el sequencial interno**. ⚠️ **CONSIDERACIÓN CRÍTICA (resolver en el SDD, NO obviar)**: el `soCode` HOY es la CLAVE de matching OS→tarea (`SO.codigo == sequenceNumber`, `IngestClosedServiceOrders.ts:246`) y DEBE ser único por OS. `grContratoId` NO es único por OS (un contrato tiene N órdenes en el tiempo) → usarlo crudo como `soCode` ROMPE el matching (colisión + el matching por sequenceNumber deja de funcionar para TODAS las OS, incluido el cierre #41). Opciones a evaluar: (a) `soCode` compuesto `{grContratoId}-{seq}` (lleva el contrato Y es único; el matching parsea el `-{seq}`); (b) mandar el contrato en otro campo de la OS (el payload tiene `contrato`) y dejar el `soCode` único; (c) confirmar si IClass acepta `soCode` no-único. **Impacta directamente** a `iclass-autoapprove-state-mapping` (el matching es la base de cosa 1 y cosa 2) → decidir ANTES de implementar ese SDD.

### #122 — Tarea: sacar el selector de cuadrilla IClass + bloquear asignar un técnico sin cuadrilla mapeada — PENDIENTE
> Pedido del usuario (2026-06-16), diseño CONFIRMADO. La asociación técnico→cuadrilla se hace en Config (Técnicos→Cuadrillas, `iclass-ops-config`) → en la TAREA ya no se elige la cuadrilla a mano. **Cambios**: (1) **Sacar el `IClassTeamSelector`** (selector manual de cuadrilla) de la tarea (`SchedulingTaskDetailPage.tsx`); la cuadrilla la deriva el auto-assign (`AutoAssignIClassTeamOnTaskUpdate`) desde el mapeo de Config. (2) **Al ELEGIR un técnico que NO tiene cuadrilla mapeada → modal que BLOQUEA** la asignación (no deja asignar hasta mapearlo en Config). (3) **Solo cuando el flag `iclass-assign-action` está ON**; con el flag OFF, asignación de técnico LIBRE (sin modal ni bloqueo). Decisiones del usuario: BLOQUEA (no solo avisa), al momento de elegir. Mayormente **FE** (task UI: assignee picker + modal bloqueante + check del flag + lookup técnico→cuadrilla vía `useIClassTechnicianTeams`). **A decidir en el SDD**: si además se endurece en BE (UpdateTask rechaza asignar técnico sin cuadrilla con el flag ON) o queda como guard de UX FE-only; y de dónde lee el FE el estado del flag.

### iclass-intermediate-states — Estados intermedios de IClass → Stage de Prominense (+ fix del `closeDate`) — ✅ HECHO Y EN PROD *(BE `86cd752a` / FE `08db15b`, migración 20260728, 2026-06-16)*
> **Scope (lo único a construir):** **(1) Estados intermedios automáticos** — traer los estados intermedios de IClass (`AGENDADA 29`/`DESPACHADA 10`/`DESLOCAMENTO 2`=se moviliza/`ANDAMENTO 3`=trabajando/`EM ANALISE 18`) y mapear cada uno → un **Stage** de Prominense, aplicado automático a medida que la OS avanza. *Ya existe*: el scheduler `IngestClosedServiceOrders` ya captura el `iclassStatusCode` en la tarea ANTES del guard terminal + el catálogo `IClassStatusCatalog`. *Nuevo*: columna `prominenseStageId` (FK nullable a Stage) en el catálogo + aplicar el move de stage en la captura + selector en el FE (página "Estados de IClass"). Diseño a confirmar: el auto-move solo avanza, NO pisa un move manual del operador. **(2) Fix del `closeDate`** (bug del §10): `IClassClient.formatCloseDate` manda `"dd/MM/yyyy HH:mm:ss"` (2 tokens) → IClass tira HTTP 417; el correcto es `"yyyy-MM-dd HH:mm:ss -0000"` (3 tokens, con offset). Afecta el cierre manual de la Fase 2 (flag OFF hoy). Una función + su test. **Exploración del SDD hecha** (`openspec/changes/iclass-autoapprove-state-mapping/exploration.md` + engram); **→ HECHO Y DESPLEGADO 2026-06-16**: SDD completo (explore→proposal→apply); el review adversarial cazó **cross-workflow** (BE: `Stage.order` es per-workflow, el mapeo global podía mover una tarea a un stage de otro workflow → guard agregado) + **stage-huérfano** (FE: select fantasma/desync → option "⚠ Stage inexistente"); gate corrido por el orquestador verde (BE jest **4504/0** + tsc · FE vitest **3188/0** + typecheck). Deploy: **BE `86cd752a`** (migración `20260728` corrida en prod) + **FE `08db15b`**, ambos runs `gh` verdes. **Post-deploy (USUARIO)**: Config → Estados de IClass → mapear cada estado intermedio a su Stage (recordá: el auto-move solo aplica a tareas del **workflow del stage elegido**).

### pppoe-service — Gestión de PPPoE (cliente→contrato→pppoe→router) + cortes ind./masivos — 🆕 SDD NUEVO, EN PLANIFICACIÓN *(2026-06-15)*
> **Pedido del usuario (2026-06-15, voz).** Unificar en Prominense la gestión de los PPPoE de los ~6-7K clientes repartidos en ~9 routers MikroTik PPPoE, y poder hacer **cortes individuales y masivos** (ej: pasar N deudores a perfil reducido) por **batches con timeouts moderados, sin sobrecargar los maestros** (la resiliencia importa más que la velocidad). Contexto técnico completo del RADIUS/red en `~/.claude/reference/radius-ipnext-bundle.md` (snapshot privado, NO commitear — tiene credenciales).
>
> **Decisiones tomadas (2026-06-15):** (1) **Localización del router = vínculo persistido** `cliente→contrato→pppoe→nasId` (PPPoE es fijo; Prominense es dueño del vínculo, NO se depende del accounting RADIUS que está idle). (2) **Corte = cambiar `/ppp secret profile` a reducido/bloqueado + `/ppp active remove`** (persiste y toma efecto ya). (3) **GR manda el estado, el backend solo lo EJECUTA en la red** (es el puente GR→red que hoy falta; coincide con la arquitectura espejo actual). (4) **Port abstracto `ServiceEnforcementGateway`, arrancar con adapter RouterOS API** (funciona hoy con secret local; RADIUS CoA queda como adapter futuro). (5) **Bootstrap = barrer los 9 routers (`/ppp secret`) + cruzar GR por username** (modelo dual: MK manda password/IP/profile, GR manda contrato/estado).
>
> **Hallazgos de la exploración (qué NO existe hoy, hay que construir):** NO hay adapter MikroTik/RouterOS (sin `node-routeros` en package.json); el `DisconnectSession` actual solo hace `prisma.radiusSession.delete()` (borra fila local, no manda nada al NAS); **NO existe el vínculo cliente↔router** (ni `Client` ni `Contract` tienen `nasId`); el `pppoeUsername` solo es transitorio en `GrContract`, no se persiste. **Reutilizable (ya en prod):** `mapWithConcurrency` (worker-pool), `SyncState`/`SyncStateRepository` (watermark resumible), `PgAdvisoryLock` (mutex distribuido), molde `CancelTvJobRunner`+`ClientTvCancelStatusRepository` (job async con estado), throttle `sleep` + backoff con `Retry-After`.
>
> **Fases (SDD por fases, modo interactivo, trail openspec, arranca por A):**
> - **Fase A — `pppoe-foundation`** ✅ **MODELO HECHO** (worktree `feat/pppoe-foundation`, commits `e9e34514`+`57c98e7c`): tabla `PppoeService` (`username` unique, `contractId` nullable, `nasId`, `profile`, `status`, `createdAt`) + entidad + port + repos Prisma/in-memory + migración aditiva `20260729`, test 5/5 verde, tsc limpio. **⚠️ Import/matching DESCARTADO (2026-06-16):** el usuario carga los PPPoE **manualmente** en la ficha del cliente → NO hace falta script de barrido ni matching fuzzy (se quitaron `matchMethod`/`importedAt` del modelo). El **Phase 0 igual sirvió**: conectividad 12/13 routers (`prominense`/API 8728), shape del `/ppp secret` y que **`IP-REDUCCION` ya existe** (clave para los cortes). Cimiento de B y C listo. **Pendiente menor**: actualizar los openspec (proposal/design/specs/tasks) que aún describen el import descartado (limpiar al hacer `sdd-archive`).
> - **Fase B — `pppoe-management`** ← **PRÓXIMO**: CRUD de PPPoE desde Prominense (crear/editar/mover de router/baja) = la **carga manual** del usuario, con **aprovisionamiento real** en el MikroTik vía RouterOS API (confirmado 2026-06-16: Prominense crea/edita el `/ppp secret`). Arranca con el **adapter RouterOS (port + write)** = base compartida con Fase C.
> - **Fase C — `pppoe-enforcement`**: cortes individuales + masivos por batch (agrupado por router, 1 carril por maestro, concurrencia baja, throttle + backoff + progreso persistido + resumible).
>
> **Cross-repo (BE + FE):** management UI + página de cortes en `ipnext-frontend`. **Permisos granulares a crear** (ambas capas): `pppoe.read` / `pppoe.manage` / `pppoe.cut` (nombres a confirmar en el design). **Migraciones aditivas** (columnas/tabla PppoeService).

### Cosa 1 — Auto-aprobar la OS desde Prominense — ❌ DESCARTADA *(2026-06-15)*
> Investigada a fondo en 3 capas (OpenAPI REST + test de escritura en vivo sobre OS 4888 + login real al web `fs2`): **no es viable por integración limpia.** La API REST no tiene endpoint approve; `close` está bloqueado por una **pesquisa (encuesta) obligatoria** que `CloseSOIn` no puede enviar; y el "aprobar" del web es un **postback JSF/Seam stateful** (ViewState), no un endpoint reusable. **Único camino: escalar a IClass** para un endpoint REST de approve/responder-pesquisa en `api-v2`. Detalle completo en engram (sondas + §10 + verificación web).


### iclass-ops-config — config y operación de IClass (mapeo técnico↔cuadrilla + auto-asignar + toggles de flags + visibilidad del dispatch) ✅ HECHO Y EN PROD *(BE `4e1c5a65` / FE `255edcd`, migración 20260727, 2026-06-15)*
> SDD `iclass-ops-config`, 3 olas. **A**: campo `RbacUser.iclassTeamLogin` (sub-page "Técnicos → Cuadrillas" en Config→IClass) + **auto-asignar** la cuadrilla a la OS cuando cambia el técnico de la tarea — best-effort: `UpdateTask` recibe un `IClassAutoAssigner` OPCIONAL via port (NO conoce `IClassPort`), nunca aborta el update local, dispara SOLO si el assignee cambió, triple cerrojo (flag `iclass-assign-action` + `iclassOrderCode` + cuadrilla `active&selectable`). **B**: toggles de `iclass-close-action`/`iclass-assign-action` en Config→IClass (antes no había UI). **C**: sub-page "Qué se envía a IClass" (read-only: soType por proyecto, nodo, estado inicial = lo pone IClass, hardcodeados marcados). Review opus CLEAN (el auto-asignar verificado rama por rama: doble red, `UpdateTask` nunca se traba) + composition test del wiring (anti "feature muerta"). **Pendiente usuario**: prender los flags + mapear cada técnico a su cuadrilla. **OJO modelo**: antes NO existía vínculo técnico (RbacUser) ↔ cuadrilla (IClassTeam) — son conceptos separados (Prominense asigna un técnico; IClass una cuadrilla); esta ola creó el puente.

### #118 — TV: email del alta NUEVA + preview/modal usan `grClienteId`, pero la clave (y re-alta) usan `grContratoId` — inconsistencia del #115 ✅ HECHO Y EN PROD *(BE `c7f8e2e8` / FE `2951f72`, 2026-06-15)*
> El #115 movió la CLAVE de TV a derivar de `Contract.grContratoId` (server-side, `RegisterGigaredAccount.ts:104`), pero dejó DOS cabos sueltos: (1) el **EMAIL del alta NUEVA** (`seq=0`) sigue saliendo del FE como `input.email` (`RegisterGigaredAccount.ts:133`), que el FE genera con `grClienteId` (`GigaredPanel.tsx:546`); (2) el **preview del email** (`GigaredPanel.tsx:546`) y el **modal de cambiar clave** (`GigaredPanel.tsx:983`) siguen mostrando `grClienteId`. → El operador VE email/clave derivados del **cliente** pero se CREAN derivados del **contrato** (la clave siempre; el email solo en re-alta `seq>0`). **Fix**: derivar el email también **server-side del `grContratoId`** (fuente única, igual que la clave — el BE no confía en `input.email` para el alta nueva) + el FE alinea preview/modal a `grContratoId` (`ContractCard` ya tiene el contrato → pasarle el `grContratoId` al `GigaredPanel`). BE+FE, sin migración.

### 🧹 Limpieza de worktrees — ✅ HECHO *(2026-06-15, sin incidentes)*
> **Resultado:** removidos 34 worktrees registrados (15 BE + 19 FE) + 1 hermano mal-anidado (`ipnext-frontend-task-service-picker-richer-label`) + 7 carpetas fantasma del cleanup cortado. Método junction-first: 22 junctions de `node_modules` matados con PowerShell `(Get-Item).Delete()` ANTES de cada `git worktree remove`; el conteo de hijos del `node_modules` principal se verificó IDÉNTICO antes/después en cada fase (BE 482 / FE 202, intacto). `git worktree list` queda con solo el principal por repo. **Pendiente menor (separado, NO hecho)**: podar ~126 BE / ~127 FE ramas locales mergeadas.
> **Método de referencia (NO borrar, sirvió):** Quedaron ~19 worktrees en `.claude/worktrees/` de ambos repos (TODOS mergeados a `main` y deployados), ocupando disco. **Método SEGURO (innegociable)**: borrar el junction `node_modules` con **PowerShell** (`Remove-Item`/`(Get-Item).Delete()`) ANTES del `git worktree remove`, verificando que el `node_modules` REAL del principal sobreviva en cada paso. ⚠️ **Incidente 2026-06-15**: un cleanup con `cmd //c rmdir` (que FALLA por el escaping de backslashes desde git-bash) seguido de `git worktree remove` → git **siguió el junction y BORRÓ el `node_modules` real del principal BE**; recuperado con `npm ci`. Lección: `cmd //c rmdir` con paths Windows NO anda desde git-bash; usar PowerShell, y NUNCA `git worktree remove` con el junction `node_modules` presente.

---

> **Nuevos ítems 2026-06-14 (pedido del usuario) — #115–#117. ✅ HECHOS Y EN PROD (2026-06-15).** SDD híbrido + automático (worktree por ítem) + strict TDD + gate por el orquestador + deploy verde en `gh`. Deploys: **BE `a6771fee` (#115+#117 — runs 27531817617 / 27530291209) · FE `78364d4` (#116 — run 27530294547)**. Sin migraciones nuevas. Verificación pre-deploy clave del #115: `useRegisterAccount` tiene un solo caller (`GigaredPanel`) que SIEMPRE manda `contractId` → el BE exigiéndolo no rompe el alta.

### #115 — Alta de TV por CONTRATO del cliente (ID del contrato de GR, no ID GR del cliente) ✅ HECHO *(BE `a6771fee`, en prod 2026-06-15)*
> Implementado: `RegisterGigaredAccount` deriva mail+password desde `Contract.grContratoId`; `contractId` requerido; error nuevo `GrContractIdRequiredError` (422 `GR_CONTRACT_ID_REQUIRED`) si el contrato no tiene grContratoId. Sin migración. Follow-up FE no-bloqueante: pulir el mensaje del 422 (hoy cae en error genérico — degradación elegante).
- Creación de TV ahora en vez de usar cliente, usar el patrón de "Contrato del cliente". Antes usábamos ID GR, ahora sería el ID del contrato de GR.
- Hoy `RegisterGigaredAccount` deriva mail+password de TV desde `customer.grClienteId` (ID del cliente); debe pasar a usar `Contract.grContratoId` (ID del contrato). SDD/worktree: `feat/tv-register-by-contract` (BE).

### #116 — Columna "ID de GR" visible en la page de contratos ✅ HECHO *(FE `78364d4`, en prod 2026-06-15)*
- El ID de GR debe ser visible en la page de contratos: agregar la columna.
- "ID de GR" = ID del contrato (`grContratoId`), que el BE YA expone en el DTO como `code` (`contract.dto.ts:11`) → columna FE-pura, sin cambios de backend. SDD/worktree: `feat/contracts-gr-id-column` (FE, en `ipnext-frontend`).

### #117 — Operador vacío en el historial de servicios del contrato ✅ HECHO *(BE `c44f2321`, en prod 2026-06-15)*
> Implementado: fix read-side (patrón #106) — adapters Prisma resuelven el operador con `actorName || actor?.login || ''` (JOIN a RbacUser). Sin migración. ⚠️ Limitación: los eventos sintéticos legacy (sin fila, ej. la fila del screenshot del 11-jun) quedan en blanco — sin back-fill posible.
- En el historial del contrato (modal con columnas TIPO [Alta/Baja] y OPERADOR), el OPERADOR sale EN BLANCO. Screenshot del usuario: "Contratado: 11 jun 2026 · Baja: 14 jun 2026 · CIC 0006870063 · Gigared Play Full" con TIPO Alta/Baja pero OPERADOR vacío.
- Investigar por qué no se puebla/muestra: el DTO ya expone `actorName` (`contract-services.dto.ts:86`, mapeado en `:147`) y los use cases (`AddContractService`, register/cancel TV) aceptan `actor` pero defaultean a `''` si la ruta no lo pasa. Causa probable: las rutas no threadean `req.user`, o falta resolver el nombre vía JOIN a RbacUser AL LEER (patrón del #106 que arregló "Cliente: —"). SDD/worktree: `feat/contract-history-operator` (BE).

> **Batch 2026-06-14 — #109–#114 + 4 deudas, COMPLETO y EN PROD.** SDD auto+híbrido, **worktree por cosa con junction de `node_modules`** (instantáneo vía `New-Item -ItemType Junction` en PowerShell; los frentes que NO cambian schema reusan el prisma client del principal; los que sí, usan `(prisma as any)` sin `prisma generate`). Verify integrado BE 4270/0 + tsc · FE 3088/0 + tsc, 9 branches mergeadas sin conflicto. Deploy a `main`: **BE `80a52835` / FE `e647681`**, migraciones aditivas `20260722` (contract_service_event) + `20260723` (drop tv.write). Review adversarial + fix wave por ítem (cazaron: CIC vacío del pool, síntesis legacy TV, asimetría no-TV, z-index/CSS de portales, fallback de localidad anti-borrado).

### #109 — CIC aleatorio del pool al registrar TV ✅ HECHO *(BE+FE, en prod)*
> El CIC ya no se elige: `RegisterGigaredAccount` toma uno al azar del pool `listAccounts({status:'unregistered'})` (pick inyectable para testear); pool vacío o CIC vacío → `NoCicAvailableError` (422 `NO_CIC_AVAILABLE`) → el FE muestra un **modal**. Form sin select, mensaje "el CIC se asignará de forma aleatoria". Deuda anotada: `gigaredPassword` en `@infrastructure` importado desde application (DIP, pre-existente).

### #110 — Historial de servicios = ledger append-only ✅ HECHO *(BE+FE, en prod, migración 20260722)*
> Tabla `contract_service_events` (activated/deactivated/reactivated, registro best-effort en Add/Update/Remove) que el `ServiceHistoryModal` muestra como **secuencia temporal por servicio**. TV se CRUZA en lectura desde `tv_activation_events` (discrimina por `tvLogin`; supuesto 1-TV-por-contrato documentado + síntesis legacy del alta). DTO `events[]` aditivo (no rompe el contrato). Limitación: sin backfill del histórico pre-migración.

### #111 — Quitar card de cupos de la página TV ✅ HECHO *(FE)*
### #112 — Ordenar por columna ID en la lista de tickets ✅ HECHO *(FE — sort client-side por `sequenceNumber`, toggle asc/desc; deuda: solo la página visible)*
### #113 — "Creado" + formato de fecha consistente en tickets ✅ HECHO *(FE — reusa `formatDateTimeShort` del #83)*
### #114 — Localidad en Tareas Nodos cae a iclassCityCode ✅ HECHO *(FE — 1 línea: `customerCity || iclassCityCode || '—'`; el tipo ya exponía el campo)*

### Deudas técnicas saldadas ✅ *(en prod)*
> **#1** permiso huérfano `tv.write` eliminado (migración 20260723, FK cascade) · **#4** `siteId` whitespace→null en tareas fibra · **#3** localidad (`iclassCityCode`) editable en el detalle de la tarea (con **opción-fallback anti-borrado** para nodos desactivados) · **#5** dropdowns de `CustomerDetailPage`/`CustomersListPage` portalizados (`createPortal`, z-index 1000, `position: fixed`). **#2** (`PATCH /feature-flags` sin guard) ya estaba **SALDADA** (`requirePerm('admin','flags')`).

### ✅ IClass status sync (Approach 3) — HECHO Y EN PROD *(BE `dc93815f` / FE `9f4969d`, migración 20260724)*
> SDD `iclass-status-sync` Fase 1: catálogo configurable `IClassStatusCatalog` (auto-discovery, opt-in `tracked`) + estado de la OS en la tarea, **sin llamadas nuevas a IClass** (se captura del `listServiceOrders` que el scheduler ya corre, ANTES del guard terminal `'7'` — el cierre legacy quedó intacto). FE: sub-tab "Estados de IClass" (junto al mapeo de result-codes) + badge en la tarea, visible SOLO si `tracked`. **Review opus cazó 2 FIX-FIRST que el verify (4281 verde) NO vio**: (1) **feature MUERTA en prod** — captura cableada en `app.ts` pero NO en los 3 bootstraps del cron (idéntico al bug W6 del EPIC #38) → fix cableó los 3 + composition test que lo pinea; (2) int4-overflow en el lookup (OS nativas de IClass con `codigo` gigante desbordan `sequenceNumber`) → guard `INT4_MAX`. + drift de URL FE (`/admin/iclass/statuses`) + color-picker onBlur + gate `iclass.read`. Re-verify mergeado con el batch: **4331/0**. **Post-deploy (usuario)**: Config → Estados de IClass → "Sincronizar" (auto-puebla los códigos reales) → editar etiqueta/color → prender `tracked` de los que querés seguir. Investigación en `INVESTIGACION-ICLASS-ESTADOS.md` + engram.

### ✅ IClass — operar la OS desde Prominense (Fases 2+3) — EN PROD con FLAGS OFF *(BE `389dbf31` / FE `e538b71`, migraciones 20260725 teams + 20260726 rbac/flags)*
> SDD `iclass-os-actions`, 2 olas. **Fase 2** (cerrar/validar): `POST /serviceorders/close` + use case `CloseIClassServiceOrder` con **pre-check EN VIVO** (`getServiceOrder`: OS ya cerrada→409, inexistente→404) + guard tarea `open`; botón "Cerrar OS" + modal (result-code + comentario + fecha). **Fase 3** (asignar cuadrilla): `POST /serviceorders/update` (requiredTeam) + catálogo `IClassTeam` (clon de `IClassNode`, sync desde `GET /teams`); selector de cuadrilla + página admin de teams. **Candados**: flags `iclass-close-action`/`iclass-assign-action` **OFF por default** (código inerte) + permisos `scheduling.iclass_close`/`iclass_assign` solo super_admin + errores con `reason` visible. **El review opus cazó el bug más peligroso**: las escrituras NO chequeaban el rate-limit de IClass (que viene como **HTTP 200** con texto "Espere um pouco") → habrían marcado la tarea cerrada en Prominense con la OS ABIERTA en IClass (silent-success destructivo) → fix: `isRateLimited` + validación de shape estricta → `IClassUnavailableError`. **PENDIENTE — prueba en vivo (§10)**: flippear el flag con una OS de PRUEBA para capturar el shape real de la respuesta de IClass (endpoints no-probados; la API ya mintió 3 veces) ANTES de habilitar; ajustar los parsers si hace falta (hay un `TODO` en `IClassClient.closeServiceOrder/updateServiceOrder`).

---

> **Refinamientos 2026-06-13 — #101–#108, COMPLETO.** Follow-ups del batch #88–#100 sobre uso real (el usuario testeando en vivo). SDD auto+híbrido, worktree por cosa, **gate FULL antes de cada deploy**. Deploys directos a `main`: refine #101–#105 (BE `8c70cf32` / FE `5da6829`), #106–#107 (BE `23f1e8bc` / FE `b1dc767`), #108 (BE `91f83b22` / FE `28769fc`). **SIN migraciones nuevas** (todo sobre columnas/relaciones existentes).

### #101 — Archivar: los tickets archivados quedan visibles ✅ HECHO *(FE `cd686e1`, en prod)*
> El item "Archivar" del sidebar linkeaba a `/admin/tickets/trash` (vista status=closed) → al archivar (setear `archivedAt`) el ticket se excluía y **desaparecía**. Ahora apunta a `/admin/tickets/archived` (archivedView → `?archived=true`) donde los archivados quedan visibles (es soft, no borrado). Tareas: el flujo ya era correcto (verificado, sin cambio).

### #102 + #105 — TV: historial como modal + por-cliente con CIC + chip stale + baja-con-CIC ✅ HECHO *(BE `d70672a3` + FE `0ab3d30`, en prod)*
> #102: la página suelta del historial de activaciones TV pasó a `ActivationHistoryModal` (portal, espejo de ServiceHistoryModal), abierto desde "Ver historial" (global, en la page TV) y "Historial TV" (por-cliente, en el GigaredPanel); se borró la ruta `/tv/history` + el item del sidebar. #105: el evento `baja` de `tv_activation_events` ahora lleva su CIC (antes quedaba null); el chip TV del contrato se oculta cuando la fila está `inactive` (stale post-baja). Aclaración: el "Historial de servicios" (#73) colapsa la TV en 1 fila por el unique `(contrato,servicio)` — el historial por-CIC vive en `tv_activation_events` (append-only).

### #103 + #104 — Recaptación: selector de estado + asignado por nombre + tabs Bajas/CSV ✅ HECHO *(BE `4e73d25d` + FE `216c53f`, en prod)*
> #103: el lead quedaba pegado en `en_gestion` y no se podía cambiar — ahora un `<select>` con los 6 estados wired a `UpdateRecaptureLeadStatus` (gate recapture.manage); el "Asignado" muestra el NOMBRE (`assigneeName` resuelto por JOIN a RbacUser, no el id); sacado el checkbox roto "avanzar estado". #104: tabs **"Bajas" / "CSV"** (filtro `source` agregado de punta a punta: port + prisma + in-memory + ruta + FE) → los leads de CSV viven en su vista aparte, no mezclados con los de baja.

### #106 + #107 — TV: nombre del cliente en el historial + re-add de TV al picker ✅ HECHO *(BE `23f1e8bc` + FE `b1dc767`, en prod)*
> #106: el historial TV mostraba "Cliente: —" — el `TvActivationEventDto` ya declaraba `customerName` y el modal ya lo renderizaba, pero el repo Prisma nunca hacía el JOIN; ahora `include client` → cada evento muestra el cliente (resuelto AL LEER, así los eventos viejos también lo muestran). #107: tras la baja, la fila TV `inactive` (no se borra) metía su `serviceCatalogId` en los `attachedIds` del `ServicePickerMenu` → TV quedaba excluido del picker "Agregar servicio" y no se podía recrear; ahora `attachedIds` se arma solo de servicios `active` → la TV dada de baja vuelve a ofrecerse.

### #108 — Recaptación: reasignar un lead a otro operador ✅ HECHO *(BE `91f83b22` + FE `28769fc`, en prod)*
> Antes solo se podía "Tomar" (auto-claim) o "Liberar". Nuevo `AssignRecaptureLead` (valida `operatorId` via el `EntityLookup` de scheduling — `userLookupForScheduling`, ya wired; delega en `repo.assign` = claim sin el guard `IS NULL`; `null` = liberar) + ruta `PATCH /recapture/leads/:id/assign {operatorId}` (gate recapture.manage). FE: `<select>` de operadores (opciones de `GET /api/admins` vía `useAdmins`) en el `LeadDetailDrawer`; "Tomar" queda como atajo de auto-claim; vaciar el select = liberar.

---

> **Mini-batch 2026-06-13 (jornada tarde) — #88–#100, COMPLETO.** SDD automático + híbrido, **7 worktrees** (worktree por cosa; cadena TV serial WT1→WT4 + 3 independientes). **Gate full INTEGRADO antes de deploy** (rama `integration/batch-2026-06-13` por repo; BE `jest` 4177/0 + tsc, FE `vitest` 3002/0 + typecheck). Deploy directo a `main` vía la rama de integración (sin PR): **BE `62ddd916` / FE `846dfb1`**, migraciones aditivas `20260719`/`20260720`/`20260721`.

### #88 + #91 — TV: errores espurios (OTT race/stale + vincular 500) ✅ HECHO *(BE `617a22de` + FE `743fe58`, en prod)*
> #88: `GigaredClient.setOtt` ahora trata como idempotente el "ya se encuentra (des)habilitada" también cuando el partner lo manda como **424 external-service-error** (`GigaredUnavailableError`), no solo como 409 — era el bug del "No se pudo cambiar el OTT" + estado stale. #91: helper `sendUnhandled` da **500 estructurado** `{code:'INTERNAL_ERROR'}` en los 13 handlers gigared (el vincular tiraba 500 opaco aunque la acción SÍ se ejecutaba). FE: `useSetOtt`/`useLinkCic` invalidan en `onError` → fin del salir/entrar para ver el estado real.

### #89 + #90 + #96 — TV register/modal (Invalid Date + link roto + ID interno eager) ✅ HECHO *(BE `b1acbcad` + FE `d1a8ace`, en prod)*
> #89 (Invalid Date): `mapAccount` normaliza `registration_date` DD/MM/YYYY→ISO (el FE ya usaba `formatDateShort` del #83 — quedó solo el lado BE). #90 (link roto): la lista de cuentas TV expone `clientId` = `Client.id` sin el sufijo `-{seq}` del #81; el FE linkea con ese (antes pegaba a `/admin/customers/view/{uuid}-1` → 404). #96: el "ID interno" se muestra desde `account.internalId` (eager) en vez de la query lazy de credenciales — aparece al abrir el modal, sin "Mostrar contraseña".

### #97 + #98 — Baja TV ASÍNCRONA + quitar ítem/control ✅ HECHO *(BE `f287c38f` + FE `c015815`, en prod, migración 20260720)*
> #97: la baja era síncrona y bloqueaba ~15s (N `removeService` secuenciales contra el CUA). Ahora `POST .../cancel` responde **202** + dispara `CancelTvJobRunner` fire-and-forget (estado en `Client.tvCancelStatus/Result/StartedAt`, espejo del #32); `GET .../cancel/status` para pollear (guard de concurrencia → 409 `already-running`). `CancelTv` use case INTACTO. FE: modal con spinner ⏳ → ✓ verde / ✗ rojo + ícono de error + motivo (antes no había feedback si fallaba). #98: el ítem TV se quita en el reconcile recién al cerrar OK el async; eliminado el control "Agregar solo el ítem local (sin Gigared)".

### #92 — Historial de altas/bajas de TV (por operador/cliente/fecha) ✅ HECHO *(BE `a290d283` + FE `1056baa`, en prod, migración 20260721)*
> Tabla `tv_activation_events` + `TvActivationEventRepository`. `RegisterGigaredAccount` registra `alta`(seq 0)/`reactivacion`(seq>0); `CancelTvJobRunner` registra `baja` on-done — best-effort, con el operador (`req.user`) threaded (en el cancel async se captura en el POST y se pasa al runner). `GET /gigared/customers/activation-history` (global + filtros actorId/customerId/fechas) y `/:id/activation-history`, gate `tv.read` (ruta global ANTES de `/:id`). Page nueva `/admin/customers/tv/history` (Fecha · Tipo badge · Cliente link · Operador) + filtros + item de sidebar.

### #93 + #94 + #99 — Archivar/bulk (tickets + tareas) ✅ HECHO *(FE `7638842`, en prod)*
> #93: la page de tickets archivados ya filtraba `archived=true` (estaba OK en el main actual — no-op). #99: `/admin/scheduling/archive` ahora renderiza `SchedulingArchivedTasksPage` (data real `GET /scheduling?archived=true`); se borraron el page+api+hook+type **mockeados** y la ruta duplicada `/archivadas`. #94: fuera "Eliminar" y "Eliminar definitivamente" del bulk de tickets (queda **Archivar**) y el hard-delete del bulk de tareas; el hard-delete sigue solo en la acción individual super-admin. (BE sin cambios — endpoints ya existían.)

### #95 — Tickets: estados dentro de Configuración ✅ HECHO *(FE `8205cf9`, en prod)*
> `/admin/tickets/statuses` (ruta suelta) → sub-tab "Estados" de `TicketsSettingsPage` (espejo de Áreas/SLA) + redirect de la ruta vieja + fuera el item del sidebar. El gate pasó de `tickets.read` a `tickets.manage` (alineado con Áreas/SLA — es config de admin; regresión documentada: un `tickets.read`-only ya no ve el catálogo de estados).

### #100 — Recaptación v2 (botón ingest + import CSV + menú) ✅ HECHO *(BE `5fe690b2` + FE `413c887`, en prod, migración 20260719)*
> Causa raíz de "no veo los clientes de baja": el sync GR→`Client.status='baja'` FUNCIONA; faltaba el **botón "Ingestar bajas"** (la API existía sin hook/botón) → agregado (`useIngestChurned`, gate `recapture.manage`, toast `{created, skipped}`). **Import CSV**: 3 columnas nuevas en `RecaptureLead` (`address`/`churnReason`/`previousPlan`) + `ImportCsvLeads` + parser CSV puro (sin dep) + `POST /recapture/import-csv {csv}` → `{created, errors}` + `GET .../import-csv/template` (descarga de ejemplo); modal de upload en el FE (lee el archivo como texto). Sidebar: Recaptación movido ARRIBA de Configuración. Sin feature flag (operación admin, gateada por `recapture.manage`).

> **Notas de la jornada #88–#100:** (1) el FE local estaba **83 commits atrás** de origin al arrancar → re-sync (fast-forward) obligatorio ANTES de explorar; toda exploración FE inicial fue inválida hasta sincronizar. (2) Las 3 migraciones (`20260719`/`20`/`21`) son aditivas, conviven y se aplican en orden en el deploy. (3) Verify INTEGRADO (suite full sobre la rama mergeada) hecho antes del merge a main — paso del WORKFLOW que faltaba encarar. (4) **Pendiente de prueba en vivo**: la baja TV async con un cliente NUEVO (el 204366 sigue corrupto en Gigared — bloqueo del partner).

---

> **Mini-batch 2026-06-13 (noche) — #80–#87, COMPLETO.** SDD automático + híbrido, worktree por surface. BE PRs #135–#138 / FE PRs #123–#128, migraciones 20260714–20260718.

### #83 — Formato de fecha legible en toda la app ✅ HECHO *(FE PR #128, en prod)*
> Sweep global: fechas crudas/ISO → `08 sep 2025 - 13:45` (o solo fecha). Helpers `formatDateTimeShort`/`formatDateShort` (deterministas con MONTHS_ES). 42 archivos barridos. La re-review cazó un bug de TZ (las fechas solo-fecha ISO-Z de medianoche mostraban el día anterior — Vigencia "07 sep" en vez de "08 sep") → fix tratando el ISO-Z midnight como UTC. Legacy formatRelative (#44)/timelines (#77) intactos. ⚠️ El builder no había commiteado el sweep (estaba en el working tree) — el orquestador lo cazó y lo commiteó.

### #81 — TV: re-alta tras baja (identidad por cliente + secuencial) ✅ HECHO *(BE PR #135 + FE PR #123, en prod, migración 20260714)*
> Modelo confirmado en vivo: el renew deja el CIC nuevo limpio pero el internal_id viejo (=Client.id) queda QUEMADO en el CIC muerto (append-only) → re-usar el crudo choca. `Client.tvActivationSeq` (identidad TV por cliente, compartida entre N contratos); re-alta = registro fresco con internal_id `{Client.id}-{seq}` + mail secuencial. Back-compat seq=0 (clientes/altas de hoy intactos). El cupo se recicla con el abonado, no se libera (Gigared). Review CLEAN.

### #82 — Rediseño "Agregar SN al contrato" ✅ HECHO *(FE PR #124, en prod)*
> El form inline crudo de agregar/editar equipo del contrato pasó a un modal dedicado (InstalledItemFormModal, portal+focus+Escape, normalización SN + validación MAC). Contrato API intacto. Review CLEAN.

### #84 — Ticket Timer: para al cerrar + pos 3 ✅ HECHO *(BE PR #136 + FE PR #125, en prod, migración 20260715)*
> `Ticket.resolvedAt` estampado al cerrar (limpiado al reabrir — la re-review cazó el stale); el timer congela en `resolvedAt-createdAt`, no sigue con el reloj. Columna en posición 3.

### #85 — Tickets: archivar + eliminar super-admin + cerrados ocultos ✅ HECHO *(BE PR #136 + FE PR #125, en prod, migración 20260716)*
> `Ticket.archivedAt` (ortogonal al status). Archivar exige cerrado primero (422), idempotente, gateado **tickets.manage** (la re-review cazó que tickets.close daba 403 a los admin). Page /admin/tickets/archived. Hard-delete `DELETE /:id/hard` solo super_admin (`tickets.delete_hard`, sin seedear). Lista principal solo abiertos; archivados excluidos server-side siempre.

### #87 — Tickets: filtros como Tareas ✅ HECHO *(FE PR #125, en prod)*
> Fuera el TicketFilterDisclosure colapsable → TicketFilterBar horizontal siempre visible (espejo de TaskFilterBar), con los 6 filtros propios de tickets intactos.

### #80 — Page "Recaptación" (leads de clientes de baja) ✅ HECHO *(BE PR #137 + FE PR #126, en prod, migración 20260717)*
> SDD `recaptacion-leads`. `RecaptureLead` (desacoplado del Client para el CSV futuro: source churned_client|csv) + `RecaptureContact` (bitácora) + **claim race-safe** (la re-review cazó que el "tomar siguiente" no era atómico → reescrito con `FOR UPDATE SKIP LOCKED`, N operadores sin pisarse) + pipeline de estados + permiso recapture.read/manage. Page /admin/customers/recaptacion (claim rápido + drawer con timeline + form de contacto). Review + fix wave CLEAN. **Futuro**: import CSV (modelo ya preparado).

---

> **Bloqueo externo (NO es código)**: ESCALAMIENTO A GIGARED — pendiente del #72/#81. (1) Pedir endpoint de desasociación/borrado de internal_id. (2) **Limpiar el abonado 204366** (HERNANDEZ RONALD), que de tanto testeo quedó CORRUPTO en el partner: internal_ids basura (`BAJA_*`, `99999999`, etc.) + **múltiples "activaciones pendientes"** (cada register fallido del #81 dejó una cuenta huérfana) → ya no se puede testear limpio con ese cliente. **Para probar el flujo real: usar un cliente NUEVO sin historial de TV.**

---

> **Mini-batch 2026-06-12/13 (noche 2) — #74–#79, COMPLETO.** BE PRs #133–#134 / FE PRs #120–#122, migración 20260713.

### #74 — Baja TV: renew exitoso = baja COMPLETA ✅ HECHO *(BE PR #133 + FE PR #120, en prod)*
> Confirmado por el usuario: el renew del CIC ES la baja efectiva (login/mail muerto, no entra más). Verificado live: el CIC nuevo queda con ott null/reseteado, el viejo da 403 (desvinculado) → el OTT viejo es moot. El "OTT sigue activo" del modal era stale (el apagado corre ANTES del renew). Criterio nuevo: 207 solo si `failed>0 || local failed || (renewAttempted && renew null) || (!ottDisabled && !renewSucceeded)`; único caso que cambia es renew-OK+ott-false → 200. Modal: "Cuenta reiniciada (CIC nuevo)". Review CLEAN.

### #75 — Área en posición 2 por default ✅ HECHO *(FE PR #122, en prod)*
> `areaName` a índice 1 en ALL_TICKET_COLUMNS; el orden guardado del usuario se respeta (solo cambia el default).

### #76 — Nombre del cliente como link ✅ HECHO *(FE PR #122, en prod)*
> customerName → Link /admin/customers/view/{customerId} (fallback texto plano).

### #77 — Datos → comentario de apertura + fecha legible ✅ HECHO *(FE PR #121, en prod)*
> El tab "Datos" (solo mostraba la descripción) se eliminó; la descripción aparece como comentario VIRTUAL al tope del feed, atribuido al reporter + fecha de creación (no persistido — la descripción ya vive en el ticket). Helper formatDate es-AR centralizado.

### #78 — Columna "Tipo" eliminada ✅ HECHO *(FE PR #122, en prod)*
> **Qué era**: campo muerto — `type` no existe en el BE (ni entity, ni DTO, ni Prisma, ni CreateTicket), renderizaba vacío para toda fila. Eliminada del catálogo.

### #79 — Columna Timer SLA configurable (pos 3) ✅ HECHO *(BE PR #134 + FE PR #122, en prod)*
> Minutos desde createdAt con color verde/amarillo/rojo por umbrales `TicketSlaConfig` singleton (warn=60, danger=240, configurables en /admin/tickets/settings → sección SLA, gate tickets.manage; 422 si danger<=warn). Congela gris en cerrados. Migración aditiva 20260713 (dry-run prod OK). Orden final de columnas: id · Área · Timer · Tema · Cliente(link) · Reporter · Prioridad · Estado · Asignado · Creado.

### ⚠️ Escalamiento a Gigared (bloqueo del partner, NO es código)
- El partner **no tiene primitiva de desvinculación**: PATCH internal_id '' → 400; el mapeo internal_id↔CIC es append-only (DELETE 405/404; renew arrastra los ids). Pedir un endpoint real de **desasociación/borrado de internal_id** o de baja de cuenta.
- Pedir que **limpien los internal_ids basura** del abonado **204366** (HERNANDEZ RONALD), quedaron de las pruebas live del #72: `BAJA_1781312566206`, `BAJA204366X1`, `99999999`, `baja-test-uuid-1234`, y CICs quemados (0006230159 → 0006287299 → 0006332579 → 0006717800).

---

### #72 — Baja LOCAL de TV (el partner no desvincula) ✅ HECHO *(2026-06-12, BE PR #132 + FE PR #119, en prod)*
> **Hallazgo live (divergencia #10 de Gigared)**: el unlink del #64 NUNCA funcionó — PATCH internal_id '' da 400 SIEMPRE, el mapeo es append-only, no hay DELETE. El "no se pudo desvincular" era permanente, no un edge. Fix: baja LOCAL honesta vía `Client.tvCancelledAt` (migración `20260712`, el sync GR no la pisa — allowlist verificada); `GetGigaredCustomerAccount` responde no-vinculado con el flag → panel limpio, se puede cargar TV nueva; link/register limpian el flag; el retry da 404 ANTES del partner (mata el acuñado de CICs); se quitó el paso unlink muerto (`localCancelled` reemplaza `unlinked`). Review CLEAN.

### #73 — Historial de servicios del contrato ✅ HECHO *(2026-06-12, BE PR #131 + FE PR #118, en prod)*
> `GET /api/contracts/:id/service-history` (clients.read) + `ContractService.deactivatedAt` (migración `20260711`, estampada centralizada en repo.update — fecha de baja REAL, el modelo no tenía updatedAt) SIN tvPassword (DTO whitelist). FE: botón Historial en la card → modal lightbox (Servicio·Estado·Datos·Contratado·Baja) + empty state + invalidación en mutations. Review CLEAN + fix wave. Limitación: filas inactivadas pre-migración → '—' (sin backfill posible).

---

> **Mini-batch 2026-06-12 (tarde) — #67–#71, COMPLETO.** SDD automático + híbrido, worktree por ítem. BE PRs #128–#130 / FE PRs #113–#117, migración 20260709.

### #67 — Baja TV: el pack base irremovible ✅ HECHO *(2026-06-12, BE PR #129 + FE PR #115, en prod)*
> Investigado LIVE (CIC 0006230159): el CUA responde **424 determinístico "El servicio seleccionado no se puede dar de baja"** al DELETE del pack base — cupo 1:1 con la cuenta, lo recicla el renew (**divergencia #9 de Gigared**). Fix: el 424 con esa firma va a `unremovable[]` informativo (cardinalidad 1; ≥2 matcheos → todos a failed, conservador) → la baja sigue a renew+unlink → 200; **el reconcile excluye los irremovibles** (la re-review cazó la fila TV quedando ACTIVA con credenciales zombie en el 100% de las bajas reales — mocks deshonestos corregidos). FE: línea informativa neutra "se libera al renovar el CIC". Limitación documentada: retry post renew-OK/unlink-FAIL puede acuñar otro CIC.

### #68 — Coordenadas en dirección de tareas de nodo ✅ HECHO *(2026-06-12, FE PR #113, en prod)*
> `resolveSiteAddress`: address manual gana → coords UISP `"{lat},{lng}"` (formato exacto del #51) → vacío. Editable, ref-guard contra pisadas, refresca al cambiar de nodo.

### #70 — TV: la contraseña del alta se autogenera ✅ HECHO *(2026-06-12, BE PR #130 + FE PR #116, en prod)*
> Rework sobre la primera interpretación ("obligatoria en el form"): el form **ya no pide contraseña** (nota "La contraseña se genera automáticamente"); el BE la construye server-side (`ip{grClienteId}` paddeada a 8, #65) con assert CUA local — sin grClienteId → 422 GR_CLIENT_ID_REQUIRED (generador random borrado, sin fallbacks ocultos). Se persiste y se ve en Credenciales. **El cambio de contraseña sigue libre** (modal #65).

### #71 — Link al cliente roto en detalle de ticket ✅ HECHO *(2026-06-12, FE PR #117, en prod)*
> `/admin/clients/{id}` (ruta fantasma → 404) → `/admin/customers/view/{id}`. Barrido completo: era el único uso del prefijo viejo; test pinea el href canónico.

### #69 — Columna de área con color en tickets ✅ HECHO *(2026-06-12, BE PR #128 + FE PR #114, en prod)*
> `TicketAreaCatalog.color` (hex validado, migración `20260709` + seeds idempotentes: Soporte índigo / Administración ámbar / Facturación esmeralda — dry-run prod OK; el área "GigaRed" que creaste quedó índigo default, recoloreable del ABM) + `areaColor` en el DTO (INCLUDE compartido) + pill con contraste por luminancia + color picker en el ABM.

> **Bloque agregado 2026-06-12 (batch #48–#62, 15 ítems).** SDD automático + hybrid, **worktree por ítem** (pedido explícito del usuario), review adversarial post-apply (loop fix→review del WORKFLOW). Olas sugeridas:
> **A (quick fixes)**: #48 → #56 → #58 · **B (cluster TV page)**: #61 → #62 → #57 → #60 → #50 · **C (tickets/feedback)**: #49 → #59 · **D (tareas fibra + IClass, en orden)**: #52 → #53 → #54 → #51 → #55.

### #48 — Ticket detail: Reporter visible + botón GUARDAR ✅ HECHO *(2026-06-12, BE PR #119 + FE PR #99, en prod)*
> SDD `ticket-reporter-and-save`. `Ticket.reporterId` (migración `20260701000000`, FK SetNull, sin backfill — viejos muestran "—"), POST estampa `req.user.id` (body `reporterId` validado → 422 REPORTER_NOT_FOUND), PATCH unificado `{assigneeId,status,priority,...}` con status validado contra catálogo ANTES de persistir. FE re-aplicado sobre el redesign #44: draft local re-seedeado por ticketId (la review cazó drafts cruzados entre tickets), banner de error del 422, columna Reporter del listado (la re-review cazó la key a medio renombrar — la columna DESAPARECÍA). Deudas anotadas: warn-before-leave no cubre navegación SPA; cerrar sin tickets.close vía draft (pre-#44).

### #49 — Áreas de tickets ✅ HECHO *(2026-06-12, BE PR #122 + FE PR #107, en prod)*
> SDD `ticket-areas` (encadenado con #63). `TicketAreaCatalog` (ABM /api/tickets/areas, read=tickets.read/writes=tickets.manage — sin lockout del operador común, verificado por la review) + `Ticket.areaId` FK SetNull + obligatoria al crear (422 antes del write) + filtro ?areaId (seam #28 cazado de nuevo y pineado) + área en el draft+GUARDAR del #48. Config: page nueva /admin/tickets/settings. Migraciones 20260703 (grant tickets.manage a administrador) + 20260704 (tabla+FK+seed Soporte/Administración/Facturación). Fix waves: selects con loading/error+Reintentar, trim del nombre, composition-pin del wiring.

### #50 — TV: permisos granulares ✅ HECHO *(2026-06-12, BE PR #121 + FE PR #106, en prod)*
> SDD `tv-granular-permissions`. 5 permisos nuevos (tv.link/register/packs/ott/cancel) reemplazan tv.write en las rutas gigared; FE parte el Can por acción. Migración 20260705 (seed+grants idempotentes). Query pre-deploy en prod: ningún rol no-sistema tenía tv.write → sin lockout. Deuda: `tv.write` huérfano en el catálogo (checkbox sin efecto en PermissionMatrix — limpiar en migración futura).

### #51 — Networking: identidad fija NODO {n} ✅ HECHO *(2026-06-12, BE PR #123 + FE PR #108, en prod)*
> SDD `network-site-fixed-code`. `NetworkSite.siteNumber` autoincremental (migración 20260706 patrón serial probado — la review cazó el drift de dbgenerated; dry-run prod 73/73) → `fixedCode = "NODO {n}"` derivado en dominio, read-only. **El dispatch NO cambió** (los nodos de IClass SON las ciudades — fixedCode es identidad interna; labels de la UI desambiguados: "Localidad (código IClass)" vs "Código — no se envía a IClass"). Dirección con hint coordenadas UISP (manual gana).

### #52 — Tipo "Nodo" → "Nodo Fibra" ✅ HECHO *(2026-06-12, FE PR #104, en prod)*
> Rename label-only del badge (tabla/kanban/modal); testid y aria intactos; sin dropdown de tipos.

### #53 + #54 — Dirección y localidad en tareas de nodo ✅ HECHO *(2026-06-12, BE PR #120 + FE PR #105, en prod)*
> Cadena SDD con #52. #53: 422 NETWORK_TASK_ADDRESS_REQUIRED en create; update por CAMBIO real (la review cazó el lockout de tareas legacy — lección #40 otra vez) + task.address llega al dispatch blank-aware (la re-review cazó el `??` con `''`). #54: `iclassCityCode` snapshot (migración 20260702) + dropdown del catálogo IClassNode + precedencia dispatch task>site. ⚠️ El #54 exigía localidad para TODO kind=network — **relajado a solo-fibra en el #66**. Deuda: localidad no editable post-create desde el detail.

### #55 — Envío a IClass: código = contrato ✅ HECHO *(2026-06-12, BE PR #124 + FE PR #109, en prod)*
> SDD `iclass-contract-code`. customerCode = `Contract.grContratoId` (código GR real @unique — NO secuencia inventada; sin migración) con fallback blank-aware al cliente para tareas sin contrato; network intacto; IClass crea/matchea el customer inline (verificado). FE: badge mono en la card. Post-deploy: identidades mixtas en IClass (OS viejas por cliente, nuevas por contrato) — esperado. Deuda: fidelidad del JOIN contractCode en in-memory.

### #56 — `/admin/contracts/`: hiperlink al cliente ✅ HECHO *(2026-06-12, BE PR #118 + FE PR #97, en prod)*
> `clientId` aditivo en el DTO del listado (la review cazó el route test sin actualizar — el builder no corrió la suite) + Link con fallback a texto plano si falta (deploy desfasado/cache, patrón #47j).

### #57 — TV: cupos "mal mostrados" ✅ CERRADO COMO NO-BUG *(2026-06-12, verificado live)*
> El panel reproduce el `/partners/summary` campo por campo: **Gigared Play Full está realmente 102/102 agotado** en el partner (`qty_available:0`); los "18→17 disponibles" son de OTRO servicio (Pack Todo Futbol 63/80). Sin caché ni mezcla de campos. Si se quiere más cupo de GPF, es comercial con Gigared.

### #58 — Modal "+ Agregar servicio" cortado ✅ HECHO *(2026-06-12, FE PR #98, en prod)*
> Causa: popover inline absolute dentro de `.card{overflow:hidden}` (AD-4 del #42 era el bug). Portal a body + fixed + scroll interno + flip anclado al trigger + toast portaleado + teclado ARIA (la review cazó resize con TypeError y flip flotando a 200px). Deuda: dropdowns de CustomerDetailPage/CustomersListPage con el mismo riesgo estructural.

### #59 — Feedback en "Reprocesar ahora" ✅ HECHO *(2026-06-12, FE PR #102, en prod)*
> Causa raíz REAL: el botón estaba `disabled` cuando `pending>0` — justo cuando había trabajo (del #23; "hay pendientes" ≠ "run en curso"). Habilitado + banner con conteo + "Procesando…" en vivo (polling existente) + 503 simétrico. Re-disparo seguro (BE responde already-running, idempotente). Follow-ups: sin estado final post-drain; invalidar pendingCount tras queued; a11y de banners viejos.

### #60 — TV: dispositivos registrados ✅ CERRADO *(2026-06-12, FE PR #103, en prod — la API no lo expone)*
> Verificado live: `qty_registered_devices` viene **0 en las 87 cuentas** (roto upstream) y el OpenAPI oficial no tiene ningún path de devices. Se eliminó el segmento "· N dispositivos registrados" del copy OTT (mentía); licencias quedan. Divergencia #8 de Gigared documentada en engram.

### #61 — TV: filtro único LIKE ✅ HECHO *(2026-06-12, FE PR #100, en prod)*
> Un input LIKE (nombre/CIC/email, trim, debounce) sobre las cuentas completas vía el hook agregador del #47e; paginación client-side con total real; "Todos" = dual-call dedup. La review cazó la regresión de invalidación (las mutaciones no invalidaban `all-accounts` → page stale 5 min tras vincular) — las 6 mutaciones invalidan ambas keys. Cap 200 documentado + notice.

### #62 — TV: columna de estado ✅ HECHO *(2026-06-12, FE PR #101, en prod)*
> Columna OTT → "Estado" con pill: enabled→Activa, disabled→Suspendida (semántica #47k), null/sin OTT→Sin OTT.

### #63 — Tickets: búsqueda LIKE por nombre ✅ HECHO *(2026-06-12, BE PR #122 — junto al #49, en prod)*
> El search ya era LIKE sobre subject+description; pasó a subject + **customer.name** + sequenceNumber exacto (se dropeó description). Guard int4 falsificable vía helper `sequenceNumberClause` unit-testeado (un CUIT pegado daba 500) — mismo fix aplicado al search de TAREAS (deuda del patrón original saldada). La re-review exigió RED real: verificado revirtiendo.

### #64 — Baja TV: renovar CIC + desvincular + modal ✅ HECHO *(2026-06-12, BE PR #125 + FE PR #110, en prod)*
> Hallazgo de diseño: NO hay dato local que ate Client↔CIC (el vínculo ES el internal_id en el partner) → "como si no tuviera" = renew + `setInternalId(newCic,'')`. Orden: guards → packs → OTT → reconcile → renew → unlink, con **renew SOLO si el desmontaje fue completo** (la review cazó el minteo ilimitado de CICs en el retry) y best-effort 207+retry. FE: modal "La TV se estará deshabilitando en los próximos minutos." en el PADRE (la review cazó el modal fantasma del happy path), status-driven, 404 del retry = "ya se completó". ⚠️ Riesgo documentado: la doc no confirma que el PATCH internal_id acepte '' — si el partner lo rechaza, queda 207 con retry.

### #66 — REWORK del #52: switch Red/FO ✅ HECHO *(2026-06-12, BE PR #127 + FE PR #112, en prod)*
> SDD `network-task-red-fo-switch`. Revierte el rename global del #52 (labels RED restaurados) + tipo NUEVO **Nodo Fibra**: `networkType 'red'|'fibra'` + `networkSiteName` libre (migración 20260708, backfill 'red', dry-run prod OK). Red = flujo anterior (localidad pasó a OPCIONAL); fibra = nombre libre + dirección/localidad obligatorias, híbrido fibra+siteId → 422 (la review lo cazó persistiendo la FK), networkType inmutable post-create. Dispatch fibra: nodeCode=city=localidad. Deudas: normalizar siteId whitespace-only a null en fibra; comentario falso del Update DTO; resend no maneja network (pre-existente del #29).

### #65 — TV: alta determinística + credenciales ✅ HECHO *(2026-06-12, BE PR #126 + FE PR #111, en prod)*
> SDD `tv-register-deterministic`. Email `{apellido}{idGR}@gmail.com` + clave `ip{idGR}` paddeada a 8 (CUA [a-z0-9]; fallback #47h sin grClienteId), prefill editable, checkbox de email SIEMPRE off. Credenciales impactadas en `ContractService.tvLogin/tvPassword` (migración 20260707, fila TV asegurada en alta fresca; el cancel #64 las limpia). Sección "Credenciales Gigared Play": Login `GIGA{abonado}` + clave lazy del endpoint dedicado `GET .../tv-credentials` (tv.register, DOS capas — la password JAMÁS viaja en los DTOs de contratos, la review cazó la exposición) + "Cambiar contraseña" (`PATCH password` confirmado en la doc; cuenta resuelta server-side — la review cazó el cic libre). Deudas: gmail reales posibles (default off mitiga), test cross-repo del generador, tvLogin column no leída.

### #64 — TV: la baja renueva el CIC + borra los datos locales + modal  *(agregado 2026-06-12, mismo batch)*
- Hoy "Dar de baja TV" (#47k) solo quita packs + apaga OTT. Debe ADEMÁS: (1) **renovar el CIC** (`PUT /accounts/{id}/renew` de Gigared — ojo: la doc dice que el internal_id pasa al CIC nuevo, hay que DESVINCULAR localmente para que quede libre), (2) **eliminar los datos de TV locales** del cliente — debe quedar **como si no tuviera TV**, (3) al confirmar, **modal**: "la TV se estará deshabilitando en los próximos minutos" (la API responde async).

---

> Bloque 2026-06-11 (#40–#47, COMPLETO). Orden de ejecución sugerido (por dependencias): **#40 → #41 → #43 → #42 → #44 → #46 → #45 → #47**. SDD automático + hybrid, agent teams, review adversarial post-apply (loop fix→review del WORKFLOW).

### #40 — Page "Tareas Nodos" (gemela de Tareas, solo tareas de nodo) ✅ HECHO *(2026-06-11, BE PR #104 + FE PR #78, en prod)*
> SDD `tareas-nodos-page`. `Project.isNetworkProject` (migración `20260623000000`) + filtro `kind` + guard simétrico create/update (`ProjectKindLookup`, 422 `INVALID_PROJECT_KIND`, dispara por CAMBIO no por presencia) + composition-root test. FE: `TasksPageBase` extraído (paridad verificada), página `/admin/scheduling/nodos`, modal locked en modo nodo, proyectos de red excluidos de los 3 call sites de creación + DatosForm (con pinning "(fuera de tipo)" anti-tarea-ineditable), tab "Proyectos de red" en config. Review: 2 adversariales + fix wave + 2 micro-fixes + 2 re-reviews → CLEAN. Gates: BE 3201/0+tsc, FE 2335/0+typecheck. Post-deploy: "Red - Fibra" y "RED - Wireless" tagueados en prod (TOTAL_FLAGGED=2). Pendiente menor: smoke visual UI (faltan creds admin de prod). Deuda anotada: `IngestGestionRealOrders` crea tareas DIRECTO en el repo (bypassa el guard — pre-existente, inofensivo hoy).
- Page nueva **idéntica a Tareas** pero exclusiva de tareas de nodo (`kind='network'`, del #29): el botón "Añadir" abre DIRECTO el modal de nodos (sin el toggle rojo), y el select de proyecto lista **solo 2 proyectos: "Red - fibra" y "Red Wireless"**.
- Esos 2 proyectos **dejan de aparecer** en el crear-tarea de clientes → **independizar la lógica de proyectos** para ambos casos (candidato: flag en `Project` tipo `isNetworkProject`, patrón del `allowsEquipmentRetirement` del #39 — decidir en el SDD si es flag fijo o mapeo configurable).
- En la **página de Proyectos** las tareas de red siguen apareciendo como hoy (sin cambios), y se comportan IGUAL que las de cliente: `sequenceNumber`/iclass-code **auto-incremental SECUENCIAL al de las tareas de cliente** (misma secuencia compartida, NO una secuencia aparte). La dirección se carga **manual en el nodo** (ya existe en NetworkSite).
- **Relaciones**: #29 (kind + networkSiteId en prod) · NetworkSite/auto-import UISP (los nodos ya viven ahí) · #41 (el filtro de estados generales aplica a esta lista también) · badge "Faltan datos IClass" (FE #76) para nodos incompletos.

### #40b — Follow-ups de Tareas Nodos ✅ HECHO *(2026-06-11, FE PR #79, en prod)*
> (a)+(b)+(c) hechos + yapa del review: el deep-link de Proyectos para proyectos de RED ahora navega a `/admin/scheduling/nodos?projectId=...` (sin eso, con el filtro kind quedaba lista vacía). Gates 2342/0 + typecheck. Review: 1 FIX-FIRST real (deep-link) + 1 falso positivo descartado verificando origin/main.
- **(a)** En el modal de crear tarea de CLIENTES ya no debe aparecer el slide/toggle de "Nodo RED" (#29) — la creación de tareas de nodo vive ahora en la página Tareas Nodos.
- **(b)** En la tabla de Tareas Nodos no debe salir la columna Cliente (es tarea de nodo, no aplica).
- **(c)** Las tareas de nodo NO deben aparecer en la lista de Tareas de clientes (la page de clientes debe filtrar `kind=customer` — hoy no manda kind y se cuelan). En la página de **Proyectos sí coexisten ambas** (sin cambios ahí).

### #41 — Estados GENERALES de tarea [open | closed | dismissed] + filtro ✅ HECHO *(2026-06-11, BE PR #105 + FE PR #80, en prod)*
> SDD `task-general-status`. `generalStatus` fuente de verdad (migración `20260624000000` + backfill idempotente, dry-run prod OK — 218 tareas todas open), `isClosed` facade. `POST /:id/status` (scheduling.write), filtro `?status` (omit≡all) en ambas páginas default Abiertas, acciones Cerrar/Descartar/Reabrir + pill, cierre AUTO por flujo IClass (move a 'hecho' → closed, atado al evento — reopen no se deshace), dismissed fuera de TODOS los loops de cierre (incl. fix del NOT-relación-nullable de Prisma #25226 + choke-point). Review: 2 adversariales + fix waves + re-reviews → CLEAN. Gates BE 3260/0, FE 2369/0. Deuda menor: Calendar muestra todas (incl. descartadas) — revisar si molesta.
- Para tareas de **clientes Y nodos**: 3 estados de gestión de la tarea — `open` (al crearse), `closed`, `dismissed` — **independientes de los stages de workflow** (que quedan como están, esos ya están OK).
- Tarea cerrada/dismissed → **no aparece en la lista a simple vista**. Filtro de 4 opciones: open / closed / dismissed / **todos**; la vista principal SIEMPRE es open.
- **Relaciones**: #40 (aplica a las DOS listas: Tareas y Tareas Nodos) · contrato del list BE↔FE (campo nuevo en DTO + query param) · el cierre IClass ya marca cosas — revisar si `closed` se setea manual, desde el cierre de OS, o ambos (decidir en SDD).

### #42 — Redesign moderno de la tab Contratos del cliente ✅ HECHO *(2026-06-11, FE PR #81, en prod)*
> SDD `contracts-tab-redesign`. Cards impeccable (name??plan editable inline, pill status, dirección "Instalación", chips de servicios con picker/confirm/toggle, equipos ligados — fuera el borderLeft) + tab "Servicios" en settings (clients.manage) + fixes de drift (Contract.id era type-lie number→string; columna IP nunca renderizaba por ip/ipAddress) + removals del CRUD stub que JAMÁS persistió (-790 líneas, ServicesTab muerto). Review CLEAN + 3 warnings corregidos (alert→toast, gating test, msg NON_RENAMEABLE). Gates 2408/0 + typecheck. Deuda: BE no mapea `technology` en toService (pre-existente).

### #43 — Modelado: Cliente → N Contratos (con nombre) → Servicios + equipos instalados ✅ HECHO *(2026-06-11, BE PR #106, en prod — BE-only; la UI es el #42)*
> SDD `contract-services-model`. `Contract.name` manual-only (sync GR jamás lo pisa — data-block pinning; address sigue GR-wins = instalación) + `PATCH /api/contracts/:id {name}` real (stub in-memory deprecated) + `ServiceCatalog` (seed INTERNET/TV/VOZ/CAMARAS/OTROS; OTROS no-borrable ni renombrable) + ABM `/api/service-catalog` + pivot `ContractService` con CRUD (`409` race-safe) + `services[]` eager en listContracts (aditivo). Migraciones 20260625/26/27 (la 27 grantea `clients.manage` a administrador — sin eso el ABM era solo-super_admin). Dry-run prod OK. Review → 2 FIX-FIRST + 3 W corregidos → CLEAN. Gates 3372/0 + tsc.
- El contrato debe poder contener **servicios** (internet, TV, cámaras, etc. — catálogo editable, patrón `DeviceTypeCatalog`/`MaterialCatalog`) además de los **equipos instalados** como hoy (`ContractInstalledItem`).
- Contratos con **nombre** (identificables) bajo el cliente: cliente 1—N contratos → servicios + equipos.
- **Dirección POR CONTRATO** *(agregado 2026-06-11)*: cada contrato lleva su dirección asociada — **GR ya la trae**. Semántica: la dirección del CLIENTE es la de **facturación**; la del CONTRATO es **donde se instaló el servicio**. Mapear desde la ingesta/sync de GR y mostrarla en la UI del #42.
- **Relaciones**: #42 (la UI que lo muestra) · #47 (la integración TV agrega un ítem/servicio TV al contrato — este modelo es su prerequisito) · inventario EPIC #38 (equipos ya cuelgan del contrato).

### #44 — Redesign detalle de ticket + fotos en comentarios ✅ HECHO *(2026-06-11, BE PR #107 + FE PR #82, en prod)*
> SDD `ticket-detail-redesign`. BE: `TicketComment`+`TicketCommentAttachment` persistidos (migración `20260628000000` — mata el `ticketRepliesStore` in-memory que PERDÍA la conversación en cada deploy), imágenes base64 data-URI (container sin volumen), 3×2MB image/* SIN SVG (XSS), parser 8mb path-scoped ANTES del global (+413 limpio), audit middleware elide data-URIs (sin eso ~12MB/comment al AuditEvent), tasks[] en GET /:id. FE: redesign impeccable (header+tabs+sidebar), descripción POR FIN visible (bug: nunca se renderizaba), composer con paste real (items+files — los browsers entregan screenshots por items), lightbox, error+Reintentar, ticket.id number→string. Review: 2 adversariales → 4 HIGH + 3 MEDIUM corregidos → re-review CLEAN. Gates BE 3405/0, FE 2434/0. Dry-run prod OK.

### #45 — Config de nodos: mapper de CIUDADES de IClass ✅ HECHO *(2026-06-11, BE PR #109 + FE PR #84, en prod)*
> SDD `nodes-city-mapper`. **Hallazgo live contra la API real**: IClass NO tiene catálogo de ciudades — los NODOS son las ciudades (36 valores, codigo≡descricao, id como `nodeId` inglés entre campos portugueses; ?city= roto). Tabla `IClassNode` (migración `20260629000000`) + `SyncIClassNodes` (upsert por nodeId, agrupadores IPNEXT INTERNET/Main/Argentina no-seleccionables) + asignación validada vía PUT network-sites {iclassNodeId} que setea código + city JUNTOS (anti-desync: city manual en el mismo body se descarta). FE: select del catálogo en Mapeo de nodos + botón Sincronizar + estados "(inactivo en IClass)"/"(sin validar)". Review: 1 CRITICAL falso positivo descartado con evidencia live + H1/M1/M2 corregidos → CLEAN. Gates BE 3459/0, FE 2482/0. Dry-run prod OK. **Post-deploy pendiente: apretar "Sincronizar desde IClass" y mapear los nodos.**

### #46 — Redesign `/admin/tickets/opened`: bulk actions + filtros ocultos ✅ HECHO *(2026-06-11, BE PR #108 + FE PR #83, en prod)*
> SDD `tickets-list-redesign`. FE: selección múltiple + BulkActionBar (Asignar/Cambiar estado/Cerrar/Eliminar, Can write/write/close/delete, mapWithConcurrency(5), fallo parcial deja SOLO los fallidos seleccionados — DataTable ganó prop controlada backward-compatible) + filtros colapsables (badge count, chips siempre visibles). BE: **muere la whitelist VALID_STATUSES** (lección #27 — prod funcionaba DE CASUALIDAD con el catálogo en inglés): PATCH /:id/status valida contra el catálogo (case-insensitive, name canónico), GET ?status= pass-through real, CloseTicket catalog-aware (antes 500 si renombraban 'closed'). Review: 2 HIGH + 2 MEDIUM corregidos → CLEAN. Gates BE 3417/0, FE 2473/0. Deuda menor: composition-guard test del wiring #46 (sugerencia).

### Batch de deudas de los reviews 2026-06-11 ✅ HECHO *(BE PR #110, en prod — no es ítem numerado)*
> 5 deudas saldadas el mismo día: guard de kind en GR ingest (#40) · `technology` en toService (#42) · rename-guard de OTROS en UpdateDeviceType (#43) · composition-guard test #46 · e2e dual-parser #44. Gates 3476/0 + tsc. Review CLEAN. Deuda restante menor: doble `projects.get` por orden en el ingest (perf, trivial) · Calendar muestra dismissed (#41, decisión de producto).

### #47b — TV: flujo desde el contrato + page en Clientes ✅ HECHO *(2026-06-11, FE PR #87, en prod)*
- (a) La page de TV se muda de "Clientes potenciales" a la sección **Clientes** del sidebar (ruta → `/admin/customers/tv`).
- (b) **El punto de entrada de la activación es el CONTRATO**: elegir "TV" en el picker de servicios de la card (#42) abre el flujo Gigared (vincular CIC / registrar → elegir pack; el ítem local lo crea el reconcile del BE); el chip TV abre el mismo panel en modo gestión (packs/OTT/quitar). Sin Gigared configurado → ítem local plano con aviso.
- (c) La tab TV del cliente se ELIMINA (un solo lugar de gestión).

### #47j — TV: OTT sincronizado + pack base + links + cupos legibles ✅ HECHO *(2026-06-12, BE PR #116 + FE PR #95, en prod)*
> Gigared manda el estado OTT en ESPAÑOL (habilitado/deshabilitado — 7ma divergencia con su doc): el toggle siempre se veía apagado y re-habilitar daba "ya se encuentra habilitada". Adapter normaliza a enabled/disabled/null + toggle idempotente. FE: "Gigared Play Full" marcado **Pack base** sin Quitar · nombres de /admin/customers/tv como link al cliente vinculado · cards "En uso X de Y · sin cupo".

### #47k — TV: Suspender/Reactivar + Dar de baja ✅ HECHO *(2026-06-12, BE PR #117 + FE PR #96, en prod)*
> Diseño aprobado: ① Suspender TV = OTT off (reversible, packs+cupo se conservan, badge/chip ámbar SUSPENDIDA); ② Dar de baja TV = quita TODOS los packs (libera cupo) + OTT off + ítem local inactivo (reconcile con re-fetch real — solo inactiva si la cuenta quedó vacía); 207 parcial con retry idempotente. **HIGH del review**: ownership del contractId validado en los 4 use cases (antes un contractId ajeno reconciliaba el contrato de OTRO cliente). Gates BE 3669/0, FE 2656/0.

### #47i — TV: UX del panel vinculado (3 feedbacks de uso real) ✅ HECHO *(2026-06-12, FE PR #94, en prod)*
> (1) "Agregar servicio" excluye los packs que la cuenta YA tiene; todos → control oculto + hint. (2) OTT en humano: "Streaming (OTT) — la app de TV de Gigared" + "Puede ver en hasta N pantallas fijas y N móviles · N dispositivos registrados". (3) Sección "Ítem local" ELIMINADA en cuentas vinculadas (todo va por Gigared; el reconcile baja el ítem solo) — queda solo en no-vinculadas.

### #47h — TV: password compliant + campo Contraseña + checkbox activación ✅ HECHO *(2026-06-11, BE PR #115 + FE PR #92→, en prod)*
> Causa raíz del registro fallido (visible gracias al #47g): el generador usaba base64url (mayúsculas/guiones) y el CUA exige `a-z0-9`. Generador nuevo crypto.randomInt `[a-z0-9]{12}` (policy pineada con 1000 generaciones) + `password?` opcional del operador (400 claro si no cumple, sin tocar Gigared) + campo Contraseña en el form (mostrar/ocultar, validación viva) + checkbox "Enviar email de activación" — **form 1:1 con el doc** (los 6 campos del register cubiertos, chequeado a pedido del usuario).

### #47g — TV: pager real + modal de vincular + errores con motivo ✅ HECHO *(2026-06-11, BE PR #114 + FE PR #92, en prod)*
> Bugs de uso real: (1) pager incoherente → totalPages real desde el summary por status (fallback heurístico con filtros de texto); (2) el picker de vincular pasó a MODAL impeccable (búsqueda autofocus, filas nombre+CIC+packs, selección con resumen y Cambiar); (3) errores mudos → `detail` RFC 9457 del partner en TODOS los errores (502/503 incl.) + log `[gigared] upstream` para diagnóstico; (4) **5to bug de la API**: lista filtrada sin resultados devuelve 404 `empty-accounts_list` (no lista vacía) — mapeado a `[]`. El register fallido del usuario fue transitorio del CUA — con el detail visible, el próximo retry muestra el motivo real.

### #47f — TV: vincular crea el chip TV del contrato ✅ HECHO *(2026-06-11, BE PR #113 + FE PR #91, en prod)*
> Gap cazado ANTES de la vinculación masiva: el link seteaba internal_id pero el reconcile solo corría en add/remove de packs → vincular las 84 cuentas con packs YA activos dejaba los contratos sin chip. Ahora `POST .../link {cic, contractId?}` reconcilia el ContractService TV (404 de contrato ANTES de tocar Gigared; 207 local:'failed' con retry idempotente); el FE manda el contractId del dueño + amber 207 + la invalidación de client-contracts que faltaba. Gates BE 3614/0, FE 2591/0.

### #47e — TV: picker de CICs disponibles + registro prefilleado ✅ HECHO *(2026-06-11, FE PR #90, en prod)*
> Pedidos del usuario: (1) Vincular elige el CIC de un picker buscable (cuentas registradas sin vincular, label nombre+CIC+packs, placeholder anti-mismatch, fallback manual; hook paginado de a 20 en un solo queryFn, solo se dispara al abrir el panel). (2) Registrar se precarga con nombre/apellido/email del cliente (split "APELLIDO NOMBRE(S)", tolera coma) y el CIC sale de las cuentas SIN registrar (Gigared exige CIC libre). Review CLEAN + 2 cosméticos aplicados. Gates 2586/0.

### #47e-bis — Calendario oculta descartadas ✅ HECHO *(2026-06-11, FE PR #89 — deuda #41 cerrada con default "descartada=fuera de la vista"; cerradas se mantienen)*

### #47d — TV: mapeo de errores REALES de Gigared ✅ HECHO *(2026-06-11, BE PR #112, en prod)*
> Bug del usuario con la key real: el panel TV daba error genérico para no-vinculados. La API REAL difiere de su doc: internal_id desconocido → 424 external-service-error (no 404); CIC ajeno → 403 cic-ownership-error (no 404). `mapError` discrimina por el `type` RFC 9457 → ambos a NotFound; fixtures reales pineados. Lección: toda integración nueva necesita pasada de unhappy-paths contra la API real ANTES del primer uso (van 3 mentiras de la doc: status codes, cap de paginación 20, ?city= roto de IClass).

### #47c — TV: paginación rota + quitar ítem local + reporte de matches ✅ HECHO *(2026-06-11, FE PR #88, en prod)*
> (1) La API de Gigared capea `pagination_limit` en 20 (verificado live, la doc no lo decía) — la page pedía 25 → 400 siempre; fix PAGE_SIZE=20. (2) Sección "Ítem local" en el GigaredPanel: quitar el ítem TV del contrato (confirm, remove del #43, gate clients.write) + alta del ítem local sin Gigared en estado no-vinculado. (3) **`TV-MATCHES.md`** en la raíz del BE: barrido completo de las 84 cuentas registradas en Gigared cruzado contra clientes activos — 66 matches directos (1 contrato), 14 multi-contrato, 4 sin match. El usuario eligió vincular A MANO desde el panel (no bulk). ⚠️ Gigared Play Full 102/102 = cupo lleno.

### #47 — Integración TV **Gigared Partners** ✅ HECHO *(2026-06-11, BE PR #111 + FE PR #86, en prod — INERTE hasta cargar la API key)*
> SDD `tv-gigared-integration`. API: partners.gigaredsa.com.ar (doc formateada en `tv.md`). BE: GigaredClient (X-API-Key por-request desde config DB, retry-429, RFC 9457→errores tipados), GigaredConfig singleton (key enmascarada — GET solo last4; **el audit middleware ahora enmascara `apikey`**, sin eso quedaba EN CLARO en AuditEvent), módulo RBAC `tv` + grants (migración `20260630000000`), flag `gigared-integration` OFF, 10 use cases (link CIC con guards 404/409, register+activate, add/remove servicio con **reconcile del ítem TV local** del #43 — ownership por notes-prefix, inactiva en vez de borrar, 207 retry-idempotente, OTT). FE: page `/admin/crm/tv` + tab TV en el cliente (3 estados) + config con **Probar conexión** (funciona con flag OFF — onboarding: pegar key → probar → activar). Review: 2 CRITICAL BE (key en audit, guard falso-hecho) + 3 CRITICAL FE (drift spec/design) corregidos → CLEAN. Gates BE 3597/0, FE 2534/0. Dry-run prod OK.
> **Post-deploy (usuario)**: pegar la API key en Configuración de clientes → tab "Gigared TV" → Probar conexión → prender el toggle. Listo.

---

### #39 — Retiro manual desde la tarea, gateado por "proyectos de retiro" ✅ HECHO *(agregado y SHIPPEADO 2026-06-10, BE PR #100 + FE PR #72)*

> Complementa el retiro AUTOMÁTICO de la W4 (cierre IClass con result-code `isRemovalCode` → Devoluciones pendientes). Este es el camino **MANUAL del operador desde la tarea**, habilitado solo en proyectos mapeados.

- **Mapeo de proyectos de retiro (config)**: page/tab nueva en Configuración — "Proyectos de retiro": se mapean N proyectos de Prominense. **Solo las tareas de esos proyectos muestran el botón "Retirar"** en su panel de inventario. Gate del mapeo: `inventory.manage` (o `scheduling.manage` — decidir en el SDD). Dos capas como siempre.
- **Botón "Retirar" en la tarea**: toma el equipo asociado al **cliente/contrato actual** de la tarea (si existe); **sin equipo asociado → no-op amable** (no pasa nada, sin error).
- **Quitado SOFT del cliente**: la `ContractInstalledItem` NO se borra — queda como historial (`status='removed'`, patrón soft-delete del #8). "Ya no es el real": si un día el equipo se instala de nuevo (en otro cliente), **el real pasa a ser el cliente nuevo** — el asset se mueve, el historial de dónde estuvo queda íntegro en el ledger.
- **Efectos de inventario (ledger, ya cableados por el EPIC #38)**:
  - **Retirar** → movimiento `RETURN` al depósito: el equipo queda `available@DEPOSITO` (depósito **+1**), visible en la W3.
  - **Instalar** → ya descuenta del depósito desde el fix del 2026-06-10 (match normalizado: el asset se MUEVE depósito→cliente, depósito **−1**).
- **Permisos del botón**: `inventory.write` (dos capas).
- **Decisiones cerradas (usuario, 2026-06-10)**: (a) **Retiro POR ÍTEM con PICKER**: un contrato con N equipos abre un picker listando los activos — se retira el/los seleccionados, NUNCA todo-o-nada (hay retiros parciales). (b) **Aplicación DIRECTA** con confirm-dialog (sin encolar en Devoluciones pendientes — el operador YA está decidiendo al apretar el botón), registrando `source='MANUAL'` en el movimiento RETURN.
- **Sub-ítem (gap de configurabilidad W4)**: toggle **"Es retiro de equipo"** por fila en la sub-tab "Mapeo de resultados" del Cierre de OS — hoy `IClassResultCode.isRemovalCode` solo se edita por SQL (cero referencias en el FE); un código de retiro nuevo de IClass requiere migración a mano. BE expone el campo en el PUT del mapping + FE el switch (gate `iclass.manage`).

---

## 🏗️ EPIC #38 — Sistema de Inventario completo (equipos + materiales, multi-ubicación, descuento desde tareas)  *(agregado 2026-06-08)*

> **Big epic, múltiples SDDs (waves).** Visión del usuario: llevar control real del inventario — equipos por cliente, equipos nuestros (depósito), devolución de equipos en los retiros, consumo de materiales (POEs, conectores, etc.), inventario por técnico/camioneta, y **descuento automático/semi-automático desde las tareas y los equipos técnicos**. Front a elección, **siempre impeccable**. Todo con foreign keys.

### Concepto central (investigado + alineado al código)
El patrón estándar de field-service inventory (ver Fuentes) conecta **depósito + camionetas + sitios de trabajo** en un solo sistema con un **ledger de movimientos en vivo**: cada *issue / transfer / install / return / consume / adjust* queda atado a una **work order (tarea) + técnico + ubicación** — "una sola fuente de verdad de qué se usó, dónde y por qué". Cuatro tipos de stock: **truck stock (camioneta), warehouse (depósito), serialized equipment (equipos por SN), job-specific (reservado a una tarea)**.

**La pieza que FALTA hoy** es justamente esa: **ubicaciones de stock + ledger de movimientos**. El resto ya existe parcial.

### Lo que YA existe (reutilizar, NO reinventar)
- **Equipos serializados**: `InventoryProduct` (catálogo) + `InventoryUnit` (unidad física con `serialNumber`/`barcode`/`status` available|assigned|damaged|retired/`location` string/`assignedToClientId`). 6 páginas FE de inventario ya hechas (`/inventory/*`).
- **Equipos x cliente**: `ContractInstalledItem` (roster de equipos instalados por contrato, `status` active|removed|replaced, `source` OCR|MANUAL|ICLASS).
- **Materiales**: `MaterialCatalog` (catálogo UPPERCASE) + `TaskMaterialConsumption` (consumo por tarea, FK a tarea+usuario) + `IClassSoMaterial` (líneas de material de la OS).
- **Eventos de equipos de IClass**: `IClassSoEquipmentEvent` (install|remove|move, serialNumber/mac/patrimonio/modelo) — **se capturan en el closure pero NO se consumen** (`IClassClient.getServiceOrderEquipmentEvents`, fetched en `IngestClosedServiceOrders.ts:202`).
- **Staging**: `TaskInventorySuggestion` (pending→confirmed→discarded) + flujo confirm/discard/replace (add|link_existing|replace) ya battle-tested (#19).
- **Técnico**: `RbacUser` (= técnico vía `ScheduledTask.assigneeId`).

### ⚠️ Decisión arquitectónica clave (resolver en wave 1)
Hoy conviven **DOS mundos de inventario** en paralelo: (a) genérico `InventoryItem`/`InventoryProduct`/`InventoryUnit`, y (b) específico de tareas/contratos `ContractInstalledItem`/`TaskMaterialConsumption`. El epic DEBE decidir cómo **unificarlos** (o cuál es la fuente de verdad) antes de construir encima. Es el mayor riesgo de diseño.

### Modelo de dominio propuesto (a refinar en SDD)
- **`StockLocation`** (NUEVO): tipos `DEPOSITO` | `CLIENTE` | `TECNICO` | `CAMIONETA`. FK polimórfica/tipada: TECNICO→`RbacUser`, CLIENTE→`Contract`/`Client`, CAMIONETA→`Vehicle` (nuevo). Todo lo que tiene stock apunta a una location.
- **`InventoryUnit.currentLocationId`** (NUEVO FK): la unidad serializada se mueve depósito→técnico/camioneta→cliente (install)→depósito (retiro).
- **`MaterialStock`** (NUEVO): `(materialCatalogId, locationId, qty)` — cantidad de un consumible por ubicación.
- **`InventoryMovement`** (NUEVO, el ledger): `type` (ISSUE|TRANSFER|INSTALL|RETURN|CONSUME|ADJUST), `unitId?`/`materialCatalogId?`, `fromLocationId?`, `toLocationId?`, `qty`, `taskId?` (FK), `technicianId?` (FK), `source` (manual|iclass|ocr), `occurredAt`. El stock actual se deriva del ledger (o se materializa en `MaterialStock`/`InventoryUnit.location`).
- **`Vehicle`/`Camioneta`** (NUEVO): para el truck stock. (v1 podría usar técnico-como-location y diferir camioneta.)

### Waves (cada una = su propio SDD: explore→propose→spec∥design→tasks→apply→verify→deploy→archive)

- **Wave 1 — Fundación ✅ HECHO (en prod, 2026-06-09, BE PR #85)**: Strategy 3 (núcleo unificado; World A vacío en prod → deprecado). `StockLocation` (DEPOSITO|CLIENTE|TECNICO) + `InventoryAsset` (serializado) + `MaterialStock` (Decimal(12,4) + CHECK qty>=0) + `InventoryMovement` (ledger) + `RecordInventoryMovement` (movimiento+balance atómico, TOCTOU-free) + `UnitOfWork` transaccional (dual-write del #19 atómico). Migración: 56 `ContractInstalledItem` → 56 `InventoryAsset` (installed) + 56 INSTALL movements + 41 ubicaciones CLIENTE + DEPOSITO (56/56 sin huérfanos, confirmado en prod). CII gana `assetId` (aditivo, FE intacto). Revisión: review inicial (CRÍTICOS de integridad) → 5 olas de fix → 3 análisis adversariales opus hasta IMPECABLE. Suite 2730/0. Archivado en `openspec/changes/archive/2026-06-09-inventory-foundation/`.
- **Wave 2 — Equipos x cliente ✅ HECHO (en prod, 2026-06-09, BE PR #86 + FE PR #58)**: vista agregada cross-contrato. BE `GET /api/clients/:clientId/equipment` (perm `inventory.read`, DTO `ClientInstalledItemDto` con contractPlan/contractType) sobre `listByClient` (un JOIN). FE tab "Equipos" en `CustomerDetailPage` agrupado por contrato, badges de estado, impeccable. Read-only, sin migración. Suite BE 2735/0, FE 2016/0. Archivado.
- **Wave 3 — Inventario nuestro (depósito) ✅ HECHO (en prod, 2026-06-09, BE PR #87 + FE PR #59)**: BE `GET /api/inventory/depot` (perm `inventory.read`) → equipos `available` en DEPOSITO + stock de consumibles, enriquecidos con DeviceTypeCatalog + MaterialCatalog. `listByLocation` genérico (filtro en use case → reuso W7). `GetDepotStock` resuelve DEPOSITO por `findByCode` (sin crear en GET). FE página nueva `InventoryDepotPage` (`/admin/inventory/depot`) con empty-states contextuales. Read-only, sin migración. Suite BE 2743/0, FE 2025/0. (Depósito vacío hoy → se puebla con W4.) Archivado.
- **Wave 4 — Retiros → devolución al depósito ✅ HECHO (en prod, 2026-06-09, BE PR #88 + FE PR #60)**. **Premisa pivoteada**: IClass devuelve 204 en TODOS los endpoints de equipos (IPNEXT no usa ese módulo) → no hay eventos que consumir. Re-scopeado a **retiro detectado desde el cierre**. STAGE (auto, read-only, **feature flag `iclass-inventory-returns` OFF por default**): OS cierra con result-code de retiro completado (`isRemovalCode`+Sucesso: "Retiro completo Servicio Fibra/Wireless") → matchea serial OCR con asset `installed` (normalizado) → encola `ReturnSuggestion`. CONFIRM (operador, semi-auto, único punto de mutación): → `RecordInventoryMovement(RETURN→DEPÓSITO)` atómico → equipo `available` en depósito (visible en la W3). No-match → crear/vincular/descartar. **Idempotencia 2 capas** (L1 flag por-SO + L2 sourceRef índice parcial). Review: 4 análisis opus → 2 graves corregidos (guard installed, L2 concurrente) → CLEAN. Suite 2793/0, dry-run prod limpio. **Para activar: prender el flag.** FE: página "Devoluciones pendientes" (link picker = follow-up). Archivado.
- **Wave 5a — Inventario x técnico ✅ HECHO (en prod, 2026-06-09, BE PR #89 + FE PR #61)**: TECNICO ya estaba de la W1 (sin migración). `ResolveTechnicianLocation` (find-or-create + P2002), `IssueStockToTechnician` (asigna stock depósito→técnico vía **TRANSFER** —NO ISSUE—, multi-item en UnitOfWork atómico, guard asset-at-depot), `GetTechnicianStock` (clon de GetDepotStock). Rutas `GET /technicians/:id/stock` + `POST /technicians/:id/issue`. FE: página `/admin/inventory/technicians/:id` + modal "Asignar stock". Review opus focalizado: CLEAN. Suite 2814/0. Archivado.
- **Wave 5b — Camioneta (Vehicle model) ✅ HECHO (en prod, 2026-06-09, BE PR #91 + FE PR #63)**: catálogo `Vehicle` (plate UNIQUE, name?, assignedTechnicianId? informativo, status active|inactive) + tipo de StockLocation **CAMIONETA** (`vehicleId` FK + `@@unique([type, vehicleId])`) + `ResolveVehicleLocation` (find-or-create + P2002 retry) + `GetVehicleStock` + `IssueStockToVehicle` (TRANSFER depósito→camioneta multi-item UoW atómico, guards asset-at-depot + **vehículo activo** 422). CRUD `/api/vehicles` (read/manage; DELETE guardeado `VEHICLE_IN_USE`; race P2002 plate → 409 `VEHICLE_PLATE_CONFLICT`). FE: tab "Camionetas" en settings (ABM + "Ver stock"), página `/admin/inventory/vehicles/:id`, modal sibling (técnicos intacto), sidebar. Migración `20260614000000` aditiva, dry-run prod rolled-back OK. **Sin flag** (read-only hasta asignar stock). Review opus → 2 FIX-FIRST (tests de ruta stock/issue + mapeo P2002) → CLEAN. Suite BE 2882/0, FE 2122/0. Archivado en `openspec/changes/archive/2026-06-09-inventory-vehicle-stock/`.
- **Wave 6 — Descuento de materiales desde tareas ✅ HECHO (en prod, 2026-06-09, BE PR #90 + FE PR #62)**: cierra el gap "consumo no descuenta stock". **Semi-auto** (decisión del usuario): STAGE flag-gated (**`inventory-material-auto-deduct` OFF por default**) desde AMBOS canales de consumo (`RecordMaterialConsumption` + `ConfirmInventorySuggestion.handleMaterial`, hook compartido `StageMaterialDeduction` best-effort) → `MaterialDeductionSuggestion` `pending` (stock TECNICO suficiente) o `needs_review` (sin assignee / sin stock). CONFIRM (`ConfirmMaterialDeduction`, única mutación, UoW atómico con slot `stock` tx-scoped nuevo): 4 defensas W4 (guard terminal, pre-write `findBySourceRef`, TOCTOU re-check en la tx, sourceRef `consume:task-material:{id}` sobre el índice parcial W4) + `updateStatus` guardeado por status (races → 409). Resoluciones `needs_review`: `issue-first` (TRANSFER+CONSUME una tx) / `depot` / `discard`. FE: página "Descuentos pendientes" espejo de W4. Migración `20260613000000` aditiva, dry-run prod rolled-back OK. **Review 4 opus → 9 FIX-FIRST corregidos (staging no cableado en app.ts, drift contrato BE↔FE del list, TOCTOU no-tx, qty sin roundQty, etc.) → re-review CLEAN.** Suite BE 2851/0, FE 2083/0. **Para activar: prender el flag.** Archivado en `openspec/changes/archive/2026-06-09-inventory-material-deduction/`.
- **Wave 7 — Dashboard unificado ✅ HECHO (en prod, 2026-06-09, BE PR #92 + FE PR #64) — CIERRA EL EPIC**: página Dashboard reescrita (misma ruta) con 3 tabs — **Ubicaciones** (`GET /api/inventory/overview/locations`, agregación en una query, labels resueltos, CLIENTE colapsado en summary row), **Movimientos** (`GET /api/inventory/movements`, ledger filtrable type/location/material/task/técnico/fechas + offset; fechas `YYYY-MM-DD` normalizadas server-side), **Alertas** (`GET /api/inventory/alerts`, SUM global < `minStock`, badge en el tab). `MaterialCatalog.minStock` (default 0) editable en el ABM. **Retiro World A**: 12 use cases BE + 4 páginas FE + sidebar fuera; las tablas quedan (sin DROP, decisión W1). Migración `20260615000000` aditiva, dry-run prod OK. Review 2 opus → 4 fixes (filtro de fechas muerto end-to-end, drift de índice DESC, labels null en ledger, assetCount excluía installed) → re-review CLEAN. Suite BE 2911/0, FE 2108/0. Archivado en `openspec/changes/archive/2026-06-09-inventory-dashboard/`.

### 🏁 EPIC #38 COMPLETO — 7/7 waves en prod (2026-06-09)
Sistema de inventario field-service completo en un día: fundación + ledger (W1) → equipos x cliente (W2) → depósito (W3) → retiros→depósito (W4, flag OFF) → técnicos (W5a) → camionetas (W5b) → descuento de materiales (W6, flag OFF) → dashboard unificado + retiro World A (W7). **Flags dormidos para activar cuando se decida**: `iclass-inventory-returns` (W4) y `inventory-material-auto-deduct` (W6). El loop fix→review que cazó FIX-FIRST en TODAS las waves quedó documentado en [`WORKFLOW-MULTI-REPO.md`](./WORKFLOW-MULTI-REPO.md) como caso de práctica.

### Cross-cutting / a tener en cuenta
- **Serializado vs consumible**: equipos (SN único, ledger por unidad) vs materiales (cantidad por ubicación). Tratarlos distinto.
- **IClass tiene** `/equipments`, `/materials`, `/equipments/move`, `/materials/move` (skill `iclass-ipnext`): podríamos espejar o empujar movimientos — decidir si v1 es solo-lectura (consumir eventos) o bidireccional.
- **Auto vs semi-auto**: el usuario quiere ambos modos configurables (como los flags del cierre). El semi-auto reusa el patrón confirm/discard del #19.
- **Foreign keys en todo**: cada movimiento atado a tarea/técnico/ubicación/unidad.

### Fuentes (investigación de patrones)
- [Field Service Inventory Management: 2026 Guide — FieldPulse](https://www.fieldpulse.com/resources/blog/field-service-inventory-management)
- [Field Service Inventory Management Playbook — BuildOps](https://buildops.com/resources/field-service-inventory-management)
- [Real-Time Multi-Location Stock Control For Field Teams](https://small-business-inventory-management.com/inventory-asset-tracking-for-industries/field-inventory-management-software.htm)

> **Próximo paso**: arrancar **Wave 1** (la fundación + la decisión de unificación) con `/sdd-new inventory-foundation`. Cada wave es un SDD independiente; el orden importa (1 antes que todo; 4 y 6 dependen de 1).

---

### #37 — Loguear fallos del reconcile + badge de cantidad en la página  *(HECHO 2026-06-08)*
- **Disparador**: investigando la discrepancia del #36 (4 OS cerradas pero clavadas = las `failed=6` del reconcile), descubrimos que el `catch` de `reconcileOne` **tragaba el error entero** (`catch {` sin capturar `err`) — cada fallo requería arqueología manual (IClass + DB).
- **Resuelto** (SDD `reconcile-observability`, multi-repo): BE — el `catch` bindea el error y loguea `[backfill] task <sequenceNumber> FAILED: <message>` antes de contar `failed` (cubre batch y 1x1). FE — pill sutil `{n} en Registrado en IClass` en la página de Reconciliar, desde `items.length` (no driftea), oculto en vacío. impeccable.
- **PR**: BE #84 + FE #57. Sin migración. Verify SDD: 6/6 (BE 2578, FE 2004). Archivado en `openspec/changes/archive/2026-06-08-reconcile-observability/`.

### #36 — Normalizar match de result-code (motivoFechamento con punto)  *(HECHO 2026-06-08)*
- **Disparador**: 45 tareas clavadas en "Registrado en IClass". Verificado en vivo (IClass real + DB prod): de las 12 más viejas, **8 estaban `Concluida`** en IClass sin transicionar; 4 legítimamente abiertas.
- **Causa (bug de IClass)**: cerraron con `motivoFechamento = "Cliente Ausente."` (con punto), pero el catálogo de IClass devuelve `codigo = "Cliente Ausente"` (sin punto). El match en `resolveResultCode` era exacto → `rc=null` → se espejaba pero `moved=0`. El adapter ya toleraba case + whitespace externo; el gap era la puntuación final. Hipótesis previas (ventana 29d / OS abiertas) descartadas por la verificación.
- **Resuelto** (SDD `result-code-match-normalize`, BE-only): helper puro `normalizeResultCode` (trim → lowercase → strip puntuación final → collapse whitespace, conservador) + finders normalizados en el port y ambos adapters. `resolveResultCode`: exact-match primero + normalizado como fallback, preservando soTypeId. **Sin migración ni reset** — el path idempotente (`IngestClosedServiceOrders.ts:187-196`) re-evalúa el stage cada corrida → las clavadas se mueven solas.
- **PR**: BE #83. Sin migración. Verify SDD: PASS 10/10 (suite 2576). Archivado en `openspec/changes/archive/2026-06-08-result-code-match-normalize/`.

### #35 — Reset de auditAttempts + página de Reconciliar 1x1/batch  *(HECHO 2026-06-08)*
- **Disparador**: tras el #34 (map-reduce), el reprocess NO rescataba las OS que degeneraban — ya habían **quemado sus 3 `auditAttempts`** pre-#34 → `listPendingSideEffects` las excluye → el #34 nunca corría. Y el "Reconciliar" era todo-o-nada.
- **Parte 1 (BE PR #81)**: migración data-only `20260610000000_reset_burned_audit_attempts` — `UPDATE IClassServiceOrder SET auditAttempts=0 WHERE auditDone=false AND auditAttempts>=3` (mirror del #20). Idempotente, sin schema. Re-incluye las rendidas → el reprocess + #34 las rescata. **Aplicó en prod.**
- **Parte 2 (BE PR #82 + FE PR #56)**: capability `iclass-closure-reconcile`. BE: `reconcileOne` extraído de `BackfillClosedServiceOrders` (batch byte-idéntico) + `ReconcileTaskClosure(taskId)` síncrono 200 + `ListInFlightTasks`→DTO + rutas `GET /closure/in-flight` y `POST /closure/reconcile/:taskId`. FE: página `/admin/scheduling/iclass/closure/reconcile` con lista de in-flight, botón 1x1 por fila + "Reconciliar todas" (batch), refresca tras reconciliar. impeccable.
- **Verify SDD**: PASS 15/15 (BE suite 2553, FE 2002). Archivado en `openspec/changes/archive/2026-06-08-reconcile-page-and-audit-reset/`.

### #34 — Auditor IA: map-reduce ante degeneración del modelo  *(HECHO 2026-06-08)*
- **Disparador**: con el reprocess drenando, algunas OS multi-foto degeneran (`qwen2.5vl:7b` devuelve `<|im_start|>` en loop en vez de JSON → soft-fail → no persiste → reintenta con las mismas fotos → degenera igual). Visto en prod (OS 4564).
- **Pivot de enfoque (feedback del usuario)**: la primera idea (escalera que tira fotos 8→3→0) se descartó —las fotos SON contexto—; el usuario pidió usar las 8 **1x1**.
- **Resuelto** (SDD `audit-degeneration-retry`, BE-only): **map-reduce**. Attempt 1 = una llamada con las 8 fotos (rápido, anda para la mayoría); si degenera → MAP (cada foto 1x1 → descripción en texto, sin schema) + REDUCE (una llamada solo-texto con el contexto + las 8 descripciones → hallazgos con schema). **Ninguna foto se pierde**, el modelo nunca ve el prompt gigante. Fotos descargadas una vez y reusadas. Gateado por `mapReduceOnDegeneration` (default ON), fallback solo en degeneración.
- **PR**: BE #80. Sin migración. Verify SDD: PASS 11/11 (suite 2537). Archivado en `openspec/changes/archive/2026-06-08-audit-degeneration-retry/`.

### #33 — Backfill resiliente al rate-limit de IClass (HTTP 429)  *(HECHO 2026-06-08)*
- **Disparador**: tras el #32 (backfill async), "Reconciliar" no hacía nada. Diagnóstico vía logs del VPS: `[backfill-scheduler] ERROR: IClass responded with HTTP 429` — el backfill rafagueaba ~78 llamadas a IClass sin pausa → 429 → un solo 429 abortaba todo el batch.
- **Resuelto** (SDD `iclass-rate-limit-backfill`, BE-only): `IClassClient` reintenta el **HTTP 429** en `withAuthRetry` (`Retry-After`/backoff, acotado a `MAX_RATE_LIMIT_RETRIES=4`) — **protege TODAS las llamadas a IClass**; el 401 sigue solo en attempt 0 y el path 200-texto "Espere um pouco" intacto. `BackfillClosedServiceOrders` con try/catch por tarea (contador `failed` top-level, distinto del `errored` por-SO) + throttle (350ms) entre tareas. Mantiene el modelo 1x1 async del #32. `failed` llega al status + el log del scheduler.
- **PR**: BE #79. Sin migración. Verify SDD: PASS 11/11 (suite 2523). Archivado en `openspec/changes/archive/2026-06-08-iclass-rate-limit-backfill/`.

### #32 — Backfill async + TODA acción al LLM async + página independiente de pendientes  *(HECHO 2026-06-08)*
- **Disparador**: "No se pudo reconciliar" en prod. Diagnóstico vía logs del VPS (cero errores en 3h → timeout, no crash): `BackfillClosedServiceOrders` hacía ~78 llamadas IClass secuenciales + OCR/audit por OS, **síncrono dentro del request** → timeout. Mismo patrón del #23, pero el backfill nunca se había hecho async.
- **Resuelto** (SDD `closure-actions-async`, multi-repo, apply BE∥FE en paralelo): nuevo `BackfillScheduler` (espeja `TaskAutocompleteScheduler`: `inFlight` + `PgAdvisoryLock('iclass-closure-backfill')` + `triggerNow()` fire-and-forget, **sin cron**); la ruta devuelve **202**/503 y no bloquea. **Auditoría del scope**: el backfill era el ÚNICO entry point HTTP sync que tocaba el LLM/loop IClass — el reprocess ya era async (#23), el resto es rápido → con esto **ninguna acción de cierre bloquea el request**. FE: el contador pasó a `Link` → **`ClosurePendingPage`** standalone (gate `iclass.manage`) a donde se mudó la `ClosureProgressTable` del #31; banner del Reconciliar "encolada"/"en curso"/"no disponible". Front con **impeccable**.
- **PRs**: BE #78 / FE #54. Sin migración. Verify SDD: PASS 14/14 (suite BE 2509, FE closure 40/40). Archivado en `openspec/changes/archive/2026-06-08-closure-actions-async/`.
> Reglas de trabajo en [`WORKFLOW-MULTI-REPO.md`](./WORKFLOW-MULTI-REPO.md). Estado vivo también en engram (`sdd/*`).

---

## ✅ Hechos (27, desplegados en producción)

### #19 — Agregar ítem de inventario MANUAL a la tarea
- **Resuelto** (SDD `task-manual-inventory-item`, automático + hybrid, multi-repo con apply BE∥FE en paralelo): nuevo use case `CreateManualSuggestion` + `POST /scheduling/:taskId/inventory/suggestions` (guard `inventory.write`) — DEVICE con tipo del catálogo + SN/MAC, o MATERIAL con descripción; `source='MANUAL'` entra al pipeline confirm/discard normal. Validación #18 extraída a `domain/services/suggestionCompleteness.ts` (compartida con el confirm). FE: `ManualSuggestionForm` inline + botón "Agregar ítem" **siempre visible** (el early-return del panel vacío era justo lo que dejaba sin salida a la OS sin foto de MAC).
- **2 bugs latentes arreglados** (los encontró la exploración): (a) el confirm etiquetaba todo lo no-OCR como `'ICLASS'` en el contrato (en `execute()` Y `replace()`) — ahora el source pasa through; (b) la clave natural del upsert de ingest era ciega al source → una sugerencia MANUAL pisaba la fila OCR del mismo SN/MAC; la clave ahora incluye `source` en ambos adapters.
- **PRs**: BE #73 / FE #49. Sin migración. Verify SDD: PASS 23/23 scenarios (suite BE 2430 + FE 1907). Archivado en `openspec/changes/archive/2026-06-08-task-manual-inventory-item/`.

### #20 — Audit IA: pasarle el detalle COMPLETO de IClass al modelo
- **Resuelto** (SDD `iclass-audit-full-context`, automático + hybrid): `AuditContext` ahora lleva `historyCommentary` (últimas 10 entradas CON comentario), `commentaryLog` (500 chars), `internalNote` (300) y `equipmentEvents` (20) del mirror — con presupuestos de recorte exportados en `buildAuditContext` (~1.5k tokens worst-case, seguro para qwen2.5vl:7b). `renderPrompt` agrega las secciones como bloques etiquetados condicionales (omitidos si vacíos) + instrucción siempre presente de NO marcar "falta X" si X está en el contexto.
- **Remediación**: migración data-only `20260607010000_remediate_audit_full_context` resetea `auditDone`/`auditAttempts` en `IClassServiceOrder` → el reprocess loop re-audita TODO con contexto completo (gradual; requiere flag `iclass-audit` ON + Ollama arriba).
- **PR**: BE #72. Verify SDD: PASS 12/12 scenarios. El design cazó un error del spec (los flags viven en `IClassServiceOrder`, no `ScheduledTask`). Archivado en `openspec/changes/archive/2026-06-07-iclass-audit-full-context/`.

### #21 + #24 + #26 — Tres chicos de FE en un PR (un commit por ítem)
- **#21 — Asterisco debajo del label (CreateTaskModal)**: `.label` es flex column → el texto y el `<span>*</span>` eran flex items separados y el `*` caía a su línea propia en TODOS los campos. Fix: texto+asterisco comparten un span inline (5 campos). Test estructural.
- **#24 — RV solo editable con `inventory.write`**: el BE ya lo exigía; el FE mostraba el botón a todos y el BE lo rechazaba. Sin permiso → indicador **read-only** (mismo footprint, sin botón, la info se sigue viendo). Gateado con `useCan('inventory.write')`.
- **#26 — Estado closed en blanco y negro (tickets)**: la columna Estado pasó de texto plano a **pill** con el color del catálogo; `closed`/`cerrado` → variante negra con texto blanco. Aplica a lista + Archivo (mismo componente).
- **PR**: FE #48 (commits d7af26e / 6b0b8f4 / c201d63). Sin BE. Sin migración.

### #27 — Filtro de Prioridad en tareas no filtraba
- **Resuelto** (FE-only, directo con TDD). **Causa raíz**: el select manda el **name del catálogo** `TaskPriority` (Baja/Normal/Alta/Urgente — la migración `20260526010000` convirtió hasta las tareas legacy a esos nombres), pero `useTasksFilterUrl` whitelisteaba el valor de la URL contra el **enum legacy** (`low/normal/high/urgent`) en cada read/merge → todo valor real parseaba a `undefined` y el filtro nunca salía en el request. La cadena del BE estaba perfecta (ruta ✓ zod free-text ✓ `ListTasks` passthrough entero ✓ `where['priority']` ✓) — se verificó PRIMERO, aplicando la lección del #28.
- **Fix**: fuera la whitelist `parsePriority`; eliminado el union legacy `TaskPriority` de `types/scheduling` (el typecheck cazó el único otro uso: un cast inútil en `KanbanCard`). 4 tests nuevos de round-trip en `useTasksFilterUrl.test.tsx`.
- **PR**: FE #47. Sin cambios BE. Sin migración. Lección documentada en [`WORKFLOW-MULTI-REPO.md`](./WORKFLOW-MULTI-REPO.md) ("Testear el SEAM completo").

### #28 — Filtro de Asignado en tickets traía sin-asignar (follow-up del #25) + contrato FE de tickets roto
- **Resuelto** (directo con TDD, sin SDD). **Causa raíz BE**: `ListTickets` (use case) reconstruía el query campo a campo y **descartaba `assigneeId`/`from`/`to`** — el #25 cableó la ruta y los repos, pero el filtro moría en el medio (los tests de ruta mockean el use case y los de filtros pegan al repo: el seam no tenía cobertura). Test nuevo con el use case real + repo in-memory.
- **Yapa FE** (mismo combo, contrato legacy del mock): (a) `useAssignTicket` pegaba a `PATCH /tickets/:id/assign` — ruta inexistente (404) — con `Number(uuid)`=NaN → **asignar nunca persistía**; ahora `PATCH /tickets/:id` con `{assigneeId}`. (b) La columna "Asignado a" leía `assignedToName` y el detalle `assignedTo`, campos que el BE no manda (`assigneeId`/`assigneeName`) → todo se veía sin asignar. (c) Crear ticket mandaba `message`+`assignedTo:number`, pero el POST exige `description` (400) y lee `assigneeId:string`. Nuevo `ticketsWireContract.test.tsx` pinea el contrato real en el boundary de axios.
- **PRs**: BE #71 / FE #46. Sin migración.

### #25 — Filtros del listado de tickets (asignado + fechas) ahora aplican
- **Resuelto** (SDD `ticket-assignee-filter`): filtrar por **Asignado** no hacía nada (traía sin-asignar) y las **fechas** (from/to) tampoco — el filtro se perdía en TODAS las capas (query FE, ruta, port, where del repo). Ahora `ListTicketsQuery` + `PrismaTicketRepository.list` filtran por `assigneeId` (exacto) y `createdAt` (rango, fin de día en `to`); la ruta lee/mapea `assignedTo→assigneeId`; el FE manda los params. Tareas ya filtraban server-side (sin cambios).
- **PRs**: BE #68 / FE #45. Sin migración. Archivado en `openspec/changes/archive/2026-06-07-ticket-assignee-filter/`.

### #12 — Filtros usables en "Todos los proyectos" (filtrar por categoría de estado)
- **Resuelto** (SDD `tasks-category-filter`, FE-only): sin proyecto seleccionado, el filtro de Estados muestra las 4 **categorías** (Nuevo / En progreso / Hecho / Cancelado, selección única) y setea `filter.stageCategory` — que ya filtraba client-side. Con proyecto, mantiene los stages del workflow. Cambiar de proyecto limpia el modo opuesto; la categoría activa muestra chip.
- **PR**: FE #44. Sin backend (el filtrado por `stageCategory` ya existía). Archivado en `openspec/changes/archive/2026-06-07-tasks-category-filter/`.

### #11 — Rediseño de la lista de tickets (como tareas) + ID autoincremental
- **Resuelto** (SDD `tickets-redesign-sequence`): la lista de tickets se rediseñó **espejando la de tareas** (single-column: header → barra de filtros horizontal → tabla full-width; `#sequenceNumber` linkeado; prioridad como pill color-coded). BE: `Ticket.sequenceNumber` (Int autoincrement) + migración con backfill por `createdAt` (réplica del patrón de tareas).
- **PRs**: BE #65 / FE #42. Migración `20260607000000_add_ticket_sequence_number`. Archivado en `openspec/changes/archive/2026-06-07-tickets-redesign-sequence/`.
- **Nota**: se eligió "como las tareas" (filtros visibles en barra horizontal) en vez del "ocultos con botón" del item original. Solo la LISTA (el detalle quedó fuera de scope). El worktree viejo `tickets-redesign-fe` se descartó (desactualizado).

### #14 — Campos de completitud del cierre por tarea + auto-completado
- **Resuelto** (SDD `task-completeness-tracking`): 3 flags en `ScheduledTask` (`closureCommentDone`, `closureAuditDone`, `closureHasDeviceInventory` — este último cuenta **solo equipos DEVICE**, no materiales) marcados por el closure (loop/reprocess/cron) vía `markClosureCompleteness`. Migración con backfill idempotente. Cron `TaskAutocompleteScheduler` (flag `task-autocomplete`, default OFF) que reusa `ReprocessClosureSideEffects`. La API de tareas expone los flags para medir.
- **PRs**: BE #63 / FE #41. Migración `20260606020000_task_completeness_fields`. Archivado en `openspec/changes/archive/2026-06-06-task-completeness-tracking/`.
- **Post-deploy**: prender el flag `task-autocomplete` (Cierre de OS) si se quiere el auto-completado automático.

### #18 — Bug: confirmar inventario sin data (validación de datos mínimos)
- **Resuelto** (SDD `inventory-confirm-validation`): guard fail-closed en `ConfirmInventorySuggestion` (`execute` + `replace`) — DEVICE requiere SN o MAC, MATERIAL requiere descripción; sin eso, `IncompleteSuggestionError` → HTTP 422. FE: `SuggestionCard` deshabilita los botones de confirmar + hint del por qué. Eliminado el fallback silencioso a "OTRO" (visto en OS 4175).
- **PRs**: BE #61 / FE #40. Sin migración. Prerequisito del #19. Archivado en `openspec/changes/archive/2026-06-06-inventory-confirm-validation/`.

### #22 — Bug: inventario con foto pero sin SN cuando el OCR falla
- **Resuelto** (SDD `closure-ocr-failure-retry`): el OCR ahora distingue el **fallo técnico** (LLM caída/timeout → `failed`) del label ilegible. Ante fallo técnico NO se cachea la extracción ni se crea el DEVICE incompleto y NO se marca `inventoryBuilt` → el reprocess re-OCR-ea. Una migración de remediación destildó los históricos y borró las extracciones `ocr-error` + los DEVICE pending vacíos.
- **PR**: BE #59. Migración `20260606010000_remediate_ocr_failed_inventory`. Archivado en `openspec/changes/archive/2026-06-06-closure-ocr-failure-retry/`.
- **Post-deploy**: correr "Reprocesar" (con la LLM arriba) para completar los SN de los inventory destildados.

### #7 — Unificar sub-page "Cierre de OS" + feature flag del auditor IA
- **Resuelto** (SDD `iclass-audit-flag-and-unify`): el auditor IA pasó de gatearse por env `ICLASS_AUDIT_ENABLED` a un feature flag DB-backed `iclass-audit` (runtime, toggleable en UI, default OFF). El gate vive en `AuditInstallationQuality.execute()` → aplica al closure-loop **y** al reprocess. FE: la sub-page "Cierre de OS" unifica loop + reconciliar + reprocess + mapeo de resultados + toggle del auditor (**5 → 4 sub-tabs**).
- **PRs**: BE #57 / FE #39. Migración `20260606000000_seed_iclass_audit_flag`. Archivado en `openspec/changes/archive/2026-06-06-iclass-audit-flag-and-unify/`.
- **Post-deploy**: prender el flag `iclass-audit` desde la UI (arranca OFF) para reactivar el auditor.

### #17 — Activity log: nombre de los observadores (watchers)
- **Resuelto** (SDD `activity-watcher-names`, Approach B): el nombre del watcher se resuelve en `UpdateTask` vía el admin lookup (que ya validaba los watchers) y viaja en `metadata` (`toName`/`fromName`); el FE lo muestra como "agregó/quitó a {nombre}". Sin migración.
- **PRs**: BE #55 / FE #38. Archivado en `openspec/changes/archive/2026-06-06-activity-watcher-names/`.

### #1 — Crear tarea: proyecto + descripción obligatorios
- **Qué se pidió**: el select de proyecto al crear tarea venía pre-seleccionado ("Fibra los…"); se quería que arrancara sin proyecto, obligatorio elegir uno, y descripción obligatoria.
- **Cómo se resolvió**: `CreateTaskModal` arranca con placeholder "— Seleccionar proyecto —" (sin auto-default); `canSave` exige proyecto + descripción no vacía; descripción marcada con `*`.
- **Dónde**: FE `CreateTaskModal.tsx`. **PR**: #28 (frontend). Directo con TDD (sin SDD).

### #2 — Refresh de tarea perdía Asignado + Proyecto
- **Síntoma**: al hacer F5 en la página de detalle de una tarea, los `<select>` de Asignado y Proyecto quedaban vacíos; había que salir y volver a entrar.
- **Causa raíz**: `react-hook-form` fija los `defaultValues` al montar; en frío las queries de `admins`/`projects` llegan DESPUÉS, las `<option>` no existen aún y el select cae al vacío sin re-aplicarse.
- **Fix**: hidratación ref-guarded de `assigneeId` + `projectId` cuando llegan las options (mismo patrón que ya existía para `contractId`).
- **Dónde**: FE `DatosForm.tsx`. **PR**: fix/scheduling-bugs-batch1-fe.

### #3 — "Revisado por inventario": mostrar OK + quién lo marcó
- Era parte del cambio `equipment-catalog` (F3).
- **Fix**: columnas `reviewedByInventoryAt` + `reviewedByInventoryUserId` (FK `RbacUser`, `onDelete: SetNull`); el use-case threadea el actor desde `req.user`; el DTO expone `reviewedByInventoryAt` + `reviewedByInventoryUserName`; badge FE "✓ Revisado · {nombre} · {fecha}".
- **Dónde**: BE `ScheduledTask`, `SetTaskInventoryReview`, `scheduling.routes`; FE `InventoryPanel` (TaskTabs). **PRs**: #29 (BE) / #25 (FE).

### #4 — Confirmar equipo: respetar el tipo elegido + mantener diseño
- **Síntoma**: al confirmar una sugerencia salía "✓ ONU — confirmado" (texto plano), perdía la foto/diseño y no respetaba el tipo elegido (era antena).
- **Causa raíz**: el ítem del contrato sí quedaba con el tipo correcto, pero la sugerencia conservaba su `deviceType` escaneado, y la card resuelta era texto plano.
- **Fix**: el use-case persiste el tipo elegido en la sugerencia; la card resuelta mantiene foto + diseño read-only con badge de estado.
- **Dónde**: BE `ConfirmInventorySuggestion`, `setStatus`; FE `SuggestionCard`, `TaskInventorySuggestions`. **PRs**: #22 (BE) / #24 (FE).

### #5 — Catálogo de equipos (antenas/onu/router/otros)
- Cambio `equipment-catalog` (F1). Reemplaza el enum hardcodeado (`VALID_DEVICE_TYPES`, duplicado en 4 lugares) por una tabla editable `DeviceTypeCatalog`.
- Validación dinámica: OCR/confirm/guards leen del catálogo. `OTROS` no-borrable. Migración aditiva que siembra los 5 base idempotente.
- **PR**: #29 (BE). Archivado en `openspec/changes/archive/2026-06-03-equipment-catalog/`.

### #6 — Sub-page de configuración del catálogo
- Cambio `equipment-catalog` (F2). `/admin/inventory/settings` → tab "Equipos" (ABM, espeja `TaskPrioritiesBody`). Dropdowns de inventario leen del catálogo vía `useDeviceTypes`.
- Gateado: `inventory.read` (página) + `inventory.manage` (mutaciones). **PR**: #25 (FE).

### #13 — Búsqueda de tareas rota
- **Síntoma**: buscar por un nombre no devolvía nada.
- **Causa raíz**: el `where` solo buscaba en `title`; buscar por nombre de cliente no matcheaba.
- **Fix**: `where` ahora es un OR sobre **title + customer.name + address**, y matchea el `sequenceNumber` exacto si el término es numérico (Prisma + InMemory, con helper `seedCustomerName`).
- **Dónde**: BE `PrismaSchedulingRepository`, `InMemorySchedulingRepository`. **PR**: #28.

### #8 — Gestión de inventario del servicio (modelo de 3 conceptos)
- **Qué se pidió**: traer el inventario actual del servicio/contrato para validar contra el nuevo; CRUD para quitar/agregar/modificar; agregar otra MAC o material; permisos granulares; materiales como categoría separada.
- **Cómo se resolvió** (cambio SDD `service-inventory-management`, modo automático, 6 batches):
  - **Equipos** = `ContractInstalledItem` (estado): CRUD + **quitar** (soft-delete idempotente: re-quitar = no-op, DELETE→200+item) + cambio de tipo validado vs catálogo.
  - **Catálogo de materiales** = `MaterialCatalog` (nuevo, espeja DeviceTypeCatalog + `unit`): ABM en tab "Materiales" de config (gate `inventory.manage`).
  - **Consumo por visita** = `TaskMaterialConsumption` (nuevo, ledger por tarea); `ConfirmInventorySuggestion` ramifica por kind (DEVICE→ítem, MATERIAL→consumo) — cierra el agujero de materiales huérfanos.
  - **F4**: el sidebar "Inventario del cliente" muestra el inventario real del contrato (read-only).
  - **Permisos**: `inventory.read`/`write`/`manage`; rutas del contrato migradas de `clients.*`→`inventory.*`.
- **Fuera de scope (futuro)**: `stockQuantity` (la base que sube/baja), reportes de costo de material, reemplazo de equipo (`status='replaced'`).
- **Dónde**: BE PR #31 / FE PR #26. Archivado en `openspec/changes/archive/2026-06-03-service-inventory-management/`. 3 migraciones aditivas.

### #15 — GR ingesta: reporter = "Api"
- **Qué se pidió**: en la ingesta de OS de Gestión Real, la `ScheduledTask` debía reportarse con un usuario "Api" (sistema/API), no `null`.
- **Cómo se resolvió**: `bootstrapApiUser` idempotente siembra un `RbacUser` de sistema (`login=api`, `name=Api`, passwordHash inutilizable → no puede loguear), asegurado en el arranque del ingest. El use-case resuelve su id **por run** (`findByLogin`) y lo estampa como `reporterId`; usuario ausente → `null` (degradado, no aborta el batch).
- **Dónde**: BE `bootstrapApiUser.ts` (nuevo), `IngestGestionRealOrders` (inyecta `RbacUserRepository`), `bootstrapGestionRealIngest`. **PR**: #39. Sin migración (el usuario es data en `RbacUser`).
- **Verificado en prod**: tarea OS 17741 recreada con `reporterId` = usuario Api.

### #16 — GR ingesta: traer comentario de la OS a la tarea
- **Qué se pidió**: al crear la tarea desde GR, traer el comentario de la OS y pegarlo en la `description`.
- **Cómo se resolvió**: el campo de GR es **`observaciones`** (confirmado contra la API real). Se agregó a `GrServiceOrder`, se mapea en `parseServiceOrdersResponse` decodificando HTML entities con `he`, y el use-case lo usa como `description` de las tareas normales. Las needs-review conservan su motivo REVISAR (no se pisan).
- **Dónde**: BE `gestionReal.ts`, `GestionRealClient.ts`, `IngestGestionRealOrders.ts`. **PR**: #39. Nueva dep `he`. Sin migración (aterriza en la columna `description` existente).
- **Verificado en prod**: tarea OS 17741 con `description` = comentario de GR, entities decodificadas ("instalación", no "instalaci&oacute;n").

### #10 — Activity log de la tarea
- **Qué se pidió**: la pestaña "Actividad" de la tarea era un `<ComingSoonPanel>`. Reemplazarla por un feed real de auditoría (creación, cambios de etapa/prioridad/asignado, comentarios, checklist, IClass, etc.).
- **Cómo se resolvió** (SDD `task-activity-log`, 5 fases, TDD estricto): tabla `ScheduledTaskActivity` (FK `actor→RbacUser`, `taskId` cascade) + `GET /api/scheduling/:id/activity` (cursor keyset) + recorder best-effort (nunca aborta la operación) + **15 use-cases de escritura instrumentados** + diff engine de `UpdateTask` (14 familias). FE: pestaña Actividad consume el feed con `useInfiniteQuery`, `describeActivity` mapea ~30 tipos a texto humano, gateada con `scheduling.read`.
- **Dónde**: BE PR #41 (migración `20260604120000`) / FE PR #30. Archivado en `openspec/changes/archive/2026-06-03-task-activity-log/`. Verify SDD: PASS 20/20.
- **Verificado en prod**: tabla creada + migración aplicada + FK a `RbacUser` confirmados en la DB; pestaña Actividad desplegada.

### #9 — Crear tarea desde ticket: redirigir + relacionar
- **Qué se pidió**: al crear una tarea desde un ticket, redirigir a la tarea y que el ticket aparezca en "Relacionado".
- **Cómo se resolvió** (solo FE — el BE ya tenía el endpoint): causa raíz — el FE creaba la tarea por `POST /scheduling` (genérico), que **descarta el `ticketId` por diseño** (AD-7: no body-overridable). Fix: usar el endpoint dedicado `POST /tickets/:id/tasks` (ata el ticketId al path + lo persiste) vía `createTaskFromTicket`/`useCreateTaskFromTicket`, y redirigir a `/admin/scheduling/tasks/:id`. El tab "Relacionado" ya renderiza el ticket.
- **Dónde**: FE PR #33. Sin cambios BE.

---

### #29 — Tarea de RED (network-only task, solo nodo)  *(HECHO 2026-06-08)*
- **Resuelto** (SDD `network-node-task`, multi-repo, apply BE∥FE en paralelo): side-button rojo en el modal togglea a modo nodo (sin cliente/contrato), Nodo del catálogo `NetworkSite`, mismo flujo (proyecto/stages/IClass) con badge RED. `ScheduledTask` gana `kind` (discriminador) + `networkSiteId` FK; `NetworkSite` gana `iclassNodeCode`; el dispatch a IClass sustituye campos node-derived (name/address/city del sitio, `customerCode='NETWORK'`, `phone='0000000000'`) + `nodeCode` override explícito. Front con **impeccable** (acento OKLCH terracota).
- **PRs**: BE #75 / FE #51. Migración `20260608000000_network_node_task`. Verify SDD: PASS 16/16. Archivado en `openspec/changes/archive/2026-06-08-network-node-task/`.

### #31 — Reestructurar "Cierre de OS" + vista de progreso por tarea  *(HECHO 2026-06-08)*
- **Resuelto** (SDD `closure-page-restructure`, multi-repo, apply BE∥FE en paralelo): el "Mapeo de estado" (`IClassResultCodeMappingBody`) salió a su propio sub-tab; el tab `cierre` se relabeló **"Procesamiento"** (id preservado → deep-links intactos) y suma una **`ClosureProgressTable`** que muestra, por OS pendiente, comentario/inventario/auditoría ✓/✗ + `auditAttempts` + link a la tarea (#seq · título). 5 sub-tabs. Nuevo `GET /closure/reprocess/pending-list` (use case `GetPendingSideEffectsList` + port `listPendingSideEffectsWithTask`, JOIN sin N+1); `usePendingList` pollea y para al llegar a 0. Front con **impeccable** (pills ✓/✗ semánticos). Responde la pregunta del operador "¿de qué son los N pendientes?".
- **PRs**: BE #76 / FE #52. Sin migración. Verify SDD: PASS 15/15. Archivado en `openspec/changes/archive/2026-06-08-closure-page-restructure/`.

### #30 — Intervalos de los crons de cierre ajustables desde la UI  *(HECHO 2026-06-08)*
- **Resuelto** (SDD `cron-interval-config`, BE + control FE): el cron de cierre (10 min) y el de auto-completado (15 min) tenían el intervalo hardcodeado; ahora lo leen de un config singleton en la DB (`IClassClosureConfig`, espeja el patrón de Gestión Real). `GET/PUT /closure/config` (guard `iclass.manage`, Zod floor 60000ms). `main.ts` pasó a un **async IIFE** que lee el config una vez y awaitea ambos bootstraps con los intervalos persistidos antes de `createApp`. El cambio aplica en el próximo reinicio (se lee al bootstrap). FE: card "Frecuencia de los procesos automáticos" en la tab "Procesamiento" (slot del #31), con impeccable.
- **PRs**: BE #77 / FE #53. Migración `20260609000000_iclass_closure_config` (aditiva, sin seed). Verify: suite BE 2501 + FE 1977, container boot confirmado en prod. Archivado en `openspec/changes/archive/2026-06-08-cron-interval-config/`.

## Refinamientos del #8 (ya en prod, NO son ítems numerados)

Dos follow-ups del inventario shippeados el 2026-06-03 (archivados en `openspec/changes/archive/`):
- **inventory-edit-and-match**: editar el tipo de un equipo confirmado (admin) sincronizando sugerencia + contrato + sidebar (fix tarea 4691); match de sugerencias contra el inventario actual (badge SN/MAC → "ya instalado" / tipo → "posible reemplazo").
- **inventory-confirm-dedup-replace**: el match pasa de aviso a acción — frena el duplicado del mismo equipo; ofrece "Agregar" o "Reemplazar la actual" (la vieja → `status='replaced'` + `replacesItemId`).

## Refinamientos del #10 (post-deploy 2026-06-04, ya en prod)

Tres iteraciones del activity log pedidas tras usarlo en serio (no son ítems numerados):
- **FKs faltantes**: el diff engine no trackeaba contrato/cliente/partner (por eso cambiar el contrato no generaba log) → se agregaron `contract_changed` / `customer_changed` / `partner_changed`. BE PR #43 / FE PR #34.
- **Diff legible en todo el feed**: los eventos FK con nombre muestran el cambio (proyecto/cliente/reportante/asignado: "cambió el proyecto: A → B", "asignó a Juan", "reasignó: A → B"); contrato/partner por presencia ("quitó el contrato"); fechas, dirección y descripción muestran from→to. BE PR #44 / FE PR #35.
- **Refresh en vivo**: el feed se invalida tras update/stage/checklist/inventario/comentarios → el evento aparece **sin recargar la página**. FE PR #34.
- **Pendiente → promovido a #17**: los observadores (`watcher_added/removed`) muestran "agregó/quitó un observador" **sin nombre** — el único evento sin diff completo. Ahora es el ítem **#17** en Pendientes.

## Notas de priorización (lectura del equipo)

- **Epic Tickets**: #9 ✅ hecho; queda **#11** (rediseño + ID autoincremental + filtros). **Epic Integraciones/flags** (#7 + #14): conviene agruparlos.
