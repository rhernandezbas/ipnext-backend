# Proposal: Cambio de velocidad — evento "modified" en historial (motivo+operador) + applyInSession + fix operador

## Intent
Cuando se cambia la velocidad (plan) de un PPPoE: (1) que aplique EN CALIENTE, (2) que quede en el Historial de servicios como un evento **"Cambio de plan"** (no "Alta") con **motivo y operador**, (3) pidiendo confirmación + motivo en el FE con feedback de éxito. Y (4) arreglar el OPERADOR vacío en el historial.

## Why
- Hoy `UpdatePppoeService.changePlan` manda `apply_in_session: false` → el cambio NO aplica a la sesión viva (verificado en vivo: JorgeVillagraMerc pasó a IP-Air-40-15 en radusergroup pero la sesión seguía 30/10).
- El cambio de plan NO deja rastro en el historial. Debe quedar auditado (quién, cuándo, por qué).
- La columna OPERADOR sale vacía (el evento de alta se sintetiza legacy con actorName='' cuando `ensureInternet` hace no-op por línea ya activa).

## Scope

### BE
1. **applyInSession**: `UpdatePppoeService` → `orchestrator.changePlan(s.username, profile, { applyInSession: true })` (CoA, no corta la sesión; no-op si no hay sesión).
2. **Evento `modified`**: `UpdatePppoeService` graba un `ContractServiceEvent` best-effort cuando el `profile` cambia y hay `contractId`: `eventType:'modified'`, `reason` (motivo), `actorId/actorName`, `notes: "<old> → <new>"`. Inyectar `ServiceCatalogRepository` + `ContractServiceEventRepository` (o reusar el patrón de `RecordPppoeEnforceEvent`). `ServiceEventType` += `'modified'`.
3. **Ruta + DTO**: `UpdatePppoeBodySchema` += `reason` (nullish). `PATCH /api/pppoe/:id` pasa `...actorOf(req)` + `reason` al use case (hoy NO pasa actor).
4. **Fix operador (alta)**: que el alta de PPPoE registre el evento `activated` CON actor aunque la línea INTERNET ya esté activa (hoy `ensureInternet` no-opea → se sintetiza con actorName=''). Grabar el evento de alta de forma confiable (dedup-safe, sin duplicar cuando ensureInternet sí transiciona). Los altas legacy ya sintetizados NO se pueden backfillear (no hay dato de actor) — solo aplica a futuros.

### FE
5. **Confirmar + motivo**: el "Aplicar" de la velocidad abre `ServiceRemovalReasonModal` (reusar — ya es confirm+motivo) con título "Cambiar velocidad a {plan}" / confirm "Aplicar" → manda `update.mutateAsync({ id, body: { profile, reason } })`.
6. **Feedback de éxito**: banner `bannerSuccess` inline ("Velocidad cambiada correctamente") tras el éxito (no hay toast en la app).
7. **Historial**: `ServiceHistoryModal` EVENT_LABELS += `modified: 'Cambio de plan'` + badge (tono neutro). `ServiceEvent` type += `'modified'`.

## Out of Scope
- Backfill de altas legacy (sin dato de actor). Migración (eventType es String libre).

## Risks
| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| applyInSession corta la sesión | Baja | Es CoA (rate update), no Disconnect; no dropea |
| Evento duplicado en alta (fix operador) | Media | test dedup: 1 solo evento por alta |
| Evento modified en cada save del editar | Baja | solo si profile cambió (`input.profile !== s.profile`) |

## Success Criteria
- [ ] Cambiar velocidad aplica en caliente (applyInSession=true).
- [ ] Queda evento "Cambio de plan" en el historial con motivo + operador + old→new.
- [ ] FE pide confirmación + motivo y muestra éxito.
- [ ] Operador se registra en altas futuras.
- [ ] tests verdes (BE+FE) + tsc/typecheck + review GO.
