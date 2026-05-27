# TDR 0002 — Workflow de migraciones Prisma

## Contexto

El schema vive en `prisma/schema.prisma` y las migraciones en
`prisma/migrations/`. El runtime usa Prisma 7 con el adapter `@prisma/adapter-pg`
sobre PostgreSQL. Hay que conciliar dos necesidades: generar migraciones en
desarrollo y aplicarlas de forma segura en el deploy del contenedor.

## Generación de migraciones (desarrollo)

Regla del proyecto: **nunca editar el SQL de una migración a mano para cambios de
modelo** — se edita el `schema.prisma` y se genera la migración con:

```
npm run prisma:migrate    # → prisma migrate dev
```

Esto crea una carpeta con timestamp en `prisma/migrations/` y el `migration.sql`
correspondiente. El historial actual va desde `20260429032534_init` hasta
`20260527000000_gestion_real_mirror`, e incluye los catálogos editables
(`add_task_categories`, `add_task_priorities`, `add_stage_color`,
`admin_role_to_string`).

## Excepción: SQL escrito a mano para operaciones que Prisma no expresa bien

Cuando la migración necesita pasos que el diff automático de Prisma no genera de
forma segura (índices únicos sobre columnas nullable recién agregadas, comentarios
de "down" manual, etc.), el `migration.sql` se escribe **a mano** de forma
controlada.

Ejemplo real — `20260527000000_gestion_real_mirror/migration.sql` (el mirror GR):

```sql
-- Down (manual)
-- ALTER TABLE "Client" DROP COLUMN IF EXISTS "grClienteId";
-- ALTER TABLE "Service" DROP COLUMN IF EXISTS "grContratoId";
-- DROP TABLE IF EXISTS "SyncState";

ALTER TABLE "Client" ADD COLUMN "grClienteId" TEXT;
CREATE UNIQUE INDEX "Client_grClienteId_key" ON "Client"("grClienteId");

ALTER TABLE "Service" ADD COLUMN "grContratoId" TEXT;
CREATE UNIQUE INDEX "Service_grContratoId_key" ON "Service"("grContratoId");

CREATE TABLE "SyncState" ( ... );
```

Detalle de diseño: las columnas externas (`grClienteId`, `grContratoId`) se agregan
**nullable** a propósito, para no romper las filas pre-existentes (Splynx-sourced)
que no tienen id de GR. El índice único permite múltiples `NULL` en PostgreSQL,
así que coexisten filas con y sin id externo.

Nota: Prisma no soporta migraciones "down" automáticas; el rollback se documenta
como comentario en el propio SQL para ejecución manual si hiciera falta.

## Aplicación en el deploy (contenedor)

El `Dockerfile` aplica las migraciones pendientes **al arrancar el contenedor**,
antes de levantar el server, con fail-fast:

```dockerfile
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
```

- `migrate deploy` aplica solo migraciones ya commiteadas (no genera nuevas, no
  pide input) — es el comando correcto para producción.
- Si una migración **falla**, el `&&` corta y el contenedor **no arranca** el
  server: fail-fast, nunca se sirve contra un schema drifteado.

## Build del contenedor (multi-stage)

1. **Builder**: `npm ci` → `prisma generate` → `npm run build`
   (`tsc && tsc-alias`, que reescribe los path aliases en `dist/`).
2. **Runtime**: `npm ci --omit=dev`, copia `dist/`, el cliente Prisma generado
   (`node_modules/.prisma`), `prisma/` y `prisma.config.ts`.

## Resumen del flujo

| Etapa | Comando | Cuándo |
|-------|---------|--------|
| Crear migración | `npm run prisma:migrate` (`migrate dev`) | Dev, tras editar `schema.prisma`. |
| SQL a mano | editar `migration.sql` | Solo para pasos que el diff no expresa bien. |
| Aplicar en prod | `prisma migrate deploy` | Arranque del contenedor (en el `CMD`). |
| Seed | `npm run prisma:seed` | Datos iniciales. |

**Regla operativa del repo**: no correr `npm run build` por cuenta propia tras
editar — lo decide el usuario.
