# Technical Design: recaptacion-leads (#80)

## Decision 1 — Modelo desacoplado del Client (CSV-ready)
`RecaptureLead` NO extiende `Client`. Tiene un snapshot de contacto propio (contactName/phone/email) y un `clientId` opcional. Cuando `source = 'churned_client'`, `clientId` apunta al `Client` de baja y el snapshot se copia al crear el lead. Cuando en el futuro entre `source = 'csv'`, `clientId` será null y el snapshot vendrá del archivo. Esto evita remodelar: el import CSV será puramente aditivo (un nuevo seeder que inserta leads con source='csv').

### Entidad RecaptureLead
| Campo | Tipo | Notas |
|---|---|---|
| id | string (cuid) | PK |
| source | RecaptureLeadSource | 'churned_client' \| 'csv' |
| clientId | string? | FK Client, opcional. Solo churned. |
| contactName | string | snapshot |
| phone | string? | snapshot |
| email | string? | snapshot |
| status | RecaptureLeadStatus | default 'nuevo' |
| assigneeId | string? | FK RbacUser. null = sin asignar |
| claimedAt | DateTime? | set en claim |
| createdAt / updatedAt | DateTime | |

Índice parcial único: `(clientId) WHERE source = 'churned_client' AND clientId IS NOT NULL` -> un solo lead por cliente de baja (idempotencia del seed). Índices: `(status)`, `(assigneeId)`.

### Entidad RecaptureContact (bitácora)
| Campo | Tipo | Notas |
|---|---|---|
| id | string (cuid) | PK |
| leadId | string | FK RecaptureLead ON DELETE CASCADE |
| actorId | string | FK RbacUser (quién registró) |
| channel | RecaptureContactChannel | |
| outcome | RecaptureContactOutcome | |
| proposal | string? | qué se propuso |
| note | string? | nota libre |
| nextStepAt | DateTime? | próximo paso |
| createdAt | DateTime | |

### Enums
- `RecaptureLeadSource`: churned_client, csv
- `RecaptureLeadStatus`: nuevo, en_gestion, contactado, interesado, recuperado, descartado
- `RecaptureContactChannel`: llamada, whatsapp, email, sms, otro
- `RecaptureContactOutcome`: sin_respuesta, contactado, no_interesado, interesado, recuperado, numero_erroneo

## Decision 2 — Criterio de "cliente de baja"
Canónico: `Client.status = 'baja'` (enum ClientStatus, prisma/schema.prisma; corresponde a GR estado.codigo 6, seteado por SyncGestionRealClients). NO se usa `inactive` (es "merely inactive", no churned). `tvCancelledAt` es churn TV-only, secundario, no se usa para el seed inicial. El seeder consulta `Client where status='baja'` y crea un RecaptureLead (source='churned_client') por cada uno, idempotente vía el índice parcial único. Decisión documentada para que cambiar el criterio sea trivial (un solo query en el seeder/use-case de ingest).

## Decision 3 — Claim race-safe
Para 4-6 personas concurrentes, el claim NO puede ser read-then-write. Se hace con UPDATE condicional atómico:
```sql
UPDATE "RecaptureLead" SET "assigneeId" = $actor, "claimedAt" = NOW(), "status" = 'en_gestion'
WHERE "id" = $id AND "assigneeId" IS NULL
```
Si `rowCount = 0` -> ya estaba tomado -> el use-case lanza `RecaptureLeadAlreadyClaimedError` -> la route responde **409**. En el port: `claim(leadId, actorId): Promise<RecaptureLead | null>` (null = no se pudo tomar). "Tomar siguiente" (`claimNext`): selecciona el primer lead libre (status='nuevo', assigneeId IS NULL, orden createdAt asc) y aplica el mismo UPDATE atómico con guard; si dos piden a la vez, uno gana y el otro reintenta o recibe el siguiente. Implementación Prisma con `updateMany` (devuelve count) para el guard atómico; InMemory replica el chequeo `assigneeId == null` sincrónicamente. También `release(leadId, actorId)` para soltar (assigneeId -> null, status -> nuevo) — solo el assignee o un manage puede.

