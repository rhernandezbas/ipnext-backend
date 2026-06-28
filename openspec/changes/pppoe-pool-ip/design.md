# Design: PPPoE — IP automática del pool del NAS (sqlippool) + IP fija (Fase 1)

## Contexto

**El cambio de paradigma:** hoy **el backend elige la IP**. El alta (`CreatePppoeService.ts:88-95`) llama al orchestrator con `framedIp: remoteAddress`, donde `remoteAddress` lo pre-eligió el FE consultando el allocator `FindFreeIp` (`GET /nas/:nasId/next-free-ip`). El backend es el allocator → si el cliente cambia de NAS, la IP **no lo sigue**.

Con este cambio, para los servicios en **modo pool**, el backend **deja de pre-elegir la IP**: crea el usuario RADIUS con `framedIp = null` y **FreeRADIUS (`sqlippool`) asigna la IP del pool del NAS** en el momento del auth, sticky. La **IP fija** (negocio / pública) sigue siendo una Framed-IP pineada que **bypasea el pool**.

**Lo que YA existe y se reusa (verificado, file:line):**
- `RadiusOrchestratorGateway.createUser({ …, framedIp })` — y el contrato dice explícito: **`framedIp` `null`/ausente → IP del pool** (`RadiusOrchestratorGateway.ts:59-60`).
- `changeFramedIp(username, ip | null)` — `null` "libera la IP fija y el usuario toma IP del pool" (`:153-158` → `HttpRadiusOrchestratorGateway.ts:89-91`).
- `syncPlan(code, dl, ul, pool?)` escribe `Framed-Pool` en radgroupreply (`:173-177`).
- `listAssignedIps()` (`:185-192`), `IpPool.nasId`/`ipKind` (`schema.prisma:1650-1666`), tabla `radippool` + CRUD `/pools` en el orchestrator (commit `7fe7fb9`).

**Lo único grande que falta del lado infra:** activar el **módulo `sqlippool`** de FreeRADIUS (en r1+r2), con lease sticky y el bypass de Framed-IP.

## Decisión 1 — "Pool por NAS" vive en FreeRADIUS (NAS-IP/huntgroup → `sqlippool`), NO en el backend

**El backend se mantiene BOBO respecto del pool.** La regla del BE es binaria:
- `framedIp = null` → modo pool (FreeRADIUS asigna).
- `framedIp = ip` → modo fijo (pin que bypasea el pool).

El mapeo **NAS → pool** se resuelve **en la config de FreeRADIUS**: por el `NAS-IP-Address` (o un huntgroup que agrupe los NAS de un mismo nodo balanceado), `sqlippool` selecciona el `pool_name` correcto del `radippool`. Así la IP **"sigue al NAS" por construcción**: si el cliente re-autentica por otro NAS, FreeRADIUS toma del pool de ESE NAS sin ninguna intervención del backend.

**Alternativa considerada y DIFERIDA — `Framed-Pool` por usuario (radreply):** que el backend escriba un `Framed-Pool` per-user reflejando el NAS. Da más control al BE pero acopla la "pertenencia de pool" al backend y NO sigue al NAS solo (habría que reescribir el `Framed-Pool` en cada move). Se descarta para Fase 1 a favor de la selección por NAS-IP en FreeRADIUS, que es el patrón ISP/BNG estándar. (Si Phase 0 (d) revela nodos que requieren huntgroups, se modela el huntgroup en FreeRADIUS — sigue siendo config infra, no código BE.)

> **Consecuencia clave:** el BE de Fase 1 es CHICO. No hay endpoint nuevo de "asignar pool"; el pool lo decide FreeRADIUS. El BE solo decide *fijo vs pool* (= ¿hay Framed-IP o no?).

## Decisión 2 — `ipMode` explícito en `PppoeService` (no derivar de `remoteAddress`)

Se agrega `ipMode: 'pool' | 'fixed'` (default `fixed`) a `PppoeService`. **Por qué explícito y no derivarlo de `remoteAddress != null`:** un servicio en modo pool, una vez con sesión, podría tener su IP observada (del accounting) guardada en `remoteAddress` **para mostrarla en la UI** — pero esa IP NO es un pin (no va a radreply). Sin un flag explícito se perdería la distinción "IP fija pineada" vs "IP del pool que casualmente conozco". El flag deja la intención auditable.

