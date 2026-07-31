# Workflow multi-repo — IPNext (Prominense)

> Cómo se trabaja sobre los repositorios del sistema. Documenta el flujo real,
> verificado en producción. Última actualización: 2026-07-25 (+ repo Rust `ipnext-noc-collector`).

## Repos

| Repo | Ruta local | Remote | Qué es |
|------|-----------|--------|--------|
| **Backend** | `C:\Users\ronald\projects\ipnext\ipnext-backend` | `github.com/rhernandezbas/ipnext-backend` | Node + TS + Express + Prisma + PostgreSQL (hexagonal) |
| **Frontend** | `C:\Users\ronald\projects\ipnext\ipnext-frontend` | `github.com/rhernandezbas/ipnext-frontend` | React 18 + Vite + TanStack Query + CSS Modules |
| **RADIUS Orchestrator** | `C:\Users\ronald\projects\ipnext\freeradius-orchestrator` | `github.com/rhernandezbas/freeradius-orchestrator` (**PRIVADO**) | Python 3.11 + FastAPI + SQLAlchemy async (hexagonal) sobre FreeRADIUS HA. Importado a git el **2026-06-18** (antes vivía untracked en `/tmp` de radius-1). Lo consume el **Backend** por REST (`HttpRadiusOrchestratorGateway` → VIP `10.75.0.20:8080`). |
| **NOC Collector (Rust)** | `C:\Users\ronald\projects\ipnext\ipnext-noc-collector` | `github.com/rhernandezbas/ipnext-noc-collector` (**PRIVADO**) | **Rust** (tokio + reqwest + serde). Sensores de FIBRA del NOC: poll de señal óptica (SmartOLT), análisis por PON, watchdog de OLTs, seed OCR (stub). Creado el **2026-07-24** (change `noc-alerts-hub` Fase E). Corre en la **VM 130 `flow-colector` (`10.75.0.40`, VLAN 75)** y **empuja** alertas al Backend (`POST /api/alerts/ingest/fiber-collector`); lee sus umbrales del hub (`GET /api/alerts/thresholds`). |
| **Customer App (mobile)** | `C:\Users\ronald\projects\ipnext\ipnext-customer-app` | `github.com/rhernandezbas/ipnext-customer-app` (**PRIVADO**) | **Expo + React Native + TypeScript** (SDK 57, RN 0.86, expo-router, TS strict). App de **CLIENTES finales** del ISP: saldos, facturas, planes, reclamos, órdenes de servicio. Android primero, iOS después. Creado el **2026-07-29** desde CERO (la app mobile anterior quedó legacy y se descarta). Consume el **Backend** por REST en **`https://app.prometheus-alpha.xyz/api/portal/*`** (JWT `aud=portal` separado del admin, toda query anclada al `clientId` DEL TOKEN). **EN PROD y funcionando en un teléfono real desde el 2026-07-31.** |

Los cinco viven uno al lado del otro bajo `C:\Users\ronald\projects\ipnext\`.

> **El RADIUS Orchestrator YA sigue el modelo `push = deploy` de BE/FE (desde 2026-06-18).** Es Python y corre en las VMs de **VLAN 75** (radius-1 `10.75.0.10` + radius-2 `10.75.0.11`, master-master, VIP `10.75.0.20:8080`) — **NO** en el host `.37`. **CI/CD montado (2026-06-18)**: runner self-hosted `asterisk-orch` en `.37` (`/opt/actions-runner-freeradius-orchestrator`) + `.github/workflows/deploy.yml` con job `test` (`pytest` en venv reusable `/home/ronald/orch-ci-venv`, `pip install -e '.[dev]'`) → job `deploy` (`needs: test`, rolling r1→r2 con healthcheck vía `deploy/deploy-to-vms.sh`; SSH key `/home/ronald/.ssh/orch_deploy` pasada por path absoluto en `env: ORCH_DEPLOY_KEY` porque el runner systemd NO setea HOME; sudoers acotado en r1/r2 a pip del venv + `systemctl restart radius-orchestrator`). El servicio corre del venv (`/opt/radius-orchestrator/venv/bin/radius-orchestrator`, systemd `radius-orchestrator`). **Acceso manual** (debug): hub por `.37` → `claude@10.75.0.1{0,1}` (creds en engram, NO acá). **Gate de seguridad**: como deploya a AAA en prod, **el push se confirma explícitamente** igual que BE/FE. El gate de `pytest` (deploy `needs: test`) ya cazó un bug pre-existente (pool_size/sqlite). Hoy el HA NO sirve routers en prod (todos en `/ppp secret` local o RADIUS legacy) → un restart tiene blast radius ~0.

> **El NOC Collector (Rust) NO sigue todavía el modelo `push = deploy`** (a diferencia de BE/FE/orchestrator). Estado al **2026-07-25**: `.github/workflows/deploy.yml` tiene job **`ci` en `ubuntu-latest`** (`cargo fmt --check` → `cargo clippy -- -D warnings` → `cargo test` → `cargo build --release` → **`upload-artifact` del binario**) y el job **`deploy` es un STUB no-op** (faltan runner self-hosted + key de deploy versionada). **El deploy hoy es MANUAL y así se documenta**: `gh run download <run> -n ipnext-noc-collector-binary` → `scp` a la VM 130 (jump por el `.37`) → `/usr/local/bin/ipnext-noc-collector` + `EnvironmentFile=/etc/nochub-collector.env` (600) + unit `nochub-collector.service`. **OJO — sin toolchain Rust local**: el TDD se valida **por CI** (commit → push de la branch → `gh run watch` hasta verde), NO con `cargo test` local. **Regla dura de la VM 130**: es el CEREBRO del NOC (FastNetMon/exabgp/Akvorado/watchdogs/`fnm_bot`) — **SIEMPRE `sudo maint start colector --dur Nm` ANTES de tocar cualquier servicio** ahí (sino los vigías disparan una lluvia de falsas alertas al Telegram del NOC) y `sudo maint end colector` al terminar. El colector corre en **modo SHADOW** (`NOC_SHADOW=true`: lee Influx, NO escribe) conviviendo con los scripts Python de fibra — **el cutover que los apaga es un evento aparte con OK explícito del usuario**.

> **La Customer App (mobile) NO sigue el modelo `push = deploy`** — una app mobile no deploya a un container: se builda un **AAB/APK** y se distribuye por las **stores**. `.github/workflows/ci.yml` corre `ci` (`npm ci` + `typecheck` + `lint`) en el runner self-hosted **`prominense-app`** del `.37` en cada push (cero riesgo, no toca prod — pushear NO requiere el gate de confirmación de BE/FE). El **build del AAB es MANUAL** (`workflow_dispatch`, job `build-android`: `expo prebuild` + `gradlew bundleRelease` + artifact) usando el **toolchain del `.37`** (JDK 17 en `/usr/lib/jvm/java-17-openjdk-amd64` + Android SDK 36 en `/opt/android-sdk` — decisión del usuario 2026-07-29: builds en el runner, NO EAS Build). El firmado con la upload key de Play Console queda para la fase de publicación (secrets `ANDROID_KEYSTORE_*` via `gh secret set`); para el iOS futuro hará falta una Mac o EAS Build. **Compliance stores (investigado 2026-07-29)**: Google exige **target API 36 desde 2026-08-31** (el SDK 57 de Expo ya lo cubre), **borrado de cuenta in-app + URL web**, Data Safety form y privacy policy URL; Apple exige account deletion in-app (5.1.1(v)), privacy nutrition labels y cuenta demo de review. **✅ El blocker de TLS está RESUELTO (2026-07-31)**: la API vive en `https://app.prometheus-alpha.xyz` (Traefik + Let's Encrypt del EasyPanel del `.37`, ruta en `/etc/easypanel/traefik/config/app-clientes.yaml`). Detalle completo en la card del EPIC en `BACKLOG.md`.

