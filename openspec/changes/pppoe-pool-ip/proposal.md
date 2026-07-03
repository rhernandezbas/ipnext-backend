> **[DESCARTADO] (2026-07-03).** Este change (sqlippool / "IP automatica del pool del NAS") fue DESCARTADO: su objetivo se cumplio por otra via (move-nas + watcher + pre-provision, con IP FIJA). El codigo dormant que dejo en prod se removio en el change `pppoe-sqlippool-cleanup` (EN PROD 2026-07-03). Se conserva esta carpeta como registro historico de la decision. NO implementar.

# Proposal: PPPoE — IP automática del pool del NAS (sqlippool) + toggle "IP fija" (Fase 1: NE8000 / Acceso Sur)

## Intent

Que la IP de un PPPoE se asigne **AUTOMÁTICA del pool del NAS** por donde entra el cliente (alta nueva **y** cambio de nodo), **estática-sticky**, **sin que el operador la elija a mano**. Más un toggle **"IP fija"** en el modal de Internet (para negocio / IP pública) que **bypasea el pool** y pinea una IP que **NUNCA cambia**.

**Cambio de paradigma central:** HOY el backend elige la IP (el FE llama `FindFreeIp` → la pasa como `Framed-IP` en `CreatePppoeService`). Con **`sqlippool`**, el backend deja de pre-elegir la IP: asigna un **POOL por NAS** (`Framed-Pool`) y **FreeRADIUS elige la IP del `radippool` en el momento del auth**, con lease sticky. La IP "sigue al NAS" sin intervención humana.

**Alcance de esta fase (decisión del usuario):** **Fase 1 = NE8000 / Acceso Sur** (único entorno 100% sobre el RADIUS HA) **+ clientes nuevos**. Incluye el **feature completo: auto-pool + toggle IP fija**. Los ~2287 PPPoE fijos actuales quedan **INTACTOS** (cero migración de data; fijos y pool conviven seamless vía el bypass de FreeRADIUS).

## Why

- **Caso real que lo motiva:** cargar un PPPoE en el NAS equivocado → la IP no se auto-adapta hoy → el cliente queda sin internet. El operador tiene que elegir la IP a mano y puede errar el rango / el NAS.
- **La asignación está acoplada al operador/FE:** hoy el alta llama al allocator `FindFreeIp` (`src/application/use-cases/FindFreeIp.ts:1-96`, ruta `GET /nas/:nasId/next-free-ip`) y pasa la IP como `remoteAddress` (Framed-IP) a `CreatePppoeService` (`src/application/use-cases/CreatePppoeService.ts:12-19,88-95`). El backend es el **allocator** → si el NAS cambia, la IP **no lo sigue**.
- **`sqlippool` es el patrón estándar de ISP/BNG:** la IP la elige el pool del NAS al momento del auth, con lease sticky → la IP "sigue al NAS" sola, y sobrevive desconexiones largas.
- **Negocio / IP pública necesita una IP que NUNCA cambie** → bypass de Framed-IP fijo, que **ya está casi todo cableado**: `changeFramedIp(username, ip | null)` (`src/domain/ports/RadiusOrchestratorGateway.ts:154-158` → `HttpRadiusOrchestratorGateway.ts:89-91`).
- **Mucho YA existe** (riesgo BAJO, esfuerzo CHICO-A-MEDIO): tabla `radippool` en r1+r2 + CRUD `GET/POST/DELETE /pools` en el orchestrator (commit `7fe7fb9`), `syncPlan(...,pool)` → `Framed-Pool` en radgroupreply (`RadiusOrchestratorGateway.ts:173-177`), `changeFramedIp`, `IpPool.nasId`/`ipKind` (`prisma/schema.prisma:1650-1666`). **Lo único grande que falta del lado infra es activar el módulo `sqlippool` de FreeRADIUS.**

## Scope

### In Scope

