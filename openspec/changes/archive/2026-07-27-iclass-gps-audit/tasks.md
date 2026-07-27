# Tasks: iclass-gps-audit

> **Strict TDD activo**: cada tarea con código arranca por el test que FALLA. Gate: `npm test` + `tsc --noEmit`.
> **Worktree**: `ipnext-backend/.claude/worktrees/iclass-gps-audit-be`, branch `feat/iclass-gps-audit` desde el SHA explícito de `main`.

## Fase 1 — Dominio puro (sin infraestructura, sin red)

- [ ] 1.1 Test + impl de `haversine.ts`: distancias conocidas (0 m, ~13 m, ~12.867 m) con tolerancia
- [ ] 1.2 Test + impl de la entidad `TeamLocationPoint` (parseo de `dd-MM-yyyy HH:mm:ss`, precisión y orígenes verbatim)
- [ ] 1.3 Test + impl de `PresenceVerdict` (`EN_SITIO` | `FUERA_DE_SITIO` | `NO_CONCLUYENTE` | `NO_AUDITABLE`)
- [ ] 1.4 Test + impl de `presenceEvaluation`: **0 puntos → `NO_CONCLUYENTE`** (nunca `FUERA_DE_SITIO`)
- [ ] 1.5 Test + impl: resta de precisión en el borde (180 m con `raio` 102 → no condena; 12.867 m con `raio` 31,8 → sí)
- [ ] 1.6 Test + impl del cálculo de ventana desde `historicoStatus` (**NUNCA** `dataAgendamento`) con margen ±15 min
- [ ] 1.7 **Casos reales como tests de regresión**: OS 4943 → `EN_SITIO` 0 m · OS 4905 → `EN_SITIO` 3 m (y **NO** 1.538 m) · OS 4995 → `FUERA_DE_SITIO` 12.867 m con 16 puntos
- [ ] 1.8 Ports `TeamLocationRepository` y `TeamLocationSource` en `domain/ports/`

## Fase 2 — Adapter IClass (delta `iclass-integration`)

- [ ] 2.1 Test: `listTeamLocations` **no corta** ante una página con <`pagesize` ítems
- [ ] 2.2 Test: corta sólo tras 2 páginas vacías/`204` consecutivas
- [ ] 2.3 Test: `getLastTeamLocation` devuelve ausencia (no error) ante `204`
- [ ] 2.4 Test: el id de cuadrilla se extrae de `localizacoes` cuando `id` viene `null`
- [ ] 2.5 Impl de ambos métodos en `IClassClient.ts` reusando el manejo de `429` existente
- [ ] 2.6 Test: `429` persistente marca la ventana **incompleta**, no la reporta exitosa

## Fase 3 — Persistencia

- [ ] 3.1 Modelos `TeamLocationPoint` y `TeamLocationIngestRun` en `schema.prisma`
- [ ] 3.2 Migración **aditiva** generada con `prisma migrate diff` (sin `BEGIN`/`COMMIT` internos — gotcha del dry-run)
- [ ] 3.3 Test + impl de `InMemoryTeamLocationRepository`
- [ ] 3.4 Test + impl de `PrismaTeamLocationRepository`
- [ ] 3.5 Test: dedup por `(teamLogin, recordedAt, lat, long)` conservando ambos `origem`
- [ ] 3.6 Test: idempotencia — reingestar la misma ventana no duplica filas
- [ ] 3.7 Test + impl de la purga a 12 meses con conteo reportado

## Fase 4 — Use cases

- [ ] 4.1 Test + impl `IngestTeamLocations` (watermark por cuadrilla, contadores por corrida)
- [ ] 4.2 Test + impl `AuditServiceOrderPresence`
- [ ] 4.3 Test + impl `ListSuspiciousClosures` (pre-filtro <5 min, **sin tocar GPS**)
- [ ] 4.4 Test + impl `GetTeamsLiveStatus` (activa / desactualizada >24h / sin rastro)
- [ ] 4.5 Test: `status: "Inativo"` que reporta hoy → **activa** (el status de IClass no determina tracking)
- [ ] 4.6 Test + impl `GetTeamDailyJourney` (inicio, fin, puntos, distribución horaria)
- [ ] 4.7 Test: distancia recorrida rotulada como **mínimo estimado**, con intervalo de muestreo