> ### ⚠️ Reglas DURAS del repo de la app (aprendidas a los golpes — leer antes de tocar)
>
> 1. **JAMÁS un archivo de test bajo `src/app/`.** Ese es el routes dir de expo-router: `require.context` mete TODO lo que hay ahí en el bundle. Con tests adentro, el **build de release NO COMPILA** (`@testing-library` importa módulos de Node) y, si compilara, empaquetaría el código de test dentro del APK del cliente. Los tests van a `src/__tests__/` — hay un **guard** (`no-test-files-in-app.test.ts`) que falla si alguien lo reintroduce.
> 2. **El build de release es una capa de verificación PROPIA, no un trámite.** 371 tests + tsc + lint + 2 revisores adversariales daban verde con la app **imposible de buildear**. Antes de dar por terminado cualquier cambio: `npx expo export --platform android --no-bytecode` y grepear el bundle (`@testing-library|describe\(|jest\.mock` debe dar **0**).
> 3. **El puerto de la API es una decisión de ALCANCE.** La API estuvo en `:8291` — que es el puerto **Winbox de MikroTik**, filtrado por default en muchísimas redes domésticas/CPE tras las campañas de explotación (CVE-2018-14847). La app colgaba en la casa del usuario y andaba en la oficina. **Todo lo que consumen clientes finales va por 443 con TLS**, nunca por un puerto alto.
> 4. **Todo request tiene timeout.** Un `fetch` sin `AbortController` que se cuelga = spinner infinito (el `finally` que apaga el loading nunca corre). El cliente HTTP usa 15 s y un `kind:'timeout'` propio con copy accionable.
> 5. **Jest en Windows**: la suite COMPLETA es **`npm test` sin argumentos**. Los paths por directorio son SOLO para corridas focalizadas y **un listado parcial da verde ENGAÑOSO** (la guía vieja decía `src/lib src/features src/app` y se salteaba `src/components` y `src/constants` — los tests de contraste del theme nunca corrían). NUNCA `--testPathPattern` (cuelga). Y los patterns posicionales son **regex**: `(auth)` sin escapar NO matchea y los tests **no corren** pareciendo verdes. **Las tres formas de "verde falso" de este repo son la misma familia: el test que no corre.**

**Regla base**: cada repo es independiente. **Commits independientes por repo**, nunca commits que crucen dos repos. Cada feature que toca BE y FE (o BE y el colector Rust) se trabaja como cambios coordinados (uno por repo), con su commit en cada uno. **Contratos cross-repo**: cuando el contrato HTTP entre repos cambia (ej. la ruta de ingesta pasó de `/api/alerts/ingest` a `/api/alerts/ingest/:source`), el cambio se documenta en el `design.md` del change y se **sincroniza el consumidor en el MISMO batch** — un contrato driftado entre repos no lo caza ningún gate (los tests de cada repo mockean al otro).

> ### 🔗 `/api/portal/*` es un contrato PÚBLICO — romperlo rompe teléfonos ajenos (2026-07-31)
>
> El BE y el FE se deployan JUNTOS: si cambiás un DTO y actualizás el front en el mismo batch, nadie se entera. **Con la app mobile eso NO aplica**: el cliente tiene una versión INSTALADA en su teléfono que vos no controlás y que puede tardar semanas en actualizarse (o nunca). Un campo renombrado en `/api/portal/*` deja la app **rota en la mano del cliente**, sin forma de arreglarlo desde el server.
>
> **Reglas innegociables para tocar `/api/portal/*` (o cualquier cosa que la app consuma):**
> 1. **Los cambios son ADITIVOS.** Agregar campos, sí. Renombrar/borrar/cambiar el tipo de un campo, NO — salvo que se decida explícitamente romper y se coordine el release de la app.
> 2. **Antes de tocar cualquier DTO del portal, grepear el consumidor**: `rg "<campo>" ../ipnext-customer-app/src` — si la app lo usa, el cambio es coordinado o no va. (Los repos viven uno al lado del otro justamente para esto.)
> 3. **El cambio coordinado se planifica con el contrato ESCRITO campo por campo en los DOS prompts/changes** (BE y app), como se hizo con `balances[]` y con `franja`→`timeSlot`.
> 4. **Ventana de gracia**: si un campo tiene que morir, primero se agrega el nuevo, sale la app que lo usa, y RECIÉN DESPUÉS se borra el viejo — nunca los dos pasos en el mismo deploy.
> 5. **Todo cambio del portal se verifica EN VIVO contra prod** (curl del endpoint real), no solo con tests: los tests mockean el HTTP y no ven un mismatch de envelope (lección `e2e-envelope-mock-mismatch`).
>
> **Precedente que lo justifica**: en la v1, `/me` devolvía un `balance` plano; se cambió a `balances[]` por moneda. Se pudo hacer sin drama **porque la app todavía no estaba publicada**. Con la app en la Play Store, ese mismo cambio habría dejado la pantalla de Inicio en blanco para todos los clientes hasta que actualizaran.

## Deploy — push = producción

**BE / FE / orchestrator** tienen `.github/workflows/deploy.yml` con un runner **self-hosted**. Hacer `git push` a `main` **auto-deploya a PRODUCCIÓN**. No hay staging. *(Excepciones: el **NOC Collector (Rust)** todavía NO — su `deploy` es un stub y el deploy es manual; y la **Customer App (mobile)**, que por naturaleza no deploya a container — CI por push + build AAB manual; ver las notas de arriba.)*

- **Backend**: `docker build` → step **`Run DB migrations`** (`docker run … npx prisma migrate deploy` con `secrets.DATABASE_URL`) → deploy container → verify. El `Dockerfile` también corre `npx prisma migrate deploy && node dist/main.js` en el `CMD` (idempotente). Si una migración falla, el job se cae (**fail-fast**) y prod no se actualiza.
- **Frontend**: `docker build` → deploy container → verify. App pública en `http://190.7.234.37:7778`.
- **NOC Collector (Rust)**: solo `ci` (fmt/clippy/test/build + artifact del binario) en `ubuntu-latest`; **deploy MANUAL** a la VM 130 (`maint start` → scp → systemd `nochub-collector`). Pushear una **branch** solo dispara el CI (cero riesgo, no toca prod) — por eso el TDD-por-CI de este repo NO requiere el gate de push del usuario; lo que sí lo requiere es el **deploy manual a la VM**.

**Gate de seguridad (innegociable)**: como el push deploya a prod, **el push se confirma explícitamente cada vez**. Se preparan y commitean los cambios localmente, pero el `git push` requiere OK del usuario, change por change.

### Sincronizar el `main` local tras cada cambio (INNEGOCIABLE)