**Infra — FreeRADIUS (VMs r1 + r2 del RADIUS HA), gate `-XC`/`-X` (NO hay staging — Phase 0):**
- Activar el módulo **`sqlippool`** (queries contra `radippool`).
- **Lease sticky ~2 semanas** (mantiene la IP en desconexiones largas).
- **Bypass** `if (!Framed-IP-Address)`: los usuarios con Framed-IP fija saltean el pool (los pinneados y los ~2287 legacy).
- **NO existe staging (Phase 0 RESULTS).** El gate "validar sin tocar prod" se hace EN r1/r2 SIN restartear el daemon productivo: **`freeradius -XC`** (config-check, falla si `sqlippool` está mal, con prod corriendo intacto) + **`freeradius -X`** (instancia debug en puerto de prueba, auth de un usuario de PRUEBA). Recién con eso verde → ventana de mantenimiento + `mysqldump` + rolling r1→r2 + rollback (re-comentar `sqlippool`). Ver design Decisión 7. Un `sqlippool` mal configurado **NO levanta FreeRADIUS** → el `-XC` es innegociable.

**Data — `radippool` (MariaDB del RADIUS HA):**
- Poblar los **pools por NAS** de Acceso Sur / NE8000 vía el orchestrator (`POST /pools`).

**Orchestrator (Python, repo `freeradius-orchestrator`):**
- Confirmar/agregar lo que falte para el modo pool: asignar **`Framed-Pool` a nivel USUARIO** (radreply) si no alcanza el de plan; confirmar el round-trip de pools; pin/unpin (`changeFramedIp` ya existe). Ver `design.md` / Phase 0.

**BE (Prominense):**
- **`CreatePppoeService` en modo pool:** para un NAS en modo pool, **NO pre-elige IP** (no llama `FindFreeIp`) → asigna el `Framed-Pool` del NAS → el usuario toma IP del pool en el auth.
- **Use cases pin/unpin:** `PinPppoeIp` (`changeFramedIp(username, ip)`) + `UnpinPppoeIp` (`changeFramedIp(username, null)` → vuelve al pool), con validación de IP (rango / libre).
- **Campo `ipMode`** (`pool` | `fixed`) en `PppoeService` para distinguir el modo (nullable / default `fixed` → no rompe los legacy). **Migración aditiva.**
- **Pool-por-NAS:** asociar un nombre de pool del `radippool` a cada NAS (reusar `IpPool.nasId` + nombre de pool, o `NasServer.defaultPoolName`). Decidir en `design.md`.

**FE (`ipnext-frontend`):**
- **Toggle "IP fija"** en el modal de Internet (`InternetPanel`): por default **IP automática (pool)**; al activar → input de IP + pin. Vía skill **ui-ux-pro-max**.

### Out of Scope

- **Migración / backfill de los ~2287 fijos actuales** → quedan **INTACTOS** como fijos (el bypass de FreeRADIUS los respeta). CERO migración de data.
- **Fase 2 — otros nodos (MikroTik legacy):** requieren migrarse al RADIUS HA primero. Dependiente, fuera de Fase 1.
- **Huntgroups** (nodos balanceados/redundantes → misma IP por cualquier puerta): evaluar en `design.md`; si Acceso Sur / NE8000 es una sola puerta limpia, se **difiere**.
- **Pool de IPv6** → futuro.
- **Reconciliación masiva fijo↔pool** → no aplica (conviven seamless).

## Capabilities

### New Capabilities

- `pppoe-pool-ip`: asignación automática de IP por **pool del NAS** (modo pool, vía `sqlippool`) + **pin/unpin de IP fija** (bypass de Framed-IP).

### Modified Capabilities

- `pppoe-management`: `CreatePppoeService` gana **modo pool** (no pre-elige IP cuando el NAS está en modo pool); el move/update respeta el modo. Aditivo y opt-in por NAS — el modo `fixed` actual no cambia.

## Approach

