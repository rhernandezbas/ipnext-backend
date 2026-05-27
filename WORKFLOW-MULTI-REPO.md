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

Tras cada deploy, se verifica con **Playwright** contra la app real (`http://190.7.234.37:7778`, login admin). Para backend sin UI todavía, se confirma el deploy verde + el log del step de migraciones. Para features con UI, se recorre el flujo real (crear/editar/borrar) y se limpian los datos de prueba.

## Reglas para agentes / asistentes de IA

- **`git add` por PATH explícito, SIEMPRE.** Nunca `git add -A`, `git add .` ni `commit -am`. Un agente con `git add` amplio barrió trabajo ajeno del working tree y lo enterró en commits que no le correspondían — costó una remediación entera desenredarlo.
- Antes de commitear: `git status` y confirmar que **solo** los archivos de la feature están staged. Ignorar artefactos sueltos (`.playwright-mcp/`, `*.png`, snapshots).
- **No pushear** (el push lo decide el usuario).
- Conventional commits, sin atribución de IA / `Co-Authored-By`.
- TDD estricto (BE: Jest + adapters in-memory; FE: Vitest). Test primero.
- No romper el **contrato del API** que el FE ya consume en prod (ej.: tras pasar `Ticket.status` a FK, el DTO sigue exponiendo `status` como string — la traducción name↔id vive en el repositorio, no se filtra al DTO).

## Gotchas conocidos

- **`NODE_ENV=development` en prod**: el container de prod corre con `NODE_ENV=development` (ver `deploy.yml`). Cualquier lógica condicionada a "es dev" se activa en prod. Por eso el logging de Prisma se controla con una env var explícita (`PRISMA_LOG_QUERIES`), no con `NODE_ENV`.
- **Edit tool y caracteres no-ASCII**: editar archivos con acentos/em-dashes puede fallar en silencio (reporta éxito sin cambiar el disco). Verificar con `rg` después; usar reescritura completa como fallback. Anclar los matches en texto ASCII cuando se pueda.
- **`(prisma as any).<tabla>`**: aparece cuando se agrega una tabla al schema sin re-correr `prisma generate`. El `Dockerfile` lo corre en el build, así que en prod está bien; es solo el entorno local.
- **Orden de routers**: montar routers de sub-recursos (`/statuses`, `/comments`) ANTES del router con catch-all `/:id`, o el catch-all se los traga.

## Seguridad

- **Nunca** pegar credenciales (tokens, passwords) en commits, código o chats. Si pasa, **rotar de inmediato**.
- Hay deuda de seguridad abierta en [`DEUDAS-PENDIENTES.md`](./DEUDAS-PENDIENTES.md) (PAT de GitHub, password de DB, credenciales en skills, enforcement de roles).
