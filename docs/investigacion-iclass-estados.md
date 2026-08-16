# Investigación — Traer estados de IClass a Prominense

> Estado: **investigación / exploración** (no es implementación). Guardada también en engram (`sdd/iclass-status-sync/explore`).
> Fecha: 2026-06-14. Objetivo del usuario: ver los estados de las órdenes de IClass desde Prominense, poder cerrar/validar y asignar el técnico desde Prominense.

---

## 1. Terminología — qué es "el ticket" acá

Cuando se habla de "cerrar el ticket" o "asignar el técnico", en realidad se trata de la **`ScheduledTask` (tarea) de Prominense**, que es la **Orden de Servicio (OS) de IClass**. Los **Tickets** (módulo de soporte al cliente) **NUNCA** se despachan a IClass — son otra cosa.

| Concepto Prominense | Concepto IClass | Cómo se atan |
|---|---|---|
| `ScheduledTask` (tarea) | Service Order (OS) | `IClassServiceOrder.iclassCodigo == ScheduledTask.sequenceNumber`; el código que devuelve IClass queda en `ScheduledTask.iclassOrderCode` |

- **"Cerrar / validar el ticket desde Prominense"** = `POST /serviceorders/close` a IClass → **hoy NO existe** en el código.
- **"Asignar el técnico desde Prominense"** = setear `requiredTeam` vía `POST /serviceorders/update` → **hoy NO existe** en el código.

---

## 2. Qué expone la API de IClass

### Estados (statuses)
- El estado de una OS viene como objeto **`status = { id, descricao }`**.
- **Hoy Prominense solo procesa el estado terminal `'7'` ("Concluida")** y **descarta todos los demás** (el scheduler hace `statusCode !== '7' → skip`).
- Estados intermedios observados en respuestas reales: **Agendada, Em Análise, Vinculada Credenciada**.
- ⚠️ **No hay un catálogo/enum de estados documentado** — los `id` numéricos de los estados intermedios son **opacos**; hay que descubrirlos contra la API real.
- **No hay webhooks**: la única vía es **polling**.

### Cerrar una OS
- `POST /serviceorders/close` con `{ serviceOrderCode, resultCode, closeDate, commentary }`.
- El `resultCode` debe existir en el catálogo del tipo de OS — **eso ya está sincronizado** en Prominense como `IClassResultCode` (mapeo de result-codes / motivoFechamento).

### Asignar cuadrilla / técnico
- `POST /serviceorders/update` (payload `UpdateSOIn`) con el campo **`requiredTeam`**.
- Los teams/cuadrillas se listan con `GET /teams` → **catálogo que todavía NO existe** en Prominense (habría que crearlo, mismo patrón que `IClassNode`).

---

## 3. Qué hay HOY en Prominense (integración existente)