1. **Infra (NO hay staging — gate `freeradius -XC`):** poblar el `radippool` (excluyendo los fijos del rango, Decisión 8) + activar `sqlippool` en r1/r2 (queries `radippool`, lease 2 sem, bypass `if(!Framed-IP)`). **GATE: `freeradius -XC` verde (config-check sin arrancar) + `freeradius -X` con un usuario de PRUEBA** (toma IP del pool; el Framed-IP fijo la mantiene). Recién ahí: restart en **ventana de mantenimiento** + `mysqldump` backup + **rolling r1→r2** + rollback. Ver `design.md` Decisiones 7/8.
2. **Poblar pools por NAS** (`radippool`) de Acceso Sur / NE8000 vía el orchestrator (`POST /pools`).
3. **BE modo pool:** campo `ipMode` en `PppoeService` (migración aditiva) + `CreatePppoeService` rutea: NAS en modo pool → asigna `Framed-Pool`, NO `Framed-IP`. TDD (red → green → refactor).
4. **BE pin/unpin:** `PinPppoeIp` / `UnpinPppoeIp` (`changeFramedIp`) + rutas en `pppoe.routes.ts` + RBAC (`pppoe.manage`) + validación de IP. TDD.
5. **FE toggle:** `InternetPanel` — default IP automática; toggle "IP fija" → input + pin. ui-ux-pro-max.
6. **Validación LIVE** con **usuario de PRUEBA (NUNCA un cliente real)** en Acceso Sur, antes de marcar el NAS en modo pool en prod.

## Phase 0 — ✅ RESUELTA (recon live read-only en r1, 2026-06-26 — resultados completos en `design.md` § "Phase 0 — RESULTADOS")

- **(a)** ✅ NAS-IP→pool ALCANZA (Acceso Sur entra por UN solo NAS-IP `10.75.0.30`) → NO hace falta `Framed-Pool` por usuario ni tocar el port del orchestrator.
- **(b)** ✅ Sí exige el pool poblado, y `radippool` está **VACÍO** → poblar ANTES del primer auth (lo cubre el pre-check de Decisión 3 + Decisión 8 anti-colisión).
- **(c)** ✅ Replicación master-master **SANA** (Seconds_Behind=0) → mitigar la carrera de lease con `pool_key` + allocación atómica.
- **(d)** ✅ **NO** hay huntgroups para Fase 1 (una sola puerta `10.75.0.30`).
- **(staging)** ✅ **NO EXISTE** staging → Decisión 7: gate `freeradius -XC`/`-X` en r1/r2 + ventana de mantenimiento (reemplaza el gate de staging).

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| FreeRADIUS config (VMs r1 + r2) | Modified (infra) | Activar módulo `sqlippool` + lease 2 sem + bypass `if (!Framed-IP)`. **Staging-gated.** |
| `radippool` (MariaDB RADIUS HA) | Data | Poblar pools por NAS de Acceso Sur / NE8000 (`POST /pools`) |
| orchestrator (repo `freeradius-orchestrator`) | Modified / Verify | `Framed-Pool` por usuario si falta + confirmar pin/unpin round-trip |
| `prisma/schema.prisma` | Modified | + campo `ipMode` (`pool`\|`fixed`) en `PppoeService` (nullable / default `fixed`) |
| `prisma/migrations/<ts>_pppoe_ip_mode/migration.sql` | New | Aditivo: `ADD COLUMN "ipMode"` |
| `src/application/use-cases/CreatePppoeService.ts` | Modified | Modo pool: no pre-elegir IP cuando el NAS está en modo pool |
| `src/application/use-cases/PinPppoeIp.ts` | New | `changeFramedIp(username, ip)` + validación |
| `src/application/use-cases/UnpinPppoeIp.ts` | New | `changeFramedIp(username, null)` → vuelve al pool |
| `src/infrastructure/http/routes/pppoe.routes.ts` | Modified | + rutas pin / unpin (gate `pppoe.manage`) |
| `src/infrastructure/http/app.ts` | Modified | ⚠️ **God Object (615+ líneas)** — wiring de los nuevos use cases |
| `ipnext-frontend` (`InternetPanel`) | Modified | Toggle "IP fija" (ui-ux-pro-max) |