## Fase 5 — RBAC y HTTP

- [ ] 5.1 Migración idempotente del módulo `technicians` + acciones `location.read` / `location.audit` (`ON CONFLICT DO NOTHING`)
- [ ] 5.2 Test + impl de `technicianLocation.routes.ts` con guard granular en **cada** ruta
- [ ] 5.3 Test: `location.read` **NO** habilita los endpoints de auditoría (rechazo del BE, no sólo del FE)
- [ ] 5.4 Wiring en `app.ts` (⚠️ 3.326 líneas — commit atómico al final para minimizar colisión)
- [ ] 5.5 **Composition-root test** que pinea el wiring (lección W6: rutas cableadas sin hook = feature muerta con CI verde)

## Fase 6 — Scheduler

- [ ] 6.1 Feature flag `iclass-gps-ingest` (patrón `pppoe-auto-move`), **OFF por default**
- [ ] 6.2 Test + impl de `TeamLocationIngestScheduler` cada 6h (patrón `IClassClosureScheduler`)
- [ ] 6.3 Test: con el flag OFF el scheduler no corre
- [ ] 6.4 Logging estructurado de cada corrida (nuevos, duplicados, purgados, páginas, incompletas)

## Fase 7 — Frontend (repo `ipnext-frontend`, worktree propio)

- [ ] 7.1 Correr `ui-ux-pro-max --design-system` ANTES de escribir UI
- [ ] 7.2 Page de auditoría: veredicto + distancia + hora + precisión + nº de puntos + ventana + link a Maps
- [ ] 7.3 **`NO_CONCLUYENTE` / `NO_AUDITABLE` con igual peso visual** que el resto; el color nunca como único indicador
- [ ] 7.4 Listado del pre-filtro de cierres imposibles (rotulado **candidatos**, no incumplimientos)
- [ ] 7.5 Mapa en vivo con Leaflet + badge de antigüedad; las desactualizadas no se dibujan como posición actual
- [ ] 7.6 `RequirePermission` con las claves de PUNTO (`technicians.location_read` / `technicians.location_audit`), verificadas contra `/me`
- [ ] 7.7 4 ramas de estado (loading/empty/error/success) + a11y (contraste ≥4.5:1 calculado, touch ≥44px, focus visible)
- [ ] 7.8 Pasar por `review-animations` si algo se mueve

## Fase 8 — Verify y cierre

- [ ] 8.1 Gate corrido **por el orquestador**: `npm test` + `tsc --noEmit` en BE y FE
- [ ] 8.2 `sdd-verify` con matriz de spec-compliance (cada scenario con su test verde)
- [ ] 8.3 **Review adversarial** (obligatorio): focos separados en migración, honestidad del veredicto, contrato BE↔FE y a11y
- [ ] 8.4 Fix wave con TDD + **re-review focalizada** hasta CLEAN
- [ ] 8.5 Dry-run de la migración rolled-back contra prod
- [ ] 8.6 Push con OK del usuario → seguir el run en `gh` hasta verde (incluido `Run DB migrations`)
- [ ] 8.7 Verificación en vivo con Playwright contra `http://190.7.234.37:7778`
- [ ] 8.8 Actualizar la card del `BACKLOG` a `✅ HECHO Y EN PROD` + reflejar en el vault de Obsidian
- [ ] 8.9 Sincronizar `main` local con `origin/main` en **ambos** repos
- [ ] 8.10 `sdd-archive`

## Acción paralela (no bloqueante, sin código)

- [ ] 9.1 Consultar al soporte de IClass si pueden habilitar `coordenadasFechamento` (hoy vacío en 0/416 OS). Si lo prenden, la auditoría se vuelve trivial y este change queda como respaldo histórico.