- **Despacho tarea → OS**: al crear una `ScheduledTask` se despacha una OS a IClass (features #29 tarea de red, #55 `customerCode = grContratoId`, #54 localidad).
- **Cierre / ingesta**: `IngestClosedServiceOrders`, `BackfillClosedServiceOrders`, el mirror `IClassServiceOrder`, `IClassResultCode`, `IClassNode`, `IClassClosureConfig`. Maneja rate-limit 429 con backoff (#33).
- **Cierre automático de la tarea**: cuando la OS pasa a terminal en IClass, la tarea se marca `closed` (`generalStatus`, feature #41).
- **Historial de estados**: existe `IClassSoStatusHistory` **pero solo para OS cerradas**, no para OS activas.

---

## 4. El gap (qué falta)

| Capacidad | Estado hoy |
|---|---|
| Ver el estado ACTUAL de la OS en Prominense (tiempo real) | ❌ el `IClassPort` no tiene `getServiceOrder(id)`; el FE no muestra nada |
| Ver estados intermedios (no solo "cerrada") | ❌ el scheduler los filtra activamente (`!== '7'` → skip) |
| Cerrar / validar la OS desde Prominense → IClass | ❌ `POST /serviceorders/close` no está en el port ni en el adapter |
| Asignar el team de IClass desde Prominense | ❌ `POST /serviceorders/update` no está; falta el catálogo de teams |
| Historial de estados de OS ABIERTAS | ❌ existe solo para cerradas (`IClassSoStatusHistory`) |

---

## 5. Approaches con tradeoffs

### A. Estado visible (la ganancia más rápida)
- **Approach 2 — RECOMENDADO para MVP**: ampliar el scheduler que YA corre para que, al iterar las OS, persista un campo desnormalizado `iclassStatus` en `ScheduledTask` (sin filtrar por terminal). Cero infra nueva, reutiliza todo. Contra: lag de hasta 10 min.
- **Approach 1 — on-demand**: endpoint `GET /scheduling/:id/iclass-status` que consulta IClass en tiempo real al abrir la tarea. Complementa al anterior cuando el operador quiere frescura inmediata.
- **Approach 3 — configurable**: catálogo de mapeo "estado IClass → etiqueta Prominense" (mismo patrón que `IClassResultCode`/`IClassNode`). Ideal para Fase 2, porque permite **elegir qué estados resaltar/traer**.

### B. Cierre de OS desde Prominense
- **Approach 4 — RECOMENDADO**: cierre condicional con pre-check. Solo ejecutar `POST /serviceorders/close` si la tarea está `generalStatus === 'open'` **y** la OS no está ya cerrada en IClass (pre-check con `GET /serviceorders/{id}`). El scheduler existente cubre la idempotencia del lado pull.

### C. Asignación de técnico/cuadrilla
- **Approach 2 — RECOMENDADO**: asignación post-despacho vía `POST /serviceorders/update`. Requiere sincronizar un catálogo `IClassTeam` (nueva tabla, mismo patrón que `IClassNode`).

---

## 6. Riesgos

1. **Race scheduler ↔ cierre manual**: si el operador cierra desde Prominense y el scheduler ingesta la OS 2 min después, el guard `task.generalStatus !== 'closed'` previene el doble-cierre. Pero el `resultCode` puede diferir si el técnico cerró con otro resultado en campo.
2. **IDs de estados intermedios opacos**: IClass no documenta el enum de statusCodes; los nombres vienen del `descricao` (texto libre en portugués). **Hay que verificar contra la API real antes de mapear nada.**
3. **Rate-limit 429**: ya manejado con retry exponencial (4 intentos, backoff). Las nuevas ESCRITURAS deben pasar por el mismo `withAuthRetry`.
4. **IClass ya "mintió" 3 veces** respecto de su doc (status codes, cap de paginación 20, `?city=` roto). Toda integración nueva de endpoint debe verificarse contra la API real antes de asumir su comportamiento.

---

## 7. MVP propuesto — 3 fases

| Fase | Qué | Infra nueva | Costo |
|------|-----|-------------|-------|
| **Fase 1 — Estado visible** | Ampliar el scheduler para persistir `iclassStatus` en la tarea + mostrarlo en el FE (detalle de tarea / kanban) | Ninguna | **Bajo** |
| **Fase 2 — Cerrar desde Prominense** | `closeServiceOrder` en port/adapter + use case + ruta + UI (con pre-check). El catálogo de result-codes ya existe | Ninguna tabla | **Medio** |
| **Fase 3 — Asignar cuadrilla** | Sincronizar catálogo `IClassTeam` (nueva tabla) + `updateServiceOrder` en port + UI | Tabla `IClassTeam` + sync | **Medio-Alto** |

### Decisiones que son del usuario
1. **Por dónde arrancar** (Fase 1 sola / relevar estados reales primero / las 3 fases).
2. **Qué estados de IClass querés ver/resaltar** — para esto primero hay que **relevar los statusCodes reales** (son opacos), porque sin saber cuáles existen no se puede elegir.
3. Si el **cierre** desde Prominense debe exigir comentario/result-code obligatorio (como el cierre nativo de IClass).