> **Splynx:** este cambio NO agrega dependencias de Splynx (constraint respetado).

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| `sqlippool` mal configurado → FreeRADIUS NO levanta | Alta | **NO hay staging → gate `freeradius -XC` (config-check sin arrancar) + `-X` (debug, usuario de prueba) en r1/r2 sin restartear prod** (Decisión 7); config versionada con rollback (re-comentar `sqlippool` + restart); jamás restartear el daemon real sin `-XC` verde |
| Replicación HA: lease en r1 no visible en r2 <100 ms → IP duplicada | Media | `pool_key` por cliente + allocación atómica (lock `sqlippool`); validar en staging con auth alternado r1/r2 (Phase 0 c) |
| NAS marcado modo pool sin pools poblados → cliente sin IP | Media | **Pre-check**: no permitir modo pool si el `radippool` del NAS está vacío + validación LIVE con usuario de prueba |
| Romper los ~2287 fijos legacy | Baja | **CERO migración**; el bypass Framed-IP los respeta; `ipMode` default `fixed` |
| El orchestrator no asigna `Framed-Pool` por usuario | Media | **Phase 0 (a)** antes de codear; si falta → feature TDD en el orchestrator |
| Regresión en `CreatePppoeService` (que el alta fija deje de andar) | Media | TDD: tests del modo `fixed` **y** `pool`; el modo pool es opt-in por NAS |

## Rollback

**Por capas, reversible.**
- **Infra:** revertir la config de FreeRADIUS (`sqlippool` off) → vuelve al modo Framed-IP; los pools quedan en `radippool` inertes.
- **BE:** `ipMode` es aditivo nullable → `git revert` + `DROP COLUMN` → el alta vuelve a pre-elegir IP (`FindFreeIp`).
- **Go-live gradual:** ningún NAS en modo pool hasta el go-live → la feature queda **dormant** en prod. Los ~2287 fijos **nunca se tocan**.

## Dependencies

- **NO hay staging** (Phase 0): se valida en r1/r2 con `freeradius -XC`/`-X` (**needs root** en las VMs) + ventana de mantenimiento para el restart real (Decisión 7).
- `radippool` poblado con pools por NAS de Acceso Sur / NE8000.
- orchestrator: `changeFramedIp` (✓ existe) + `Framed-Pool` por usuario (a confirmar — Phase 0 a).
- Acceso Sur / NE8000 100% sobre el RADIUS HA (✓ post migración + MTU NE8000).

## Success Criteria

- [ ] `sqlippool` validado con **`freeradius -XC` + `-X`** (sin staging, Decisión 7): config-check verde + usuario de PRUEBA toma IP del pool del NAS, sticky, en la instancia debug — ANTES del restart real.
- [ ] **Bypass**: un usuario con Framed-IP fija mantiene su IP (no toma del pool).
- [ ] **Alta nueva** en NAS modo pool: el BE NO pre-elige IP; el cliente toma IP del pool en el auth.
- [ ] **Cambio de nodo**: la IP se re-asigna del pool del nuevo NAS automáticamente.
- [ ] **Toggle "IP fija"** (FE): pinea una IP que sobrevive reconexiones; unpin vuelve al pool.
- [ ] Los **~2287 fijos legacy intactos** (sin migración, IP estable).
- [ ] **Pre-check**: no se puede marcar un NAS modo pool sin pools poblados.
- [ ] **Validación LIVE** con usuario de PRUEBA (nunca cliente real) en Acceso Sur OK.
- [ ] `npm test` verde + `tsc --noEmit` limpio. Wiring en `app.ts` flageado (God Object).
- [ ] **DIP preservado** (los use cases dependen de ports, no de infra).
