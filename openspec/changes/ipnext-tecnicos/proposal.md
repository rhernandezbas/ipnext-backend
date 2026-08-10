# Proposal: ipnext-tecnicos — app propia de técnicos + módulo `/api/tech/*`

## Intent

IClass FSM es hoy el único canal de campo: despacho, estados y el rastro GPS viven afuera. Eso nos deja sin GPS propio, con auditoría dependiente del rastro de un tercero (retención ~30 días) y sin poder ofrecer "el técnico va en camino" en la customer app. Este EPIC construye la capacidad propia — app de técnicos + módulo `/api/tech/*` — **conviviendo en paralelo con IClass**. El cutover es un evento aparte.

## Scope

### In Scope
- Módulo `/api/tech/*` en ipnext-backend (sin backend nuevo), JWT `aud=tech` sobre el `RbacUser` existente, scoping SIEMPRE desde el token.
- Tareas del día + detalle + transiciones (en-camino → en-sitio → cierre con result-code y comentario).
- Cierre **first-writer-wins atómico** (`updateMany where generalStatus != 'closed'`) + `closureOrigin` (`app|iclass|staff`) + log de discrepancia de result-code.
- GPS propio: `TeamLocationPoint` extendida (aditivo: `source` default `'iclass'`, `technicianId` nullable FK) + ingest de breadcrumbs.
- Evidencia de cierre (fotos/firma) reusando `MinioFileStorage` + `ScheduledTaskAttachment`.
- Declaración de consumo de material por el técnico, reusando `StageMaterialDeduction`.
- Repo NUEVO de la app (Expo/RN) clonando el esqueleto de `ipnext-customer-app`: `expo-router` + grupos `(auth)`/`(tabs)`, `src/lib/api.ts` (`apiRequest`/`apiRequestMultipart`, `ApiError` tipado, refresh-on-401 single-flight), React Query, design-system.

### Out of Scope (v1)
- Cutover / apagado del despacho a IClass.
- Offline-first con cola de sincronización (v1 exige conectividad; solo retry simple).
- Push notifications, chat/mensajería in-app, navegación turn-by-turn.
- Auto-asignación, reasignación o creación de tareas desde la app; agenda editable.
- Cobro en campo; firma con validez jurídica (v1 = evidencia operativa).
- "En camino" en la customer app (consume el dato del Wave 2, pero es un change aparte).

## Waves

Criterio: **cada wave es shippeable y verificable por separado**.

| Wave | Alcance | Toca |
|------|---------|------|
| **1a** | `closureOrigin` + cierre atómico first-writer-wins + log de discrepancia. Arregla la race PREEXISTENTE staff↔ingest (`MoveTaskToStage.ts:379-380` vs `IngestClosedServiceOrders`). | **Solo BE** |
| **1b** | Contrato `/api/tech/*`: login/refresh/logout/me + lista del día + detalle (cliente, domicilio, mapa) + transiciones. **El corazón.** | **Contrato compartido** |
| **2a** | Migración aditiva de `TeamLocationPoint` + lecturas (`live`, `journey`, `audit`) dual-source. | **Solo BE** |
| **2b** | `POST /api/tech/location` (breadcrumbs batch) + background location en la app. | **Contrato compartido** |
| **3** | Evidencia de cierre (multipart, fotos/firma). | **Contrato compartido** |
| **4** | Consumo de materiales declarado por el técnico. | **Contrato compartido** |

Las waves marcadas **contrato compartido** llevan el contrato **escrito campo por campo** en su delta spec (request/response, códigos de error, semántica de cada campo): hay apps instaladas en teléfonos y todo cambio posterior es **solo aditivo**.

## Capabilities

### New Capabilities
- `tech-api-auth`: login dedicado, JWT `aud=tech` sobre RbacUser, middleware Bearer-only, guards cruzados de audiencia.
- `tech-tasks-worklist`: lista del día, detalle y transiciones de estado ancladas a `assigneeId = req.technicianId`.
- `tech-location-ingest`: ingest de breadcrumbs desde la app propia.
- `tech-closure-evidence`: fotos/firma de cierre.
- `tech-material-consumption`: declaración de consumo en campo.

### Modified Capabilities
- `task-general-status`: cierre atómico first-writer-wins + `closureOrigin`; el segundo escritor no pisa.
- `iclass-team-location-ingest`: la tabla deja de ser IClass-exclusiva (`source`, `technicianId`).
- `iclass-team-live-map`: mapa vivo y auditoría leen ambos orígenes.
- `rbac-permission-catalog-extension`: módulo `tech` con permisos granulares (**doble capa**: `aud=tech` + permiso RBAC) — `tech_app_access` (gate de login) y `tech_task_close`.