> **Cada card del `BACKLOG` que llega a `origin/main` DEBE terminar dejando el `main` LOCAL de AMBOS repos (BE + FE) sincronizado con `origin/main`.** El cambio NO está cerrado hasta que el local quedó actualizado.
>
> **Por qué (incidente real, 2026-06-25):** el push se hace desde un **worktree** o con `git push origin <sha>:main` (técnica usada p.ej. en el EPIC NasType para no tocar el checkout sucio). Eso avanza `origin/main` pero **NO mueve el ref `main` del checkout local** → el `main` local quedó **STALE 22 commits atrás**: el código del feature (RadiusAuthEvent, ingest, endpoint) **ni existía localmente**, y una exploración arrancó leyendo versiones viejas y grepeando archivos que ya no estaban donde el código creía. Se perdió tiempo y casi se trabaja sobre código ya superado en prod.
>
> **Cómo (al cerrar cada card, en BE y FE):**
> ```
> git fetch origin
> git checkout main
> git merge --ff-only origin/main        # fast-forward si el local no diverge
> # si el main local trae commits de worktree YA superseded en origin (no es ancestro):
> #   git reset --hard origin/main        # SOLO tras verificar que son superseded (backup primero)
> git rev-parse main == origin/main      # verificar que quedaron iguales
> ```
> **Regla:** antes de explorar/codear cualquier cosa nueva, confirmar `main local == origin/main` (`git rev-list --count main..origin/main` == 0) en los dos repos. Si difiere, sincronizar PRIMERO. **El local stale es una fuente silenciosa de bugs: se explora y se "arregla" código que en prod ya cambió.**
>
> **Doc-only en `main` → se PUSHEA, no se acumula local (decisión del usuario, 2026-06-25).** Los cambios doc-only que se editan directo en `main` (`BACKLOG.md`, `WORKFLOW-MULTI-REPO.md`, `.gitignore`) NO se dejan commiteados solo-local: se **pushean** para que `origin` quede como fuente de verdad y el `main` local no diverja. Un commit local-ahead es la otra cara del problema de staleness — el `BACKLOG`/`WORKFLOW` "vive en origin"; si queda solo local, la próxima sesión no lo ve (o lo pierde en un sync). Sí, el push del BE dispara un deploy, pero doc-only = **blast radius ~0** (rebuild + `migrate deploy` no-op + swap de container, sin cambio de runtime). El push igual se confirma con el usuario (gate), pero para doc-only el default es **pushear ya** y dejar `main local == origin`.

## Base de datos

- La DB de prod vive en una **red Docker interna de EasyPanel** (`easypanel-bd_owners`, host interno `bd_owners_splynx-repli:5432`, base `test`). **NO es accesible desde afuera** (un intento directo a la IP pública da `P1001`). Por eso no se necesita —ni se puede— conexión directa: las migraciones llegan vía deploy.
- El `.env` local apunta a `localhost:5432` (entorno de desarrollo), no a prod.

### Migraciones — reglas de oro

1. **A prod SIEMPRE con `prisma migrate deploy`** (lo corre el pipeline). **NUNCA `prisma migrate dev` contra prod** — puede detectar drift y ofrecer un reset destructivo que borra la base.
2. **Generar el archivo de migración sin DB local**: como no hay DB de dev accesible, se genera el SQL con
   ```
   git show HEAD:prisma/schema.prisma > /tmp/before.prisma
   npx prisma migrate diff --from-schema /tmp/before.prisma --to-schema prisma/schema.prisma --script
   ```
   (Prisma 7 usa `--from-schema` / `--to-schema`.) Se revisa el SQL y se crea el archivo en `prisma/migrations/<timestamp>_<nombre>/migration.sql`. Timestamp posterior a la última migración.
3. **Aditivas** (`ADD COLUMN`, `CREATE TABLE`) → seguras, se pushean directo.
4. **Destructivas / transformación de datos** (ej. enum → FK) → migración **escrita a mano** (excepción justificada a "no editar SQL"), **transaccional y con guard**:
   - agregar columna nueva nullable → backfill → `DO $$ … RAISE EXCEPTION` si quedan filas sin mapear (rollback total, prod intacto) → recién entonces `NOT NULL` + `DROP`.
   - Antes de pushear, se **revisa el SQL completo** con el usuario.
5. **Seed de catálogos** → vía **migración idempotente**, NO solo en `seed.ts`. El deploy corre `migrate deploy` pero **no** `prisma db seed`, así que los datos canónicos deben bootstrappearse en una migración:
   ```sql
   INSERT INTO "Tabla" (...) VALUES (...) ON CONFLICT ("name") DO NOTHING;
   ```
   (patrón `ON CONFLICT (columna) DO NOTHING`, nunca `ON CONFLICT ON CONSTRAINT <indice>`).

## Proceso — SDD OBLIGATORIO (siempre)

> **TODO cambio pasa por SDD** (decision del usuario, 2026-06-20), grande o chico — NUNCA el "flujo directo" (codear sin specs). Flujo: **explore -> proposal -> specs -> design -> tasks -> apply -> `sdd-verify` -> archive**, con artefactos en `openspec/`. El plan (proposal/specs/design/tasks) se hace y se CONFIRMA con el usuario ANTES de implementar; `sdd-apply` produce el codigo; `sdd-verify` (matriz de spec-compliance: cada scenario con su test verde) corre ANTES del push; `sdd-archive` al cerrar. **SDD Init Guard**: antes de arrancar cualquier change, verificar que `sdd-init` se corrio para el proyecto (si no, correrlo). Esto ELEVA a regla universal las menciones condicionales de SDD ("en cambios SDD...") que aparecen mas abajo: ya no es condicional, es para todo cambio. Y el **review adversarial** (sección "El loop fix→review", abajo) tambien es OBLIGATORIO para TODO cambio, no solo los riesgosos: lo que escala por riesgo es el TAMAÑO del review, nunca el SI.

## Trazabilidad — BACKLOG OBLIGATORIO (siempre)