## Decision 4 — Pipeline de estados
Set documentado (enum, no tabla catálogo — es estable y chico): nuevo -> en_gestion -> contactado -> interesado -> recuperado | descartado. El claim mueve nuevo->en_gestion. Registrar contacto puede actualizar el status del lead (opcional en el body). Sin máquina de estados rígida (el equipo decide), pero el enum acota valores válidos.

## Decision 5 — El llamado es externo
No se integra telefonía. `RecaptureContact` solo registra. `channel='llamada'` es un dato, no dispara nada.

## Decision 6 — RBAC dos capas
- `recapture.read`: ver la lista y el detalle.
- `recapture.manage`: tomar/soltar leads y registrar contactos.
Catálogo: agregar 'recapture' a RBAC_MODULES (src/domain/entities/rbac.ts). Migración aditiva (timestamp >= 20260717000000): inserta módulo + 2 permisos + grant a super_admin y a administrador, todo idempotente (ON CONFLICT DO NOTHING). Seed.ts: bloque idempotente espejo (upsert) para dev. Verificación: el front consume `recapture.read`/`recapture.manage` desde `/me` (ResolveUserPermissions arma "module.action").

## REST surface (/api/recapture)
- `GET /api/recapture/leads?status=&assigneeId=&unassigned=&page=&limit=` (read) -> lista paginada (DTO, nunca entidad Prisma cruda).
- `GET /api/recapture/leads/:id` (read) -> lead + sus contactos (timeline).
- `POST /api/recapture/leads/:id/claim` (manage) -> 200 lead | 409 si tomado.
- `POST /api/recapture/leads/claim-next` (manage) -> 200 lead | 204/404 si no hay libres.
- `POST /api/recapture/leads/:id/release` (manage) -> 200.
- `PATCH /api/recapture/leads/:id` (manage) -> cambia status.
- `POST /api/recapture/leads/:id/contacts` (manage) -> registra contacto (channel, outcome, proposal?, note?, nextStepAt?, status? para avanzar el lead).
- `POST /api/recapture/ingest-churned` (manage) -> corre el seeding desde Client status='baja' (idempotente). [endpoint de operación; alternativamente seed.ts]

Todos los outputs mapeados a DTO. Auth: createAuthMiddleware + requirePerm('recapture', 'read'|'manage').

## Vertical slice (mirror tickets)
- domain/entities/recaptureLead.ts (+ tipos RecaptureContact, enums)
- domain/ports/RecaptureRepository.ts
- domain/errors/ (RecaptureLeadNotFoundError, RecaptureLeadAlreadyClaimedError)
- application/use-cases/recapture/{ListRecaptureLeads,GetRecaptureLead,ClaimRecaptureLead,ClaimNextRecaptureLead,ReleaseRecaptureLead,UpdateRecaptureLeadStatus,AddRecaptureContact,IngestChurnedClients}.ts
- application/dto/recapture/*
- infrastructure/adapters/prisma/PrismaRecaptureRepository.ts
- infrastructure/adapters/in-memory/InMemoryRecaptureRepository.ts
- infrastructure/http/routes/recapture.routes.ts + wiring en app.ts
- prisma/schema.prisma (+ migration 20260717000000_recapture_leads)
- prisma/seed.ts (grant idempotente)

## FE
- src/api/recaptacion.api.ts, src/hooks/useRecaptacion.ts, src/types/recaptacion.ts
- src/pages/customers/RecaptacionPage.tsx (+ .module.css) + RecaptacionPage/components/{RecaptacionTableView, ClaimLeadModal, LeadDetailDrawer (timeline + form)} + hooks/useRecaptacionFilterUrl.ts
- App.tsx: ruta `recaptacion` bajo customers, gate recapture.read. Sidebar: entry CRM_ITEMS[0].children.
- Primitivas reusadas: DataTable, FilterBar, Button, StatusBadge, ConfirmModal, Can. queryKey ['recaptacion', query] / ['recaptacion-lead', id]. Mutations invalidan ['recaptacion'].

## Risks
- Concurrencia del claim: mitigado por UPDATE atómico con guard (no read-then-write).
- Criterio churned puede cambiar: aislado en un solo query del ingest.
- CSV futuro: modelo ya desacoplado; import será aditivo.