| `ipMode` | radreply Framed-IP | `remoteAddress` (DB) | Significado |
|----------|--------------------|----------------------|-------------|
| `fixed` | presente (la IP) | la IP pineada | Pin — bypasea el pool (negocio/pública + los ~2287 legacy) |
| `pool` | ausente | `null` (o IP observada, display-only) | FreeRADIUS asigna del pool del NAS |

**Default `fixed`:** preserva la semántica de las filas existentes (su `remoteAddress` ES su pin). Ningún servicio pasa a `pool` salvo alta nueva en NAS pool-mode o un `unpin` explícito.

## Decisión 3 — Modo pool a nivel NAS: `NasServer.poolName` (opt-in) + pre-check

Se agrega `poolName: String?` a `NasServer`. **`poolName` no nulo ⟺ el NAS está en modo pool** → las altas nuevas en ese NAS default a `ipMode = pool`. Nulo ⟺ comportamiento legacy (el caller pre-elige IP).

**Pre-check al marcar pool-mode:** antes de aceptar `poolName`, el sistema consulta el `radippool` vía el orchestrator (`GET /pools`) y **rechaza** si el pool está vacío / sin IPs libres → evita el escenario "NAS en pool sin pool poblado → cliente sin IP". (El `poolName` del BE debe coincidir con el `pool_name` real del `radippool`/huntgroup de FreeRADIUS.)

## Decisión 4 — Reuso máximo: `CreatePppoeService` gana una rama pool

En `CreatePppoeService` (rama `isRadius`), se decide `framedIp` según el NAS:
- NAS `poolName != null` **y** no se pidió IP fija → `ipMode = pool`, `framedIp = null` (NO se llama `FindFreeIp`).
- NAS legacy o IP fija pedida → `ipMode = fixed`, `framedIp = remoteAddress` (flujo actual intacto).