> **REGLA INNEGOCIABLE (decision del usuario, 2026-06-23): TODO pasa por el `BACKLOG.md`.** Dos obligaciones, sin excepcion:
>
> 1. **LEER `BACKLOG.md` SIEMPRE antes de tocar nada.** Al arrancar cualquier sesion o cambio —y tras cada compactacion— se lee `BACKLOG.md` PRIMERO. Es la fuente de verdad del estado del trabajo: evita duplicar lo ya hecho, pisar un cambio en vuelo de una sesion paralela, o perder el contexto de lo pendiente. No hay "ya me acuerdo": se lee.
> 2. **CADA cambio —por minimo que sea— crea/actualiza su CARD en `BACKLOG.md`.** Feature, fix, refactor, ajuste de una linea, doc, config: NO hay cambio sin card. Se crea la card ANTES de empezar (estado `PENDIENTE`/`EN PROGRESO`) y se actualiza al cerrar (`✅ HECHO Y EN PROD` con sus PRs). Esto da TRAZABILIDAD total: todo lo que se toca queda registrado, fechado y con su contexto. **Sin card, el cambio no existe.**
>
> **El `BACKLOG.md` de ESTE repo es el del ECOSISTEMA COMPLETO (decisión del usuario, 2026-07-31).** Cubre los CINCO repos —backend, frontend, orchestrator, NOC collector y **la Customer App**—, no solo el backend. Un cambio en la app mobile (pantallas, contrato que consume, build, publicación) lleva su card acá igual que uno del BE. Motivo: son un solo producto y las decisiones se cruzan — el saldo que se arregló en el BE cambió lo que muestra la app, y el puerto de la API dejó la app colgada; si cada repo llevara su propio backlog, esa relación se pierde y la próxima sesión no la ve. Los artefactos SDD sí viven en el repo que se toca (`ipnext-customer-app/openspec/changes/...` para changes de la app).
>
> 3. **Espejo navegable en Obsidian — VISTA + capa de IDEACIÓN, se MANTIENE ACTUALIZADO SIEMPRE (decision del usuario 2026-06-27 — ACTUALIZA la de 2026-06-26 "on-demand").** Existe un vault Obsidian en `C:\Users\ronald\Documents\IPNext\Backlog\` (LOCAL, NO versionado) con una nota por card + `_Backlog (MOC).md` + `Ideas.md`, interconectado con `[[links]]` a TODO el ecosistema (`[[RADIUS]]`, `[[Arquitectura]]`, `[[NE8000]]`, `[[Cutover RDA2]]`, `[[Deudas]]`, ...). **La FUENTE DE VERDAD sigue siendo `BACKLOG.md` en el repo** (git): es lo que leen el workflow y los sub-agentes — el vault local NO lo ven, y **NUNCA** se borra el `BACKLOG.md` para "migrar a Obsidian" (rompería la trazabilidad compartida/versionada). **Dos obligaciones (2026-06-27, SUPERSEDEN el "on-demand, no obligatorio" de ayer):** (a) **MANTENER el vault SIEMPRE al día** — al cerrar cada card/batch se refleja el cambio en su nota (crear/actualizar/**borrar** la nota si se quitó la card) + el `_Backlog (MOC).md`; no se deja stale. (b) **GENERAR IDEAS cruzando TODO el ecosistema** — usar el grafo para conectar las cards con los nodos de infra/arquitectura/RADIUS/deudas y curar `Ideas.md` con propuestas que SURGEN de cruzar el ecosistema (no solo lo que ya está en el BACKLOG). El vault es la capa de IDEACIÓN activa, no un archivo muerto: la fuente de verdad es el BACKLOG, pero las IDEAS nuevas nacen navegando el grafo en Obsidian y, cuando maduran, bajan a una card del BACKLOG.
>
> **Formato de card** (espeja el estilo ya usado en `BACKLOG.md`):
> ```markdown
> ### [TIPO] titulo corto — ESTADO *(fecha, contexto/PR)*
> > Descripcion: QUE se hace, POR QUE, alcance (BE/FE/orchestrator), decisiones a confirmar, archivos clave.
> ```
> - **TIPO**: `[FEAT]`, `🐛 [BUG]`, `[BUG→FEAT]`, `[REFACTOR]`, `[DOC]`, `[CONFIG]` — segun corresponda.
> - **ESTADO**: `PENDIENTE` → `EN PROGRESO` → `✅ HECHO Y EN PROD` (o `EN PROD`). Se ACTUALIZA la card existente al avanzar, NO se crea una nueva por cada paso.
> - **fecha** en calendario AR; **contexto** = pedido del usuario / hallazgo de review / PR (`BE #NNN / FE #NNN`).
> - El `BACKLOG.md` se edita **directo en `main`** (es doc de proceso — misma excepcion que este archivo, ver "Reglas para agentes").

## Verificación

> **REGLA DE ORO — INNEGOCIABLE: VERIFY ANTES DE DEPLOY.** Nunca pushear/mergear a `main` (= producción)
> sin antes correr el **verify completo**: suite de tests completa + `tsc --noEmit` (BE) / `typecheck` (FE)
> y, en cambios SDD, **`sdd-verify`** con su matriz de spec-compliance (cada scenario probado por un test que
> pasó). **El verify es donde se cazan los bugs ANTES de que lleguen a prod** — el deploy va recién cuando el
> verify está en verde. Saltarse el verify (commit→deploy directo) = bug en producción. Orden obligatorio:
> **codear → verify (verde) → commit → push/deploy → confirmar el run en `gh`.**

- **El estado de cada deploy se revisa con `gh`** — fuente de verdad del pipeline. Tras pushear, se sigue el run con `gh run list` / `gh run watch` / `gh run view <id> --log` para confirmar que el job quedo verde (incluido el step `Run DB migrations`). No se asume "deployo bien" sin mirar el run en `gh`.
- Para backend sin UI todavia, basta el run verde en `gh` + el log del step de migraciones.
- Para features con UI, ademas se verifica con **Playwright** contra la app real (`http://190.7.234.37:7778`, login admin): se recorre el flujo real (crear/editar/borrar) y se limpian los datos de prueba. **Credenciales del user de debug (`superadmin`) para ese login: en [`CREDENCIALES-LOCAL.md`](./CREDENCIALES-LOCAL.md) (gitignored, NO commiteado — la clave NUNCA va en este archivo) y en engram. La pagina "Gestion de red" (NAS/pools/sesiones) esta en `/admin/networking/routers/list`.**

### Testear el SEAM completo, no solo las puntas (lección #28/#27)

Cuando un dato cruza capas (control FE → URL/query → ruta → use case → repo), los tests por capa pueden dar todos verde con la feature ROTA: los tests de ruta **mockean** el use case, los tests de filtros pegan **directo al repo**, y el passthrough del medio queda sin cobertura. Pasó dos veces el 2026-06-07:

- **#28 (BE)**: `ListTickets` reconstruía el query campo a campo y descartaba `assigneeId`/`from`/`to` — el #25 cableó la ruta y el repo, el verify dio verde, y el filtro nunca llegó al `where`.
- **#27 (FE)**: `useTasksFilterUrl` whitelisteaba la priority de la URL contra el **enum legacy** (`low/normal/high/urgent`) cuando el select manda los **names del catálogo editable** (`Baja/Alta/...`) → todo valor real parseaba a `undefined`. El BE estaba perfecto de punta a punta.

Reglas:

1. **Todo filtro/param nuevo lleva al menos un test que recorre el viaje completo**: en BE, use case REAL + repo in-memory (no mockear el use case); en FE, el hook de URL/estado real (round-trip: set → URL → read).
2. **Ojo con los validadores del contrato viejo en el medio del viaje**: whitelists de enums legacy, tipos del mock original (`assignedTo:number` vs `assigneeId:string` del BE), campos renombrados (`message` vs `description`). Si el valor está respaldado por un **catálogo editable**, NUNCA validarlo contra una lista hardcodeada.
3. **Si un passthrough reconstruye el objeto campo a campo, es un punto de fragilidad**: cada campo nuevo hay que agregarlo a mano. Preferir pasar el objeto entero (como hace `ListTasks`) o, si se reconstruye, testear el forwarding de CADA campo.

### El loop fix→review hasta CLEAN (caso de práctica — EPIC #38)

El verify (suite + tsc + sdd-verify) NO alcanza para cambios que mutan datos reales. En el EPIC #38
(7 waves de inventario, 2026-06-09), **TODAS las waves con review adversarial encontraron bugs
FIX-FIRST que el verify había dado por verdes**. El loop que los cazó:

```
codear → verify (suite + tsc, corrido POR EL ORQUESTADOR, no confiar en el reporte del agente)
       → review adversarial (1-4 agentes opus según riesgo, focos distintos, prompt "asumí que hay bugs")
       → fix wave (TDD: test que falla primero, después el fix)
       → re-review FOCALIZADA de los fixes (¿correctos? ¿completos? ¿rompieron algo nuevo?)
       → CLEAN → commit → dry-run rolled-back de la migración vs prod → deploy
```

**El review adversarial es OBLIGATORIO para TODO cambio** (decision del usuario, 2026-06-20): lo que se calibra por riesgo es el TAMAÑO, no el SI — el piso es **1 revisor focalizado SIEMPRE** (incluso FE puro / aditivos / docs). Para cambios riesgosos, **4 revisores** con focos separados (migración/staging ·
mutación/concurrencia · tests · wiring/contrato) para waves que mutan stock (W4, W6); **1 revisor
focalizado** para waves aditivas/clones (W5a, W5b); el loop corre las veces que haga falta (la W1
necesitó 5 olas de fix + 3 análisis hasta IMPECABLE).

Casos reales que el verify NO vio (todos con suite verde y tsc limpio):

