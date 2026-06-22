# Proposal: Persistir el caller-id (MAC) del PPPoE — sobrevive a la desconexión

## Intent
Hoy el caller-id (MAC del CPE) se lee EN VIVO de la sesión RADIUS activa (`listSessions`). Cuando el cliente se desconecta, no hay sesión → el endpoint devuelve `null` → la MAC "desaparece" del panel. Debe **persistir** (guardar la última MAC vista) para mostrarse aunque el cliente esté offline.

## Why
El operador necesita ver la MAC del equipo del cliente aunque esté desconectado (diagnóstico, inventario). El dato es estable (la MAC del CPE no cambia salvo recambio de equipo).

## Validado
- `GetPppoeCallerId.execute(id)`: `repo.findById` → `orchestrator.listSessions(username)` → `sessions[0].callerId` o `null`.
- `PrismaPppoeServiceRepository.upsertByUsername` usa lista EXPLÍCITA de campos (password, profile, remoteAddress, status) — **NO incluye callerId** → el ingest desde GET /users NO lo pisaría. ✅
- `PppoeService` (entity + schema) NO tiene `callerId` aún.

## Scope (BE-puro)
1. **Schema + migración**: `PppoeService` += `callerId String?` (nullable, zero-downtime).
2. **Entity + mapper**: `PppoeService` += `callerId: string | null`. `toEntity` mapea `row.callerId ?? null`. (El `upsertByUsername` ya excluye callerId → no clobber; agregar comentario-guard.)
3. **Repo**: `PppoeServiceRepository.setCallerId(id, callerId): Promise<void>` (port) + impl Prisma (`update` solo `callerId`) + in-memory.
4. **GetPppoeCallerId — write-through + fallback**:
   - `const live = sessions[0]?.callerId ?? null`.
   - Si `live` y `live !== s.callerId` → `repo.setCallerId(s.id, live)` best-effort (persiste la última MAC vista).
   - **return `live ?? s.callerId`** (la viva si está online, si no la última guardada).
5. Tests: write-through (online → persiste + devuelve viva), fallback (offline → devuelve la guardada), MAC nueva pisa la vieja, sin guardada y offline → null.

## Out of Scope
- FE: ninguno (el FE muestra la MAC que devuelve el endpoint; al persistir, la muestra aunque esté offline). (Opcional follow-up: un hint "(última conocida)" cuando no hay sesión activa — necesitaría el endpoint devolver un flag `live`.)
- Captura masiva (un job que recorra todos): el write-through captura al ver el panel del cliente online. Suficiente para el caso (cliente que estaba online y se desconectó).

## Risks
| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| El ingest pisa callerId | Nula | upsertByUsername usa lista explícita sin callerId + comentario-guard |
| Write-on-read (side-effect en un GET) | Baja | best-effort (try/catch), patrón "last-seen cache", no rompe la respuesta |
| MAC vieja/stale si recambian el equipo | Baja | se actualiza apenas el cliente reconecta con la MAC nueva (write-through) |
| Migración rompe prod | Baja | columna nullable sin default; deploy corre migrate deploy |

## Success Criteria
- [ ] El panel muestra la MAC aunque el cliente esté desconectado (última conocida).
- [ ] Cuando está online, devuelve la MAC viva y la persiste; la MAC nueva pisa la vieja.
- [ ] El ingest NO pisa el callerId guardado.
- [ ] suite completa verde + tsc; review GO; verificación en vivo.