## Approach

Réplica exacta del patrón `/api/portal/*`: port `TechTokenService` en `domain/ports`, adapter JWT con algoritmo pineado HS256, `techAuthMiddleware` que re-chequea el status del RbacUser en CADA request y setea `req.technicianId` como **única** fuente de scoping (anti-IDOR), router con deps opcionales montado en `app.ts` — lo que permite fasear y desmontar. Los use-cases reusan los ports existentes; cero lógica nueva de negocio en inventario, storage y stock.

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `src/domain/ports/TechTokenService.ts` | New | Port de firma/verificación |
| `src/infrastructure/adapters/jwt/` | New | `JwtTechTokenService` |
| `src/infrastructure/http/middleware/techAuthMiddleware.ts` | New | Bearer-only, scoping |
| `src/infrastructure/http/routes/tech.routes.ts` | New | Superficie `/api/tech/*` |
| `src/infrastructure/http/app.ts` | Modified | ⚠️ **God Object (3326 líneas, deuda HIGH)** — un mount point nuevo; punto de colisión entre sesiones paralelas |
| `src/infrastructure/adapters/jwt/JwtAuthAdapter.ts` | Modified | Rechazo de `aud='tech'` en rutas admin |
| `prisma/migrations/` | New | Aditivas: `closureOrigin`, `TeamLocationPoint.source`/`technicianId` |
| `src/application/use-cases/MoveTaskToStage.ts`, `SetTaskGeneralStatus.ts`, `ReconcileTaskClosure.ts` | Modified | Cierre atómico |
| repo `ipnext-tecnicos` (nuevo) | New | App Expo/RN |

Sin dependencias nuevas de Splynx.

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Race de cierre app↔IClass↔staff (4° escritor) | **Alta** | Wave 1a **antes** del piloto: guard atómico + origen + log de discrepancia |
| Contrato público naciente congelado con apps instaladas | Alta | Solo aditivo; contrato campo por campo en la spec; versionado de errores tipados |
| `expo-location`/`expo-task-manager` no están en el esqueleto; compat SDK 57 no confirmada | Media | **Verificación previa BLOQUEANTE del Wave 2** (`npx expo install`) — si falla, el Wave 2 se replantea sin arrastrar a 1/3/4 |
| Background location Android: permiso sensible + revisión de Play Console + batería | Alta | Declaración de uso prominente, muestreo adaptativo, corte fuera de jornada; el permiso NO bloquea el Wave 1 |
| `JWT_SECRET` compartido: `aud` es la ÚNICA separación panel↔móvil | Media | Guard cruzado en ambas direcciones + test de que un token `tech` no abre `/api/admin/*` y viceversa |
| Colisión de merge en `app.ts` | Media | Un solo bloque de mount, al final del wiring |

## Rollback Plan

- **Por wave**: el router se monta solo si sus deps están inyectadas → no inyectarlas hace desaparecer la superficie sin tocar el resto.
- **Migraciones aditivas con default** → el revert del código no exige revert de schema (columnas quedan inertes).
- **Wave 1a** es estrictamente más seguro que el estado actual (hoy no hay lock); su revert reintroduce la race — preferir fix-forward.
- **Wave 2**: apagar el ingest de la app deja el mapa vivo leyendo solo `source='iclass'`, idéntico a hoy.

## Dependencies

- Repo nuevo `ipnext-tecnicos` creado con el esqueleto de `ipnext-customer-app`.
- MinIO configurado (`MINIO_*`) para el Wave 3 — sin él, 503 explícito.
- Verificación de `expo-location`/`expo-task-manager` en SDK 57 (bloqueante del Wave 2).

## Success Criteria

- [ ] Un técnico piloto completa una tarea end-to-end desde la app mientras IClass sigue despachando, sin pisadas de estado.
- [ ] Un cierre concurrente app↔ingest deja UN solo `generalStatus='closed'`, con `closureOrigin` correcto y la discrepancia logueada.
- [ ] Un token `aud=tech` NO abre ninguna ruta admin, y un token de staff NO abre `/api/tech/*`.
- [ ] Ningún endpoint `/api/tech/*` acepta identidad por body/query.
- [ ] El mapa vivo y la auditoría muestran breadcrumbs de la app junto a los de IClass sin cambiar las queries de lectura.
- [ ] `npm test` verde y `tsc --noEmit` limpio en cada wave.
