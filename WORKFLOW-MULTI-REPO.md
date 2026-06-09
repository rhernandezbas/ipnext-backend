# Workflow multi-repo — IPNext (Prominense)

> Cómo se trabaja sobre los dos repositorios del sistema. Documenta el flujo real,
> verificado en producción. Última actualización: 2026-05-27.

## Repos

| Repo | Ruta local | Remote | Qué es |
|------|-----------|--------|--------|
| **Backend** | `C:\Users\ronald\projects\ipnext\ipnext-backend` | `github.com/rhernandezbas/ipnext-backend` | Node + TS + Express + Prisma + PostgreSQL (hexagonal) |
| **Frontend** | `C:\Users\ronald\projects\ipnext\ipnext-frontend` | `github.com/rhernandezbas/ipnext-frontend` | React 18 + Vite + TanStack Query + CSS Modules |

Los dos viven uno al lado del otro bajo `C:\Users\ronald\projects\ipnext\`.

**Regla base**: cada repo es independiente. **Commits independientes por repo**, nunca commits que crucen los dos. Cada feature que toca BE y FE se trabaja como dos cambios coordinados (uno por repo), con su par de commits.

## Deploy — push = producción

Cada repo tiene `.github/workflows/deploy.yml` con un runner **self-hosted**. Hacer `git push` a `main` **auto-deploya a PRODUCCIÓN**. No hay staging.

- **Backend**: `docker build` → step **`Run DB migrations`** (`docker run … npx prisma migrate deploy` con `secrets.DATABASE_URL`) → deploy container → verify. El `Dockerfile` también corre `npx prisma migrate deploy && node dist/main.js` en el `CMD` (idempotente). Si una migración falla, el job se cae (**fail-fast**) y prod no se actualiza.
- **Frontend**: `docker build` → deploy container → verify. App pública en `http://190.7.234.37:7778`.

**Gate de seguridad (innegociable)**: como el push deploya a prod, **el push se confirma explícitamente cada vez**. Se preparan y commitean los cambios localmente, pero el `git push` requiere OK del usuario, change por change.

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

## Verificación

> **REGLA DE ORO — INNEGOCIABLE: VERIFY ANTES DE DEPLOY.** Nunca pushear/mergear a `main` (= producción)
> sin antes correr el **verify completo**: suite de tests completa + `tsc --noEmit` (BE) / `typecheck` (FE)
> y, en cambios SDD, **`sdd-verify`** con su matriz de spec-compliance (cada scenario probado por un test que
> pasó). **El verify es donde se cazan los bugs ANTES de que lleguen a prod** — el deploy va recién cuando el
> verify está en verde. Saltarse el verify (commit→deploy directo) = bug en producción. Orden obligatorio:
> **codear → verify (verde) → commit → push/deploy → confirmar el run en `gh`.**

- **El estado de cada deploy se revisa con `gh`** — fuente de verdad del pipeline. Tras pushear, se sigue el run con `gh run list` / `gh run watch` / `gh run view <id> --log` para confirmar que el job quedo verde (incluido el step `Run DB migrations`). No se asume "deployo bien" sin mirar el run en `gh`.
- Para backend sin UI todavia, basta el run verde en `gh` + el log del step de migraciones.
- Para features con UI, ademas se verifica con **Playwright** contra la app real (`http://190.7.234.37:7778`, login admin): se recorre el flujo real (crear/editar/borrar) y se limpian los datos de prueba.

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

