# Verify report — tickets-redesign-sequence (#11), BACKEND

**Verdict: PASS** (backend). Date: 2026-06-07.

## Build & tests
- `tsc --noEmit` → exit 0.
- `npx jest --runInBand` → **2388 passed, 0 failed**, 86 skipped. +1 vs baseline (#14 dejó 2387).

## Spec compliance (BE)
| Requirement | Estado | Evidencia |
|---|---|---|
| REQ-TKT-1 — sequenceNumber monotónico + expuesto + backfill | ✅ | `tickets.routes.new.test`: sequenceNumber es number + monotónico (b>a); migración con backfill `ROW_NUMBER() OVER (ORDER BY createdAt,id)` (copia del patrón de tareas). |
| REQ-TKT-2/3/4 (FE) | ⏳ PENDIENTE | Fase FE (#N linkeado, layout espejo, pills). |

## Notas
- `Ticket` += `sequenceNumber Int @unique @default(autoincrement())`; entity + Prisma `toTicket` + InMemory (contador). Adapter Splynx (legacy) reusa el id numérico.
- Migración aditiva idempotente (copia exacta de `20260514100000`). SQL revisado con el usuario antes de pushear.
- `sequenceNumber` es solo display — el routing del ticket sigue por `id`.
