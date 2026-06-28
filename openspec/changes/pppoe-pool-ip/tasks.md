# Tasks: PPPoE — IP automática del pool del NAS (sqlippool) + IP fija (Fase 1)

> TDD estricto (test primero, red → green → refactor). Apply en **worktree** (`feat/pppoe-pool-ip`, BE) + worktree FE coordinado.
> Orden de dependencias: **Phase 0 → infra staging → BE → FE → verificación → push gated por OK del usuario**.
> ⚠️ NO push sin OK. NUNCA validar contra un cliente real — siempre usuario de PRUEBA.

## 0. Phase 0 — ✅ RESUELTA (recon live read-only r1, 2026-06-26 — resultados en design.md)
- [x] 0.1 **(a)** NAS-IP→pool **ALCANZA** (Acceso Sur = una sola puerta `10.75.0.30 ne8000_asur`) → NO hace falta `Framed-Pool` por usuario ni tocar el port del orchestrator.
- [x] 0.2 **(b)** `sqlippool` **sí exige** el pool poblado; `radippool` está **VACÍO** → poblar antes del 1er auth (pre-check Decisión 3 + Decisión 8 anti-colisión).
- [x] 0.3 **(c)** Replicación master-master **SANA** (Seconds_Behind=0) → mitigar carrera de lease con `pool_key` + allocación atómica.
- [x] 0.4 **(d)** **NO** hay huntgroups para Fase 1 (una sola puerta `10.75.0.30`).
- [x] 0.5 **(e)** **NO EXISTE staging** → Decisión 7: gate `freeradius -XC` (config-check) + `-X` (debug, usuario de prueba) en r1/r2, sin restartear prod. Reemplaza el gate de staging. (Entorno: FreeRADIUS **3.2.1**, `rlm_sqlippool.so` instalado pero COMENTADO en `sites-enabled/default` líneas 693/833.)

## 1. Infra — FreeRADIUS `sqlippool` (NO hay staging → gate `-XC`/`-X`, Decisión 7)
- [ ] 1.1 Poblar el pool de Acceso Sur (`asur-cgnat` 100.64.10.0/24) en `radippool` vía el orchestrator (`POST /pools`), **EXCLUYENDO los Framed-IP fijos del CIDR + gateway/network/broadcast** (Decisión 8 anti-colisión — verificar/extender el `POST /pools` para que excluya las fijas de `radreply`). El `pool_name` debe coincidir con el `NasServer.poolName` del BE.
- [ ] 1.2 Activar el módulo **`sqlippool`** en r1/r2: descomentar en `sites-enabled/default` (líneas 693/833) + queries `mods-config/sql/main/<dialect>/queries.conf` + selección de pool por NAS-IP (`10.75.0.30`) + **lease sticky ~2 semanas** (`expiry_time`). Config versionada con rollback (re-comentar).
- [ ] 1.3 Envolver con el **bypass** `if (!&control:Framed-IP-Address) { sqlippool }` (post-auth/authorize) → los pinneados y los ~2230 fijos legacy NO toman del pool.
- [ ] 1.4 **GATE `-XC`/`-X` (sin staging):** (1) `freeradius -XC` verde (config-check sin arrancar — si falla, prod sigue intacto); (2) `freeradius -X` en puerto de prueba: usuario de PRUEBA toma IP del pool, sticky tras reconexión, + usuario con Framed-IP **mantiene su IP** (bypass), + auth alternado r1/r2 sin IP duplicada. Recién con (1)+(2) OK → ventana de mantenimiento + `mysqldump` de `radius` + restart rolling r1→r2 + rollback listo. Sin este gate, NADA se restartea en prod.

## 2. Orchestrator (repo `freeradius-orchestrator`, solo si Phase 0 (a) lo exige)
- [ ] 2.1 Si NAS-IP→pool NO alcanza: agregar endpoint/soporte de `Framed-Pool` por usuario (TDD pytest, hexagonal). Si alcanza → **no se toca el orchestrator** (createUser/changeFramedIp ya bastan).

## 3. BE — Modelo (migración aditiva)
- [ ] 3.1 `prisma/schema.prisma`: `PppoeService` `+ ipMode String @default("fixed")`.
- [ ] 3.2 `prisma/schema.prisma`: `NasServer` `+ poolName String?`.
- [ ] 3.3 Migración aditiva `prisma/migrations/<ts>_pppoe_ip_mode/migration.sql` (`ADD COLUMN`, sin backfill). SQL con `prisma migrate diff` (sin DB local). **Dry-run rolled-back vs prod.**
- [ ] 3.4 Propagar `ipMode`/`poolName` en entidades + ports + adapters (Prisma + in-memory) de `PppoeService` y `NasServer`. DTOs **sin password**, `ipMode`/`poolName` expuestos.