Calibración del tamaño del review por riesgo: **4 revisores** con focos separados (migración/staging ·
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

- **`git add` por PATH explícito, SIEMPRE.** Nunca `git add -A`, `git add .` ni `commit -am`. Un agente con `git add` amplio barrió trabajo ajeno del working tree y lo enterró en commits que no le correspondían — costó una remediación entera desenredarlo.
- Antes de commitear: `git status` y confirmar que **solo** los archivos de la feature están staged. Ignorar artefactos sueltos (`.playwright-mcp/`, `*.png`, snapshots).
- **No pushear** (el push lo decide el usuario).
- Conventional commits, sin atribución de IA / `Co-Authored-By`.
- TDD estricto (BE: Jest + adapters in-memory; FE: Vitest). Test primero.
- No romper el **contrato del API** que el FE ya consume en prod (ej.: tras pasar `Ticket.status` a FK, el DTO sigue exponiendo `status` como string — la traducción name↔id vive en el repositorio, no se filtra al DTO).
- **El front maneja permisos GRANULARES** en formato `modulo.accion` con punto (ej. `clients.read`, `scheduling.read`), chequeados con `RequirePermission` / `useMyPermissions().can()` contra el `string[]` que devuelve `/me` (`*` = super_admin). **Cada page/ruta/ítem de sidebar nuevo DEBE protegerse con un permiso que el front realmente recibe** — verificarlo en `useMyPermissions`/el catálogo del `/me` antes de usarlo. Inventar un permiso que el front no tiene (p. ej. usar la clave RBAC del backend `modulo:accion` con colon, como `gestionReal:read`) deja la página **invisible para todos**. El catálogo RBAC del backend (`gestionReal:read`, colon) NO es el mismo namespace que los permisos del front — no asumir equivalencia.
- **Regla de permisos granulares (INNEGOCIABLE):** TODA feature, page, ruta o acción nueva DEBE tener su permiso granular `modulo.accion` cuando amerite control de acceso, y protegerse en **las dos capas**, no en una sola:
  - **Frontend** — `RequirePermission` (pages/rutas) o `Can` (botones, secciones, acciones) con la clave que el front realmente recibe del `/me`.
  - **Backend** — el guard de la ruta con el permiso correspondiente (NO alcanza con "solo autenticado"; una ruta protegida solo en el front es un agujero).
  - Si el permiso todavía no existe: agregarlo al **catálogo RBAC del backend** Y exponerlo para que el front lo reciba — **cambio coordinado en ambos repos**. Nunca dejar una page/ruta nueva sin permiso por default ni inventar una clave; **documentar en el PR la clave usada**.
  - Deuda conocida a saldar: las rutas de inventario por servicio (`/api/services/:serviceId/inventory`, `/api/scheduling/:taskId/inventory/...`) hoy están solo autenticadas — falta el guard granular en el backend.

## Gotchas conocidos

- **`NODE_ENV=development` en prod**: el container de prod corre con `NODE_ENV=development` (ver `deploy.yml`). Cualquier lógica condicionada a "es dev" se activa en prod. Por eso el logging de Prisma se controla con una env var explícita (`PRISMA_LOG_QUERIES`), no con `NODE_ENV`.
- **Edit tool y caracteres no-ASCII**: editar archivos con acentos/em-dashes puede fallar en silencio (reporta éxito sin cambiar el disco). Verificar con `rg` después; usar reescritura completa como fallback. Anclar los matches en texto ASCII cuando se pueda.
- **`(prisma as any).<tabla>`**: aparece cuando se agrega una tabla al schema sin re-correr `prisma generate`. El `Dockerfile` lo corre en el build, así que en prod está bien; es solo el entorno local.
- **Orden de routers**: montar routers de sub-recursos (`/statuses`, `/comments`) ANTES del router con catch-all `/:id`, o el catch-all se los traga.
- **Fecha del password diario de GR = hora Argentina (UTC-3), NO la UTC del container**: el password de Gestion Real es `MD5(CUIT + SECRET + fecha)` y GR lo valida contra la fecha calendario de Buenos Aires. El container de prod corre en **UTC**, asi que derivar la fecha con `getDate()`/`toISOString()` (TZ del proceso) falla en la franja noche-ARG (~21:00-24:00, cuando UTC ya avanzo al dia siguiente): GR responde `{"error":"90","descripcion":"No tiene Acceso"}` y **TODO el sync de GR devuelve 0** (clientes + ingesta de OS), de forma intermitente y silenciosa. Fix: `isoDate()` en `GestionRealClient.ts` fija la TZ con `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })` (usa el ICU embebido de node, anda en `node:alpine` sin `tzdata` del OS). Sintoma de diagnostico: en los logs `[gr-ingest] done: created=0 ...` con todo en cero, y una llamada directa a GR con la fecha UTC da error 90 pero con la fecha AR trae las ordenes.

## Seguridad

- **Nunca** pegar credenciales (tokens, passwords) en commits, código o chats. Si pasa, **rotar de inmediato**.
- **Los secrets del pipeline se setean SIEMPRE con `gh`** (ej. `gh secret set DATABASE_URL`), nunca a mano en la UI ni hardcodeados. El deploy consume `secrets.DATABASE_URL` y companhia desde GitHub Actions, asi que `gh secret set` / `gh secret list` es la via canonica para crearlos, rotarlos y auditarlos. El valor del secret se pasa por stdin o archivo, jamas inline en el comando que queda en el historial.
- **Las env vars de runtime del contenedor de prod tambien son secrets de GitHub.** No se setean en EasyPanel a mano: el step `Deploy container` de `deploy.yml` las forwardea al contenedor via `-e VAR="${{ secrets.VAR }}"`. Para agregar una nueva env de runtime: (1) agregar la linea `-e VAR=...` en el step `Deploy container`, (2) `gh secret set VAR`. El agente lo hace (no requiere accion manual del operador en EasyPanel).
- **`COOKIE_SECURE`**: controla el flag `Secure` de la cookie de sesion (SDD #6a), desacoplado de `NODE_ENV`. **Prod corre por HTTP plano (sin TLS)** → `COOKIE_SECURE=false` (si se setea `true` sin HTTPS, el browser descarta la cookie y se rompe el login). Pasa a `true` recién cuando haya HTTPS adelante.
- Hay deuda de seguridad abierta en [`DEUDAS-PENDIENTES.md`](./DEUDAS-PENDIENTES.md) (PAT de GitHub, password de DB, credenciales en skills, enforcement de roles).

## Servidor y runners self-hosted (infra)

- **Host de prod + runners**: `190.7.234.37`, SSH por **puerto 2222**, usuario `ronald`. La **password NO se guarda en este archivo** (es un archivo commiteado = leak permanente). Usar **SSH key** y rotar la password. El `sudo` del host se pasa por **stdin**, jamas inline.
- **Imagenes Docker** (renombradas a la marca Prominense; Docker exige minusculas): `prominense-fe:latest` (front) y `prominense-be:latest` (back). Los **containers** siguen llamandose `ipnext-new-frontend` (puerto 7778) e `ipnext-new-backend` (8291) - cambiar el nombre del container requiere parar el viejo en el mismo deploy o choca el puerto.
- **Runners GitHub Actions self-hosted** (uno por repo, en el MISMO host que los containers):
  - `prominense-fe` -> repo `ipnext-frontend`, en `/opt/actions-runner-prominense-fe`
  - `prominense-be` -> repo `ipnext-backend`, en `/opt/actions-runner-prominense-be`
  - Servicios systemd: `actions.runner.rhernandezbas-ipnext-{frontend,backend}.prominense-{fe,be}.service`. Corren como `ronald`.
- **OJO - gotcha critico**: una limpieza de disco agresiva puede **BORRAR las carpetas de los runners** (paso el 2026-06-02: el disco se lleno de imagenes Docker viejas, la limpieza borro `/opt/actions-runner-ipnext-*`, los dos runners quedaron offline y TODOS los deploys quedaron en cola sin correr). Para liberar disco con seguridad: `docker image prune -a` y `docker builder prune` SI; revisar bien que borra cualquier `rm -rf` manual o `prune --volumes`.
- **Re-instalar un runner borrado (receta verificada 2026-06-02)**:
  1. Token: `gh api -X POST repos/rhernandezbas/<repo>/actions/runners/registration-token --jq .token`.
  2. Copiar binarios de un runner existente del host (tar excluyendo `_work _diag .runner* .credentials* .env .path *.service` y las versiones de `bin.`/`externals.` que no se usen).
  3. **Re-apuntar los symlinks `bin` y `externals` a las copias PROPIAS del dir nuevo** (si quedan apuntando al runner fuente, el binario corre desde alli y lee la config del fuente -> "already configured").
  4. `rm -f .runner .runner_migrated .credentials* .env .path .service` (borra la config copiada; **NUNCA** `config.sh remove`, eso desregistra al runner fuente).
  5. `RUNNER_ALLOW_RUNASROOT=1 ./config.sh --url https://github.com/rhernandezbas/<repo> --token <TOKEN> --name prominense-{fe,be} --unattended --replace`.
  6. `./svc.sh install && chown -R ronald:ronald <dir> && ./svc.sh start` (el `chown` evita "Permission denied" al escribir `_diag`, porque config.sh corrio como root).
  7. Verificar `gh api repos/rhernandezbas/<repo>/actions/runners` -> `online`; borrar el registro viejo offline con `gh api -X DELETE .../runners/<id>`.