El resto del use case (guards #4, `pending → provision → enabled`, `ensureInternet`) **no cambia**. La rama no-RADIUS (RouterOS directo) tampoco — Fase 1 es solo RADIUS HA.

## Decisión 5 — IP fija: `PinPppoeIp` / `UnpinPppoeIp` (use cases nuevos)

- **`PinPppoeIp(username, ip)`**: valida la IP (formato + rango gestionado + no tomada, cruzando `listAssignedIps()`); `changeFramedIp(username, ip)`; persiste `ipMode = fixed`, `remoteAddress = ip`.
- **`UnpinPppoeIp(username)`**: rechaza si el NAS del servicio no es pool-mode; `changeFramedIp(username, null)`; persiste `ipMode = pool`, `remoteAddress = null`.

Consistencia DB↔RADIUS: el patrón del repo (primero el plano de control, después confirmar en DB; si el orchestrator falla, propagar el error, nunca un OK mentiroso) — igual que `CreatePppoeService`. Rutas en `pppoe.routes.ts` (gate `pppoe.manage`); errores del orchestrator → 502 (`OrchestratorUnreachableError`).

## Decisión 6 — Infra: `sqlippool` + lease + bypass + replicación HA

| Pieza | Config | Riesgo / mitigación |
|------|--------|---------------------|
| Módulo `sqlippool` | queries contra `radippool` en r1+r2 | **NO levanta FreeRADIUS si está mal** → **staging primero + gate** |
| Lease sticky | `~2 semanas` (mantiene la IP en desconexiones largas) | parametrizable; verificar en staging |
| Bypass fijo | `if (!Framed-IP-Address) { sqlippool }` en `post-auth`/`authorize` | los pinneados y los ~2287 legacy NO tocan el pool |
| Selección NAS→pool | por `NAS-IP-Address` / huntgroup | Phase 0 (d): mapear nodos balanceados |
| Replicación master-master HA | lease en r1 visible en r2 | **riesgo IP duplicada** si la replicación tarda → `pool_key` por cliente + allocación atómica (lock `sqlippool`); validar con auth alternado r1/r2 en staging |

## Flujo — alta en modo pool (sequence)

```
Operador/FE → BE: POST /pppoe { username, nasId(pool-mode), sin IP fija }
BE CreatePppoeService:
  nas = findNasServerById(nasId)        // poolName != null
  ipMode = 'pool'                       // no se llama FindFreeIp
  repo.upsert({..., status:'pending', ipMode:'pool', remoteAddress:null})
  orchestrator.createUser({username, password, plan, framedIp: null})  // ← null = pool
  repo.upsert({..., status:'enabled'})
  ensureInternet(contractId, true)      // sin cambios
--- más tarde, el CPE disca ---
CPE → NAS(pool) → FreeRADIUS auth:
  sin Framed-IP en radreply → sqlippool selecciona pool por NAS-IP → asigna IP libre, sticky
```

## Flujo — pin de IP fija (sequence)

```
Operador/FE → BE: POST /pppoe/:id/pin-ip { ip: X }
BE PinPppoeIp:
  validar X (formato + rango + no en listAssignedIps())
  orchestrator.changeFramedIp(username, X)   // escribe radreply Framed-IP
  repo.update({ ipMode:'fixed', remoteAddress:X })
--- próximo auth ---
  Framed-IP presente → bypass de sqlippool → mantiene X siempre
```

## Hexagonal / DIP

- Use cases (`CreatePppoeService`, `PinPppoeIp`, `UnpinPppoeIp`) dependen del **port** `RadiusOrchestratorGateway` y de `NasRepository`/`PppoeServiceRepository` — **nunca** de tipos de infra.
- El adapter HTTP (`HttpRadiusOrchestratorGateway`) ya mapea `framedIp`/`changeFramedIp` al orchestrator. **No se agregan métodos al port** salvo que Phase 0 (a) lo exija (no se prevé: `createUser`/`changeFramedIp` alcanzan).
- Tests TDD con `InMemory` repos + un fake del gateway (red → green → refactor), modo `pool` **y** `fixed`, para garantizar que el alta fija actual NO se rompe.

## Migración (aditiva)

- `PppoeService`: `+ ipMode String @default("fixed")`.
- `NasServer`: `+ poolName String?` (nullable).
- Migración aditiva (`ADD COLUMN`), sin backfill. Los ~2287 fijos quedan `fixed` por el default → IP intacta.

## Open questions (Phase 0 — ✅ RESUELTAS, recon live 2026-06-26 — ver "Phase 0 — RESULTADOS")

1. **(a)** ¿Alcanza la selección NAS-IP→pool en FreeRADIUS, o el orchestrator necesita exponer `Framed-Pool` por usuario? (Diseño asume NAS-IP en FreeRADIUS → NO hace falta tocar el port). Verificar la config de FreeRADIUS y el Python del orchestrator.
2. **(b)** ¿`sqlippool` exige el pool poblado en `radippool` antes del primer auth? (El pre-check de Decisión 3 lo cubre, pero confirmar el orden de seed).
3. **(c)** **Replicación master-master HA:** medir la latencia de visibilidad del lease r1↔r2; confirmar `pool_key` por cliente + allocación atómica.
4. **(d)** ¿Hay nodos balanceados/redundantes en Acceso Sur/NE8000 que necesiten **huntgroups**? Mapear los NAS-IP de Acceso Sur antes de escribir la config.
5. **Staging:** ¿hay un FreeRADIUS de staging con `radippool` para probar `sqlippool` sin tocar prod? (Dependencia dura del rollout — needs root en las VMs).

---

## Phase 0 — RESULTADOS (recon live read-only en r1 `radius-1`, 2026-06-26)

> Las 5 open questions quedaron RESUELTAS contra el RADIUS HA en vivo (saturno → r1 10.75.0.10, solo SELECT/SHOW/ls/grep).

| # | Pregunta | Resultado verificado |
|---|----------|----------------------|
| (a) | ¿Alcanza NAS-IP→pool en FreeRADIUS? | **SÍ.** Acceso Sur entra por UN solo NAS-IP (`10.75.0.30`, `ne8000_asur` huawei). `sqlippool` elige el pool por `nasipaddress`. NO hace falta `Framed-Pool` por usuario ni tocar el port del orchestrator. |
| (b) | ¿sqlippool exige el pool poblado? | **SÍ, y está VACÍO.** `radippool` existe (schema canónico) con **0 filas**. Poblar el pool de Acceso Sur ANTES del primer auth en modo pool. |
| (c) | Replicación master-master HA | **SANA** (r1 slave de r2, IO+SQL Running=Yes, **Seconds_Behind=0**). Riesgo de carrera de lease → `pool_key` por cliente + allocación atómica (lock `sqlippool`). |
| (d) | ¿Huntgroups? | **NO** para Fase 1 — una sola puerta (`10.75.0.30`). |
| Staging | ¿Hay FreeRADIUS de staging? | **NO EXISTE.** Solo r1 (`radius-1` 10.75.0.10) + r2 (10.75.0.11). Se toca el FreeRADIUS de prod directo. |

### Datos del entorno (verificados en vivo)

- **FreeRADIUS 3.2.1** (NO 4.0 — el link de refs apuntaba a 4.0.0). La config de `sqlippool` se hace para **3.2.x**: módulo `sqlippool` (`mods-available/` → symlink en `mods-enabled/`) + `mods-config/sql/main/<dialect>/queries.conf` (queries de alloc/clear), hooks en `sites-enabled/default` secciones `post-auth` y `accounting`.
- **Binario `rlm_sqlippool.so` INSTALADO** (`/usr/lib/freeradius/`) → se activa sin instalar paquetes.
- **sqlippool COMENTADO** en `sites-enabled/default` (líneas 693 y 833) → descomentar + envolver con el bypass `if(!&control:Framed-IP-Address)`.
- **Tabla `radippool`** schema: `id, pool_name, framedipaddress, nasipaddress, calledstationid, callingstationid, expiry_time, username, pool_key`. `expiry_time` = el lease sticky (2 sem); `pool_key` = clave de allocación atómica.
- **2230** `Framed-IP-Address` en `radreply` (los fijos legacy) → todos bypasean el pool (intactos).
- Tabla `nas`: `acceso_sur`(10.60.0.38 mikrotik legacy), **`ne8000_asur`(10.75.0.30 huawei ← Fase 1)**, `rda1_mercedes`(10.60.0.50), `rda2_mercedes`(10.60.0.54).
- ⚠️ El `ls` de `mods-available/enabled` SIN sudo dio vacío = artefacto de permisos (`root:freerad 0750`), NO ausencia real. Confirmar con sudo al escribir la config.

### Decisión 7 — SIN staging: red de seguridad `freeradius -XC` / `-X` (reemplaza el gate de staging)

No hay staging → el gate "validar sin tocar prod" se hace EN r1/r2 SIN restartear el daemon productivo:
1. **`freeradius -XC`** — config-check: valida la sintaxis del nuevo config **sin arrancar**. Si sqlippool está mal, falla ACÁ, con el servicio de prod corriendo intacto en 1812/1813.
2. **`freeradius -X` en puerto de prueba** — instancia debug; auth de un **usuario de PRUEBA** (NUNCA un cliente real) → confirmar que toma IP del pool + que un usuario con Framed-IP la mantiene (bypass).
3. Recién con (1) verde + (2) OK → **ventana de mantenimiento** + **`mysqldump` de `radius`** (backup) + restart del servicio real, **rolling r1→r2** con healthcheck, **rollback listo** (re-comentar sqlippool + restart).

### Decisión 8 — Poblar `radippool` EXCLUYENDO los fijos del rango (anti-colisión)

El pool de Acceso Sur es `asur-cgnat` 100.64.10.0/24. PERO los Framed-IP fijos que caen en ese CIDR **NO pueden estar en `radippool`** (si sqlippool entrega una IP ya pineada fija a otro user → colisión). Al poblar:
- Insertar el rango del pool MENOS: las `framedipaddress` ya usadas como fijas en `radreply` dentro del CIDR + gateway + network + broadcast.
- El `POST /pools` del orchestrator crea desde CIDR — **verificar/extender** para que excluya las fijas existentes (o calcular el set excluido antes de poblar). Confirmar en Phase 1.