## 4. BE — Use cases (TDD: test primero, modo `pool` Y `fixed`)
- [ ] 4.1 **(test primero)** `CreatePppoeService` — rama pool: NAS `poolName != null` y sin IP fija → `ipMode='pool'`, `framedIp=null`, **NO** llama `FindFreeIp`. NAS legacy / IP fija pedida → flujo actual intacto (`ipMode='fixed'`). Tests de regresión del alta fija.
- [ ] 4.2 **(test primero)** `PinPppoeIp(username, ip)` — valida IP (formato + rango gestionado + no en `listAssignedIps()`) → `changeFramedIp(username, ip)` → persiste `ipMode='fixed'`, `remoteAddress=ip`. Errores de dominio (IP inválida/tomada) sin tocar RADIUS ni DB.
- [ ] 4.3 **(test primero)** `UnpinPppoeIp(username)` — rechaza si el NAS no es pool-mode → `changeFramedIp(username, null)` → persiste `ipMode='pool'`, `remoteAddress=null`.
- [ ] 4.4 **(test primero)** `SetNasPoolMode(nasId, poolName)` — pre-check: consulta `GET /pools` (orchestrator); rechaza si el pool está vacío/sin IPs libres. Persiste `NasServer.poolName`.
- [ ] 4.5 Consistencia DB↔RADIUS en los 3: primero el plano de control (orchestrator), después confirmar DB; error del orchestrator → propagar (nunca OK mentiroso). Patrón de `CreatePppoeService`.

## 5. BE — HTTP + wiring
- [ ] 5.1 Rutas en `src/infrastructure/http/routes/pppoe.routes.ts`: `POST /pppoe/:id/pin-ip` + `POST /pppoe/:id/unpin-ip` (gate `pppoe.manage`). Ruta para marcar NAS pool-mode (gate `network.manage`).
- [ ] 5.2 Mapeo de errores: IP inválida/tomada → 422/409; `OrchestratorUnreachableError` → 502; NAS no pool-mode en unpin → 409.
- [ ] 5.3 Wiring en `src/infrastructure/http/app.ts` (⚠️ **God Object** — flag del config.yaml) + **composition test** (anti "feature muerta": las rutas vivas, los use cases cableados con los repos reales).

## 6. FE (`ipnext-frontend`, worktree coordinado) — skill ui-ux-pro-max OBLIGATORIA
- [ ] 6.1 `InternetPanel`: por default **IP automática (pool)** cuando el NAS es pool-mode (sin input de IP). Toggle **"IP fija"** → input de IP + acción pin. Mostrar la IP observada (display-only) en modo pool si está.
- [ ] 6.2 Hooks: pin/unpin (`POST /pppoe/:id/pin-ip`/`unpin-ip`) + estados (loading/success/error inline, sin toast). Gate `pppoe.manage`.
- [ ] 6.3 Tests FE del flujo (toggle, pin, unpin, errores) + typecheck.

## 7. Verificación
- [ ] 7.1 `npm test` verde (BE) + `tsc --noEmit` limpio. Suite FE verde + typecheck.
- [ ] 7.2 DIP: los use cases dependen de ports, NO de infra. `application/` no importa Prisma/axios/Express.
- [ ] 7.3 **Review adversarial** (judgment-day / opus): focos = regresión del alta fija, consistencia DB↔RADIUS, pre-check de pool vacío, el bypass de los legacy, wiring vivo.
- [ ] 7.4 **Validación LIVE** con **usuario de PRUEBA (NUNCA cliente real)** en Acceso Sur: alta pool → toma IP del pool; pin → mantiene la IP; unpin → vuelve al pool; reconexión → sticky.

## 8. Salida de fase — push gated
- [ ] 8.1 **PRE-DEPLOY:** confirmar que ningún NAS quedó `poolName` no nulo sin su pool poblado (evita 502 / clientes sin IP).
- [ ] 8.2 Merge BE+FE coordinado a `main` + push (= prod). **Requiere OK explícito del usuario.** Deploy verde (migración aditiva aplicada).
- [ ] 8.3 Go-live gradual: marcar el NAS de Acceso Sur en modo pool **después** del gate `-XC`/`-X` + restart en ventana + validación LIVE. Los ~2287 fijos siguen intactos (dormant hasta el go-live).
- [ ] 8.4 Actualizar BACKLOG + engram (`sdd/pppoe-pool-ip/*`) con el resultado en prod. `sdd-archive` del change.
