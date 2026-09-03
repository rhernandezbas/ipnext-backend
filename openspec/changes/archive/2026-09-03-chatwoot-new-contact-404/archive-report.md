# Archive Report: chatwoot-new-contact-404

**Fecha de archivado**: 2026-09-03
**Status**: Archivado — cambioenProd, smoke completo

---

## Ciclo SDD Completado

| Fase | Status | Detalle |
|---|---|---|
| 1. Exploration | ✅ Done | `exploration.md` — contexto, raíz del bug (premisa CHW-2 FALSA) |
| 2. Proposal | ✅ Done | `proposal.md` — fix de la premisa, 2 paths (404→ensure/re-post, 422→search/link) |
| 3. Spec | ✅ Done | Delta `specs/chatwoot-hub-sendpath/spec.md` — CHW-2 y CHW-7 MODIFIED |
| 4. Design | ✅ Done | `design.md` — arquitectura (lazy ensure, source_id leído de respuesta, error tipado) |
| 5. Tasks | ✅ Done | `tasks.md` — 27 tasks, Fase 1/2/3 + Fix wave F1 (6 findings, RED→GREEN) completadas |
| 6. Verify | ✅ Done | `verify-report.md` — PASS WITH WARNINGS, 72/72 tests verdes, TDD compliance 6/6 |
| 7. Implement | ✅ Done | Archivos modificados: `HttpChatwootGateway.ts`, `ChatwootGateway.ts` (port), tests |
| 8. Phase 4 (Live Smoke) | ✅ Done | Re-send a +5492324505794 → status='sent', 1 mensaje Chatwoot, sin duplicados |

---

## Specs Sincronizadas

**Archivo main**: `openspec/specs/chatwoot-hub-sendpath/spec.md`

### MODIFIED Requirements (delta aplicado)

#### CHW-2 — `ChatwootGateway.createConversationWithTemplate` (ensure-on-404, bulk)
- **Status del cambio**: Reemplazado (premisa pre-fix → post-fix)
- **Cambios**: De "find-or-create atómico" a "ensure-on-404 + retry único" — ahora permite que el adapter resuelva contacto por su cuenta ante 404
- **Scenarios**: 5 scenarios nuevos, incluyendo 422→search/link y source_id formato distinto

#### CHW-7 — `ChatwootUnavailableError` (paso diagnóstico + status HTTP)
- **Status del cambio**: Ampliación de requisito
- **Cambios**: Ahora requiere que el mensaje de error identifique el PASO Chatwoot (ej. "crear el contacto (POST /contacts)") y el STATUS HTTP, no solo el texto crudo de axios
- **Scenarios**: 1 scenario nuevo ("el ensure falla — recipient `failed` con paso y status")

---

## Archive Contents

Carpeta: `openspec/changes/archive/2026-09-03-chatwoot-new-contact-404/`

```
├── exploration.md      (inicial — no modificado en este archive)
├── proposal.md         (propuesta del fix — no modificado en este archive)
├── design.md           (decisiones arquitectónicas — no modificado en este archive)
├── tasks.md            (27 tareas, Fase 1–4 — no modificado en este archive)
├── specs/
│   └── chatwoot-hub-sendpath/
│       └── spec.md     (DELTA ORIGINAL — preservado para auditoría)
└── verify-report.md    (verificación estática/TDD — no modificado en este archive)
```

---

## Merges Applied to Main Specs

### `openspec/specs/chatwoot-hub-sendpath/spec.md`

**Merge type**: Partial replace (2 de 7 requirements MODIFIED, 0 added, 0 removed)

**Before**: 392 líneas (7 requirements CHW-*, 8 requirements SEND-*/HIST-*/TS-*/MODEL-*/PORT-*)
**After**: 478 líneas (7 requirements CHW-*, 8 requirements SEND-*/HIST-*/TS-*/MODEL-*/PORT-* con CHW-2 y CHW-7 actualizado)

**Preserved**: Todos los otros requirements (CHW-1, CHW-3–6, SEND-2–4, HIST-3, TS-5–6, MODEL-1, PORT-1) — no tocados

---

## Phase 4 — Live Smoke Summary

**Timestamp**: 2026-09-03 post-deploy (PROD)

| Item | Resultado |
|---|---|
| Número de smoke | +5492324505794 (real, previamente `failed` en envío por premisa falsa) |
| Flag `messaging-send-via-chatwoot` | ON |
| Acción | Re-envío del recipient `failed` via API externa de bulk |
| Status esperado en response | `sent` |
| Estado observado | ✅ `sent` |
| Chatwoot: Contact creado | ✅ Sí (via `POST /contacts` en 404) |
| Chatwoot: ContactInbox creado | ✅ Sí (via `POST /contacts/:id/contact_inboxes`) |
| Chatwoot: Conversación | ✅ 1 exactamente |
| Chatwoot: Mensaje | ✅ 1 exactamente, no duplicados |
| Mirror (backend): ChatMessage | ✅ 1 fila con `chatwootMessageId` poblado, `status:'sent'` |
| Duplicados | ✅ Ninguno |
| Contaminación de prod | ✅ No — Contact y ContactInbox con metadata real del cliente |

---

## Source of Truth Updated

El spec main `openspec/specs/chatwoot-hub-sendpath/spec.md` refleja el comportamiento EXACTO post-fix:
- Las 5 scenarios nuevas de CHW-2 están documentadas
- El tradeoff "ensure LAZY (solo en 404)" está fijado
- El mensaje de error de CHW-7 está tipado (paso + status)

Próximos changes que dependa del port `ChatwootGateway` o del adapter `HttpChatwootGateway` DEBEN partir de ESTE spec actualizado, no de versiones pre-fix de `messaging-bulk` o `inbox-template-send`.

---

## Deudas Aceptadas

Del `verify-report.md` (Fase 3 — Verify):

1. **WARNING**: Scenario CHW-2 "reintento de recipient `failed` tras el fix" — idempotencia verificada por equivalencia estructural, no por test directo (invocar `createConversationWithTemplate` dos veces en secuencia). **Resolución**: backlog futuro si emerge duddas (arquitectura subyacente ya prueba componentes; el gap es triangulación).

2. **WARNING**: Scenario CHW-7 "el ensure falla ... el batch continúa" — no probado a nivel `SendCampaign` porque `FakeChatwootGateway` no modela `contact_inbox`. **Resolución**: Gap documentado en `tasks.md`, fuera de alcance de este change.

3. **INFO**: Phase 4 no estaba en el alcance de la verificación estática (TDD/specs/design). **Resolución**: Completado post-deploy 2026-09-03 ✅.

---

## Audit Trail

| Artefacto | ID | Ubicación |
|---|---|---|
| Exploration | `sdd/chatwoot-new-contact-404/explore` | `openspec/changes/archive/.../exploration.md` |
| Proposal | `sdd/chatwoot-new-contact-404/proposal` | `openspec/changes/archive/.../proposal.md` |
| Spec | `sdd/chatwoot-new-contact-404/spec` | `openspec/changes/archive/.../specs/chatwoot-hub-sendpath/spec.md` |
| Design | `sdd/chatwoot-new-contact-404/design` | `openspec/changes/archive/.../design.md` |
| Tasks | `sdd/chatwoot-new-contact-404/tasks` | `openspec/changes/archive/.../tasks.md` |
| Verify | `sdd/chatwoot-new-contact-404/verify-report` | `openspec/changes/archive/.../verify-report.md` |

---

## SDD Cycle Complete

El ciclo SDD de **chatwoot-new-contact-404** está 100% archivado. El repositorio está listo para el próximo change.