- **W6 — feature muerta en prod**: el apply cableó las rutas pero NO inyectó el hook `StageMaterialDeduction`
  en los dos canales de consumo en `app.ts`. Los params eran opcionales y los tests inyectan su propio
  wiring → CI verde, prod muerto. Regla derivada: **el wiring de `app.ts` se verifica a mano contra el
  diseño, y se pinea con un composition-root test** (assertions estáticas sobre el código fuente de app.ts).
- **W6 — contrato BE↔FE driftado**: el FE (construido desde el spec) esperaba `materialName`/`taskSeq`/
  `consumptionId`; el BE devolvía la entidad cruda → la página renderizaba filas en blanco. Regla derivada:
  cuando BE y FE se construyen en paralelo, **el wire contract va explícito y campo por campo en AMBOS
  prompts**, y el review incluye un foco de contrato.
- **W6 — TOCTOU teatral**: el re-check de stock "dentro de la tx" leía por un repo NO transaccional
  (el slot no estaba rebindeado en el UnitOfWork). Los tests in-memory no lo podían ver (su repo ES el
  store compartido). Lo cazó el revisor de concurrencia trazando los clientes Prisma.
- **W5b — el clon pierde piezas**: clonar W5a "mecánicamente" dropeó los tests de RUTA de stock/issue
  que el original sí tenía, y la race P2002 de plate caía a 500. Regla derivada: al clonar, **diffear la
  cobertura del clon contra la del original**, no solo el código.

Reglas operativas del loop:

1. **El orquestador corre el gate por su cuenta** (suite completa + tsc en ambos repos). Los sub-agentes
   reportan números que a veces no corrieron, o corrieron sobre un subconjunto.
2. **Los revisores NO fixean** (reportan con file:line + escenario de fallo); el fix wave es un agente
   aparte con TDD estricto. Separar el ojo del bisturí.
3. **Después del fix wave, SIEMPRE re-review focalizada** — un fix puede introducir el bug siguiente
   (en W6 el fix de `updateStatus` dejó `return updated!` que no tiraba; lo cazó la re-review).
4. **CLEAN es el único estado que habilita el commit.** "Casi clean" no existe.

## Reglas para agentes / asistentes de IA

- **Sesión principal = ORQUESTADOR, siempre disponible (INNEGOCIABLE, decisión del usuario 2026-07-16).** La sesión interactiva principal NO implementa código inline: COORDINA. Todo cambio que el usuario pase se delega a **sub-agentes** que trabajan cada uno en su **worktree dedicado** (regla de worktrees de abajo), mientras el hilo principal queda **LIBRE** para recibir nuevos pedidos, responder y sintetizar — el usuario va pasando cambios de a varios y el orquestador los encola/paraleliza (cuando no colisionan en archivos). El orquestador: (1) crea la card del BACKLOG y el worktree del cambio; (2) delega exploración/plan/apply/review a sub-agentes; (3) corre los GATES por su cuenta (suite + tsc — en **background** para no bloquearse; sigue vigente "no confiar en el reporte del agente"); (4) sintetiza y pide al usuario las confirmaciones (plan SDD, push). Lo único que el orquestador hace inline: docs de proceso (BACKLOG/WORKFLOW), `git`/`gh` de estado, verificaciones rápidas en prod, y ediciones atómicas triviales. **Regla de avance (decisión del usuario 2026-07-16, "si no hay nada bloqueante no me preguntes y arrancá"):** si un plan SDD cierra SIN preguntas bloqueantes, el apply arranca SOLO — al usuario se le pregunta únicamente cuando hay una decisión REAL que tomar (bloqueante del plan, semántica de negocio, o infra crítica tipo AAA/migración destructiva). Los deploys con TODAS las validaciones verdes también salen solos (permiso 2026-06-10 + ratificado hoy); lo que NUNCA se saltea es el loop de calidad (TDD → review adversarial → fix → re-review CLEAN → gate).
- **SIEMPRE worktree, NUNCA sobre `main` directo (INNEGOCIABLE).** Todo trabajo de **código** (feature, fix, refactor) se hace en un **worktree dedicado por cambio**, jamás editando/implementando sobre el working tree de `main`. El `main` local queda limpio y solo avanza por merge/pull. *(Única excepción: los docs de proceso — este archivo y `BACKLOG.md` (que incluye la sección "🔧 Deudas conocidas") — se editan directo en `main`.)*
  - **Un worktree por cosa**, en el repo que corresponde: `<repo>/.claude/worktrees/<name>-<be|fe>`, branch `feat/<name>` o `fix/<name>` derivado de `main`, con **junction de `node_modules`** (`New-Item -ItemType Junction` en PowerShell — instantáneo, reusa el del repo principal). *(El **NOC Collector (Rust)** y el **orchestrator** NO tienen `node_modules` → sin junction; en el Rust se trabaja con branch directa + PR y el gate es el CI, así que el worktree es opcional ahí.)*
  - **Crear el worktree con path ABSOLUTO** (no relativo: el cwd persistido del shell los anida mal) y **branchear desde el SHA explícito de `main`** (`MAIN=$(git -C <repo> rev-parse main)`), NO desde el nombre `main`: hay sesiones en PARALELO moviendo `main`, y un `worktree add … main` puede agarrar un commit en flujo (cazado el 2026-06-14 — el worktree quedó en un merge de otra branch).
  - **Verificar SIEMPRE el HEAD recién creado**: `git -C <worktree> rev-parse HEAD` == el SHA de `main` esperado. Si quedó mal: `git -C <worktree> reset --hard $MAIN` (NO borres el worktree — un `rm -rf` que sigue el junction de `node_modules` puede borrar el `node_modules` REAL del repo principal).
  - **BORRAR un worktree (cleanup) — MÉTODO SEGURO OBLIGATORIO.** Cazado el 2026-06-24: un `git worktree remove --force` con el junction `node_modules` PRESENTE RECORRIÓ el junction y VACIÓ el `node_modules` REAL del BE (485 paq → 0, síntoma "Filename too long" durante el remove). `git worktree remove` **también** sigue el junction, igual que `rm -rf` — NUNCA lo corras con el junction presente. Procedimiento por worktree: **(1)** quitar el junction primero con `MSYS_NO_PATHCONV=1 cmd /c rmdir "<win_path>\node_modules"` desde git-bash (rmdir de cmd quita SOLO el junction, NO recorre al target; el `MSYS_NO_PATHCONV=1` evita que git-bash mangle el path/`/c`); **(2) CONFIRMAR** que se quitó antes de remover: `if [ -e "$wt/node_modules" ]; then echo SKIP; continue; fi` (si el Delete falló, el SKIP protege el `node_modules` real); **(3)** recién entonces `git -C <repo> worktree remove --force <wt>` + `git -C <repo> branch -D <branch>`. **Verificar el real después de cada borrado:** `ls <repo>/node_modules/.bin`. **Recuperación si se rompió:** `npm ci` (reinstala desde el lock — NO es build). **OJO (corregido 2026-06-26, verificado al limpiar 6 worktrees):** el `.Delete()` de .NET FALLA (ve el junction como directorio no-vacío porque refleja el target), `fsutil reparsepoint delete` no lo quita (silencioso), y `cmd //c "rmdir ..."` falla por el mangling del path en git-bash. El ÚNICO método confiable es `MSYS_NO_PATHCONV=1 cmd /c rmdir "<win_path>\node_modules"` (los worktrees del orchestrator son Python con `.venv` real, SIN junction → `git worktree remove --force` directo es seguro). Antes de borrar cualquier worktree: `git -C <wt> status --short` para no enterrar trabajo sin commitear (y NUNCA tocar worktrees `agent-*` con cambios pendientes o `locked` — son de sesiones/agentes activos).
  - **Instalar una dependencia NUEVA en un worktree ROMPE el junction (cazado 2026-07-15).** `npm i <pkg>` dentro de un worktree con junction de `node_modules` NO escribe en el `node_modules` real vía el junction: npm lo **MATERIALIZA** (reemplaza el junction por un `node_modules` REAL propio del worktree) y la dep queda SOLO ahí. Consecuencias: **(a)** el `node_modules` real de `main` NO tiene la dep nueva → tras mergear el change hay que correr `npm i` en el repo PRINCIPAL para que `main` la tenga localmente (el DEPLOY igual anda: el Dockerfile hace `npm ci` desde el lock ya actualizado; lo que falla son los tests LOCALES de `main` sin la dep). **(b)** Al limpiar ese worktree, su `node_modules` ya NO es un junction sino un dir REAL → el `rmdir` de cmd del método de arriba falla con "directorio no vacío" (el SKIP protege pero no borra). Para borrarlo con seguridad usar la **VERIFICACIÓN DEL MARCADOR** (más robusta que el `rmdir` para distinguir junction vs dir real antes de un `rm -rf`): `touch <repo>/node_modules/.MARKER`; si `.MARKER` **NO** aparece en `<wt>/node_modules` → el worktree tiene `node_modules` PROPIO, `rm -rf <wt>/node_modules` es seguro + `git worktree remove --force` + `branch -D`; si `.MARKER` **SÍ** aparece → ES el junction al real, **NO borrar**. Ejemplo real: el experimento happy-dom (`npm i -D happy-dom` en el worktree) dejó `main` sin happy-dom local hasta correr `npm i` en el repo principal.
