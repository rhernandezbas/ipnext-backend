# Proposal: Recaptación — Admin asigna leads (BE)

## Intent

Cambiar el modelo de recaptación de "el agente auto-toma leads" (self-take) a "el ADMIN asigna leads a cada agente". Hoy un agente con `recapture.manage` puede auto-tomarse cualquier lead libre (`claim` / `claim-next`) y ver todos. El nuevo modelo separa responsabilidades con un permiso granular nuevo `recapture.assign`:

- **Admin** (`recapture.read` + `recapture.manage` + `recapture.assign`): ve TODOS los leads, asigna/reasigna en bulk, ingesta bajas, importa CSV.
- **Agente** (`recapture.read` + `recapture.manage`, SIN `recapture.assign`): ve SOLO sus leads asignados (restricción server-side), los gestiona (registrar contactos + cambiar estado). NO puede asignar, ingestar, importar ni auto-tomar.
- **Self-take ELIMINADO del todo**: se quitan los endpoints `claim-next` y `claim` y sus use cases.

## Scope

Backend only (repo `ipnext-backend`). El cambio de FE (vista de admin con asignación bulk + vista de agente filtrada) se construye en un cambio hermano contra el contrato de wire definido acá.

### In scope

- Permiso RBAC nuevo `recapture.assign` (action code `assign` en `KNOWN_ACTIONS`, módulo `recapture`) + grants a `super_admin` y `administrador`, vía **migración de datos** idempotente + paridad en `prisma/seed.ts`.
- Use case nuevo `AssignRecaptureLeadsBulk(leadIds[], operatorId|null)` + endpoint `PATCH /api/recapture/leads/assign-bulk` gateado `[assign]`.
- Re-gate de endpoints de admin a `[assign]`: `PATCH /leads/:id/assign`, `POST /ingest-churned`, `POST /import-csv`.
- Restricción server-side por permiso del actor en `GET /leads`, `GET /leads/:id`, `PATCH /leads/:id`, `POST /leads/:id/contacts`: si el actor NO tiene `recapture.assign`, solo ve/toca sus propios leads (`assigneeId === actorId`).
- Eliminación de self-take: endpoints `POST /leads/claim-next` + `POST /leads/:id/claim` y use cases `ClaimNextRecaptureLead` + `ClaimRecaptureLead`; se retira `claimNext()` del port.

### Out of scope

- Cambio de schema Prisma: el modelo `RecaptureLead` YA tiene `assigneeId`, `claimedAt`, `status` (no requiere migración de schema, solo migración de datos para el permiso).
- FE (cambio hermano).
- Caché de permisos en proceso (sigue resolviéndose por request, igual que `requirePermission`).

## Approach

Hexagonal estricto. El permiso del actor se chequea inline en los handlers a través de una capability inyectada `hasAssignPerm(userId): Promise<boolean>` (closure sobre `RbacUserRepository` en el wiring de `app.ts`), respetando DIP: el router depende de una función, no del adapter Prisma. El bulk-assign reusa la validación de `AssignRecaptureLead` (operatorId debe existir si no es null). El contrato de wire se fija acá para que el FE construya en paralelo.

## Rollback

- No hay migración de schema → revertir es seguro.
- Revertir el código (router, use cases, wiring) restaura el modelo self-take.
- El permiso `recapture.assign` y sus grants quedan huérfanos en la DB sin causar daño (ningún endpoint los exige tras el revert; `requirePermission` simplemente no los consulta). Opcionalmente se pueden limpiar, pero no es necesario.