- **`git add` por PATH explícito, SIEMPRE.** Nunca `git add -A`, `git add .` ni `commit -am`. Un agente con `git add` amplio barrió trabajo ajeno del working tree y lo enterró en commits que no le correspondían — costó una remediación entera desenredarlo.
- Antes de commitear: `git status` y confirmar que **solo** los archivos de la feature están staged. Ignorar artefactos sueltos (`.playwright-mcp/`, `*.png`, snapshots).
- **No pushear** (el push lo decide el usuario).
- **UI/UX en el frontend (INNEGOCIABLE) -> usar SIEMPRE la skill `ui-ux-pro-max`** (vive en `ipnext-frontend/.claude/skills/ui-ux-pro-max`). **TODA tarea de front (page, componente, modal, estilo, ajuste visual — por minimo que sea) PASA por esta skill ANTES de escribir una linea de UI. Sin excepcion.** Para TODO trabajo de UI/UX (disenar, construir, redisenar, revisar, mejorar paginas o componentes) correr primero `python .claude/skills/ui-ux-pro-max/scripts/search.py "<contexto>" --design-system` para anclar paleta/tipografia/jerarquia/estados, y aplicar sus reglas priorizadas (accesibilidad y touch CRITICAS: contraste >= 4.5:1, touch targets >= 44px, focus visibles, sin emojis como iconos, transiciones 150-300ms, loading/empty states). **OJO de stack**: el proyecto es React + Vite + CSS Modules con tokens `var(--color-*)`, NO Tailwind -> la skill da el QUE (diseno), el COMO se implementa con CSS Modules y los tokens existentes; jamas pegar clases Tailwind crudas. **Patron unico**: el design system se persiste con `--persist` y se reusa en toda la app para consistencia (mismos botones, spacing, colores en cada page).
- **Animaciones / MOTION en el frontend (INNEGOCIABLE) -> usar SIEMPRE las skills de animacion de Emil Kowalski** (paquete `emilkowalski/skill`: `emil-design-eng`, `apple-design`, `improve-animations`, `review-animations`, `animation-vocabulary`). Viven versionadas en `ipnext-frontend/.agents/skills/` (symlinked a `.claude/skills/`); si faltan, instalar con `npx skills add emilkowalski/skill` DENTRO del repo frontend (NUNCA en el backend — es una skill de FRONT; cazado 2026-07-12, la instalacion por defecto cae en el cwd y ensucia el repo equivocado). Son el COMPLEMENTO de `ui-ux-pro-max`, NO lo reemplazan: **`ui-ux-pro-max` da el diseno ESTATICO (paleta, jerarquia, layout, estados); las skills de Emil dan el MOTION (easing, duracion, fisica, origen, interrupcion, reduced-motion).** Se usan LAS DOS, en orden: (1) anclar el diseno con `ui-ux-pro-max --design-system`; (2) para TODO lo que se mueve (transiciones, hover/press, entrada/salida de modales/toasts/drawers, gestos, springs, animacion de listas) aplicar el bar de Emil -> nunca `ease-in` en UI, JAMAS animar acciones de alta frecuencia o de teclado, origen fisico correcto, interrumpible, respetar `prefers-reduced-motion`, 150-300ms en micro-interacciones. Antes de mergear cualquier UI con animacion, pasarla por `review-animations` (la aprobacion se GANA, no se asume). `improve-animations` para auditar/planificar motion de una page; `animation-vocabulary` para nombrar un efecto.
- **Reglas de diseño front (INNEGOCIABLE) — checklist para TODA UI de producto** *(2026-07-14, nace del feedback del Bulk v1)*. Estas reglas se aplican SIEMPRE y se cazan en el review adversarial de front (foco a11y/UX/motion):
  - **PROHIBIDO el `<select>`/dropdown NATIVO genérico de cara al operador.** Todo dropdown se hace con un componente `Select`/`Combobox` PROPIO, estilado con los tokens del design system y accesible (teclado: flechas/Enter/Esc, `role="listbox"`/`option`, focus visible, tipeo-para-filtrar si la lista es larga, opción con check para el valor activo). El look nativo del OS NO se muestra en la UI de producto. *(Regla #1, pedida por el usuario mirando el Bulk v1.)*
  - **Tokens SIEMPRE** (`var(--color-*)` / `--space-*` / `--radius-*` / `--shadow-*` / `--font-*`), **hex o px crudo NUNCA** en un `.module.css`. Un color hardcodeado es un hallazgo de review.
  - **4 ramas de estado en TODO lo que fetchea:** loading (skeleton) · empty (con explicación/CTA) · error (`role="alert"` + reintento) · success. Jamás una pantalla en blanco ni un spinner infinito.
  - **Accesibilidad no negociable:** contraste ≥4.5:1 (CALCULADO, no a ojo), touch ≥44px, focus-visible en TODO lo interactivo, labels asociados a inputs, `aria-live` en contadores/errores, focus-trap + restauración de foco en modales, indicador de estado NUNCA solo-color.
  - **Feedback de acciones de alto riesgo:** toda acción irreversible o con costo (envío masivo, borrado, transferencia) lleva **doble-confirmación con el impacto explícito** (cuántos destinatarios, qué cuesta) + feedback de éxito Y de error VISIBLES — un fallo silencioso es un bug.
  - **Formularios anti-error humano:** cuando un control puede confundir al operador (ej. variables de template `{{1}}`/`{{2}}`), mostrar SIEMPRE una descripción/contexto de qué es cada cosa (el texto del template alrededor de la variable, el label semántico), no solo el índice crudo.
  - **Consistencia:** reusar los átomos/moléculas/organismos existentes (DataTable, ConfirmModal, Tabs, Pagination, Button, el `Select` propio) — mismo look en TODA la app, no reinventar por página.
- Conventional commits, sin atribución de IA / `Co-Authored-By`.
- TDD estricto (BE: Jest + adapters in-memory; FE: Vitest). Test primero.
- No romper el **contrato del API** que el FE ya consume en prod (ej.: tras pasar `Ticket.status` a FK, el DTO sigue exponiendo `status` como string — la traducción name↔id vive en el repositorio, no se filtra al DTO).
- **El front maneja permisos GRANULARES** en formato `modulo.accion` con punto (ej. `clients.read`, `scheduling.read`), chequeados con `RequirePermission` / `useMyPermissions().can()` contra el `string[]` que devuelve `/me` (`*` = super_admin). **Cada page/ruta/ítem de sidebar nuevo DEBE protegerse con un permiso que el front realmente recibe** — verificarlo en `useMyPermissions`/el catálogo del `/me` antes de usarlo. Inventar un permiso que el front no tiene (p. ej. usar la clave RBAC del backend `modulo:accion` con colon, como `gestionReal:read`) deja la página **invisible para todos**. El catálogo RBAC del backend (`gestionReal:read`, colon) NO es el mismo namespace que los permisos del front — no asumir equivalencia.
- **Regla de permisos granulares (INNEGOCIABLE):** TODA feature, page, ruta o acción nueva DEBE tener su permiso granular `modulo.accion` cuando amerite control de acceso, y protegerse en **las dos capas**, no en una sola:
  - **Frontend** — `RequirePermission` (pages/rutas) o `Can` (botones, secciones, acciones) con la clave que el front realmente recibe del `/me`.
  - **Backend** — el guard de la ruta con el permiso correspondiente (NO alcanza con "solo autenticado"; una ruta protegida solo en el front es un agujero).
  - Si el permiso todavía no existe: agregarlo al **catálogo RBAC del backend** Y exponerlo para que el front lo reciba — **cambio coordinado en ambos repos**. Nunca dejar una page/ruta nueva sin permiso por default ni inventar una clave; **documentar en el PR la clave usada**.
  - ~~Deuda: rutas de inventario por servicio solo autenticadas~~ **SALDADA** (#8 + auditoría 2026-06-09: `contractInventory.routes.ts` tiene guard granular en TODAS las rutas — scheduling.* para sugerencias, inventory.* para contrato/materiales; `/api/services/:serviceId/inventory` ya no existe).
  - Deuda VIGENTE (auditoría 2026-06-09): `PATCH /api/admin/feature-flags/:key` está solo-autenticado — cualquier usuario logueado puede flipear CUALQUIER flag por API directa (la UI sí gatea por módulo: `iclass.manage` / `inventory.manage`). Cerrarla requiere decidir la política: un permiso `admin.flags` global, o guard por namespace del flag.

## Gestion Real (GR) — EN DEPRECACION (planificada)

> **GR se va a DEJAR DE USAR** (Prominense lo reemplaza). **REGLA INNEGOCIABLE**: toda feature/config/integracion NUEVA que dependa de GR debe construirse pensando en su futura remocion:
> - **Aislar, NO acoplar al nucleo**: las integraciones GR van en su propia sub-page + use case DEDICADO (estilo el mapeo tecnico<->cuadrilla de IClass: `SetTechnicianTeamMapping` + sub-page de Config), NUNCA como campos en modelos/DTOs/modales CORE. Asi, el dia que GR se vaya, se borra la pieza sin tocar el nucleo. (Ej: el mapeo agente<->vendedor GR de la cartera "Mis clientes" se hizo asi a proposito.)
> - **No expandir la superficie GR**: clientes/contratos YA estan acoplados por necesidad (el sync espeja GR), pero las features NUEVAS deben MINIMIZAR la dependencia de datos/endpoints de GR.
> - **Marcar como deuda**: todo lo que dependa de GR se documenta como deuda a revisar cuando se planifique el reemplazo. Datos derivados de GR (ej. `Contract.vendedor`, el sync de clientes/contratos, el ingest de OS, el password diario) deben poder migrarse o sobrevivir sin GR.

## Gotchas conocidos

- **Dry-run de migraciones: COMMIT interno rompe el wrapper (incidente 2026-06-10)**: si el `migration.sql` trae su propio `BEGIN;`/`COMMIT;`, el COMMIT interno commitea la transacción del dry-run y el ROLLBACK final no deshace nada — el DDL queda aplicado en prod. Regla doble: (1) NO escribir `BEGIN`/`COMMIT` dentro de migration.sql (`prisma migrate deploy` ya envuelve cada migración en su transacción); (2) todo script de dry-run debe DETECTAR `COMMIT;` en el SQL y abortar o strippear los BEGIN/COMMIT de primer nivel ANTES de wrappear. El incidente UISP fue inocuo (todo aditivo+idempotente, el ledger de prisma se auto-reconcilió en el deploy), pero con una migración destructiva habría sido grave.

- **Backfill con guard `RAISE EXCEPTION` → estado FAILED P3018 que bloquea (incidente 2026-06-24)**: una migración de transformación de data con guard fail-fast (`DO $$ … RAISE EXCEPTION` si queda un valor no mapeado) es lo CORRECTO — cazó 55 contratos en `'Pendiente de Instalación'` (un estado fuera de la muestra) y dejó **prod intacto** por rollback total. PERO al saltar, Prisma registra la migración como FAILED en `_prisma_migrations` → el siguiente `migrate deploy` se NIEGA con **P3018** ("a migration failed to apply") hasta recuperarla. Como el guard hizo rollback TOTAL (cero data aplicada), la recuperación correcta es marcarla rolled-back y reintentar: `prisma migrate resolve --rolled-back <migration>`. Patrón de **auto-recovery** en el step `Run DB migrations` (idempotente, no-op en deploys sanos): `sh -c 'npx prisma migrate deploy || (npx prisma migrate resolve --rolled-back <migration> && npx prisma migrate deploy)'`. Reglas: (1) un backfill con guard SIEMPRE puede saltar la 1ra vez — la muestra de valores NUNCA es exhaustiva, así que tener el recovery listo y NO asumir que el 1er deploy pasa; (2) el guard debe **LISTAR los valores rogue** en el mensaje (`string_agg(DISTINCT status, ', ')`) para saber qué agregar al mapeo; (3) confirma que el guard hizo rollback total ANTES de usar `--rolled-back` (si hubiera aplicado parcialmente, sería `--applied` + cleanup).

- **`NODE_ENV=development` en prod**: el container de prod corre con `NODE_ENV=development` (ver `deploy.yml`). Cualquier lógica condicionada a "es dev" se activa en prod. Por eso el logging de Prisma se controla con una env var explícita (`PRISMA_LOG_QUERIES`), no con `NODE_ENV`.
- **Edit tool y caracteres no-ASCII**: editar archivos con acentos/em-dashes puede fallar en silencio (reporta éxito sin cambiar el disco). Verificar con `rg` después; usar reescritura completa como fallback. Anclar los matches en texto ASCII cuando se pueda.
- **`(prisma as any).<tabla>`**: aparece cuando se agrega una tabla al schema sin re-correr `prisma generate`. El `Dockerfile` lo corre en el build, así que en prod está bien; es solo el entorno local.
- **Orden de routers**: montar routers de sub-recursos (`/statuses`, `/comments`) ANTES del router con catch-all `/:id`, o el catch-all se los traga.
- **Fecha del password diario de GR = hora Argentina (UTC-3), NO la UTC del container**: el password de Gestion Real es `MD5(CUIT + SECRET + fecha)` y GR lo valida contra la fecha calendario de Buenos Aires. El container de prod corre en **UTC**, asi que derivar la fecha con `getDate()`/`toISOString()` (TZ del proceso) falla en la franja noche-ARG (~21:00-24:00, cuando UTC ya avanzo al dia siguiente): GR responde `{"error":"90","descripcion":"No tiene Acceso"}` y **TODO el sync de GR devuelve 0** (clientes + ingesta de OS), de forma intermitente y silenciosa. Fix: `isoDate()` en `GestionRealClient.ts` fija la TZ con `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })` (usa el ICU embebido de node, anda en `node:alpine` sin `tzdata` del OS). Sintoma de diagnostico: en los logs `[gr-ingest] done: created=0 ...` con todo en cero, y una llamada directa a GR con la fecha UTC da error 90 pero con la fecha AR trae las ordenes.

- **Integracion BE->orchestrator (RADIUS): requiere `ORCHESTRATOR_BASE_URL` + `ORCHESTRATOR_API_TOKEN` (incidente 2026-06-20)**: el `HttpRadiusOrchestratorGateway` toma el baseUrl de `config.orchestrator.baseUrl = process.env.ORCHESTRATOR_BASE_URL ?? ''`. Si la env falta (estuvo asi en prod hasta 2026-06-20), `baseUrl=''` -> axios tira `"Invalid URL"` -> 502 `ORCHESTRATOR_UNREACHABLE` en CUALQUIER llamada al orchestrator (createUser de Wave 3, syncPlan del catalogo de planes, suspend/reactivate, listAssignedIps del allocator). Fix: `gh secret set ORCHESTRATOR_BASE_URL` = `http://10.75.0.20:8080` (VIP HA — el container BE CONNECTED a la VIP y a r1 `10.75.0.10`) + `gh secret set ORCHESTRATOR_API_TOKEN`, y las 2 lineas `-e ORCHESTRATOR_*="${{ secrets.X }}"` en el step Deploy container de `deploy.yml`. **Leccion general (vale para CUALQUIER integracion externa nueva): los gates (jest/pytest) MOCKEAN el HTTP -> NO cazan env/config de prod faltante. Una integracion externa NO esta verificada hasta ejercerla EN VIVO por su capa REAL (el gateway HTTP del BE), no por el upstream directo (curl al orchestrator). El create de Wave 3 "andaba" en los tests y contra el orchestrator directo, pero el gateway del BE NUNCA habia llamado al orchestrator en prod hasta que el allocator lo forzo — y ahi salto el `Invalid URL`.**

## Seguridad

- **Nunca** pegar credenciales (tokens, passwords) en commits, código o chats. Si pasa, **rotar de inmediato**.
- **Los secrets del pipeline se setean SIEMPRE con `gh`** (ej. `gh secret set DATABASE_URL`), nunca a mano en la UI ni hardcodeados. El deploy consume `secrets.DATABASE_URL` y companhia desde GitHub Actions, asi que `gh secret set` / `gh secret list` es la via canonica para crearlos, rotarlos y auditarlos. El valor del secret se pasa por stdin o archivo, jamas inline en el comando que queda en el historial.
- **Las env vars de runtime del contenedor de prod tambien son secrets de GitHub.** No se setean en EasyPanel a mano: el step `Deploy container` de `deploy.yml` las forwardea al contenedor via `-e VAR="${{ secrets.VAR }}"`. Para agregar una nueva env de runtime: (1) agregar la linea `-e VAR=...` en el step `Deploy container`, (2) `gh secret set VAR`. El agente lo hace (no requiere accion manual del operador en EasyPanel).
- **`COOKIE_SECURE`**: controla el flag `Secure` de la cookie de sesion (SDD #6a), desacoplado de `NODE_ENV`. **Prod corre por HTTP plano (sin TLS)** → `COOKIE_SECURE=false` (si se setea `true` sin HTTPS, el browser descarta la cookie y se rompe el login). Pasa a `true` recién cuando haya HTTPS adelante.
- Hay deuda de seguridad abierta en `BACKLOG.md`, sección "🔧 Deudas conocidas" (PAT de GitHub, credenciales en skills, enforcement de roles, leak de secretos NAS).

## Servidor y runners self-hosted (infra)

- **Host de prod + runners**: `190.7.234.37`, SSH por **puerto 2222**, usuario `ronald`. La **password NO se guarda en este archivo** (es un archivo commiteado = leak permanente). Usar **SSH key** y rotar la password. El `sudo` del host se pasa por **stdin**, jamas inline.
- **Imagenes Docker** (renombradas a la marca Prominense; Docker exige minusculas): `prominense-fe:latest` (front) y `prominense-be:latest` (back). Los **containers** siguen llamandose `ipnext-new-frontend` (puerto 7778) e `ipnext-new-backend` (8291) - cambiar el nombre del container requiere parar el viejo en el mismo deploy o choca el puerto.
- **Runners GitHub Actions self-hosted** (uno por repo, en el MISMO host que los containers):
  - `prominense-fe` -> repo `ipnext-frontend`, en `/opt/actions-runner-prominense-fe`
  - `prominense-be` -> repo `ipnext-backend`, en `/opt/actions-runner-prominense-be`
  - `prominense-app` -> repo `ipnext-customer-app`, en `/opt/actions-runner-prominense-app` (creado 2026-07-29 con la receta de abajo; CI + builds Android — toolchain JDK 17 + Android SDK 36 en `/opt/android-sdk`, `ANDROID_HOME`/`JAVA_HOME` en el `.env` del runner)
  - Servicios systemd: `actions.runner.rhernandezbas-ipnext-{frontend,backend}.prominense-{fe,be}.service` y `actions.runner.rhernandezbas-ipnext-customer-app.prominense-app.service`. Corren como `ronald`.
- **OJO - gotcha critico**: una limpieza de disco agresiva puede **BORRAR las carpetas de los runners** (paso el 2026-06-02: el disco se lleno de imagenes Docker viejas, la limpieza borro `/opt/actions-runner-ipnext-*`, los dos runners quedaron offline y TODOS los deploys quedaron en cola sin correr). Para liberar disco con seguridad: `docker image prune -a` y `docker builder prune` SI; revisar bien que borra cualquier `rm -rf` manual o `prune --volumes`.
- **Re-instalar un runner borrado (receta verificada 2026-06-02)**:
  1. Token: `gh api -X POST repos/rhernandezbas/<repo>/actions/runners/registration-token --jq .token`.
  2. Copiar binarios de un runner existente del host (tar excluyendo `_work _diag .runner* .credentials* .env .path *.service` y las versiones de `bin.`/`externals.` que no se usen).
  3. **Re-apuntar los symlinks `bin` y `externals` a las copias PROPIAS del dir nuevo** (si quedan apuntando al runner fuente, el binario corre desde alli y lee la config del fuente -> "already configured").
  4. `rm -f .runner .runner_migrated .credentials* .env .path .service` (borra la config copiada; **NUNCA** `config.sh remove`, eso desregistra al runner fuente).
  5. `RUNNER_ALLOW_RUNASROOT=1 ./config.sh --url https://github.com/rhernandezbas/<repo> --token <TOKEN> --name prominense-{fe,be} --unattended --replace`.
  6. `./svc.sh install && chown -R ronald:ronald <dir> && ./svc.sh start` (el `chown` evita "Permission denied" al escribir `_diag`, porque config.sh corrio como root).
  7. Verificar `gh api repos/rhernandezbas/<repo>/actions/runners` -> `online`; borrar el registro viejo offline con `gh api -X DELETE .../runners/<id>`.
