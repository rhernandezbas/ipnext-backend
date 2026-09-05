# Proposal — `ai-assistant-cobranzas`

> Asistente IA de **cobranzas** sobre conversaciones de WhatsApp (Chatwoot + Twilio).
> 2026-09-04 · Base: motor `ReplyWithAssistant` (`ai-assistant-multiagent`, 55/55, en prod con flag OFF).

## Intent

Hoy cada pedido de boleta se contesta a mano. El motor existe pero está apagado y sin intents. Este change lo
**enciende para cobranzas**: responde con datos vivos de Gestión Real (detalle por factura, PDF, link MP por
factura y del total, link/alias con titularidad) y **frena en seco** ante reclamo de servicio, plan de pago,
disputa de monto, baja, enojo o transferencia bancaria — etiquetando y dejando nota privada.

## Scope

### In Scope
- **A** — fuente `cliente.facturas`: resolver GR (`invoices[]`, `payments_url_saldos`, `debt`) + **render determinístico** partido en mensajes **≤1.400 chars** numerados (límite duro Twilio: 1.600).
- **B** — acción **STOP** con etiquetas por intención (hoy `apply_label` es fijo) + nota privada con motivo. Campo aditivo en `AssistantIntent` + acción green en el catálogo.
- **C** — guarda **"agente activo"**: no responder si la conversación está asignada a un humano o hubo saliente de agente (no del bot) tras el último inbound.
- **D** — seed/config: perfil de cobranzas como `defaultAreaId`, 4 intents que responden + 5 de STOP, labels `soporte`/`administracion`, **modo borrador** inicial (`actionKey: private_note`).

**Enmienda 2026-09-04 — 5 reglas de negocio agregadas por el usuario** (design D9–D11; DAT-4,
RSP-1, INT-2/3/4, ACT-3 mod. y ACT-4):
- **E** — *comprobante verificado en GR, nunca a ojo*: fuente nueva `cliente.recibos_hoy` (llamada
  GR en vivo anclada al cliente) + match del nro. de operación del archivo `comprobante_<op>.pdf`
  contra `items[].numero_transferencia` de los recibos del día. Sin match ⇒ transferencia bancaria
  ⇒ STOP `comprobante_transferencia`. **Revierte el "fuera de alcance" de D7.**
- **F** — *el SIGNO del saldo decide el mensaje*: `debt > 0` ⇒ "recibimos tu pago, te quedan $Y en N
  facturas" (nunca "al día"); `debt ≤ 0` ⇒ al día, mencionando el saldo a favor si es negativo.
- **G** — *promesa de pago* ⇒ STOP con label `administracion` **y desasignar** la conversación
  (vuelve a la cola). Campo aditivo `AssistantIntent.unassign` + `unassign` en el gateway.
- **H** — *pago parcial + promesa* ⇒ un único acuse Y sigue en Administración: `labels[]`/`unassign`
  pasan a aplicarse en CUALQUIER acción, no sólo en `handoff`.
- **I** — *doble pago*: ≥2 recibos del día por el mismo importe ⇒ el mensaje lo avisa y la
  conversación queda etiquetada `administracion` para caja.

### Out of Scope
Tickets, campañas masivas (`external-bulk-messaging`), cambio de proveedor de modelo, UI nueva en el FE (follow-up si hace falta un campo), nuevas llamadas a Splynx.

## Capabilities

### New Capabilities
- `assistant-cobranzas`: intents de cobranza, reglas de STOP con etiqueta, render determinístico de facturas/links, partición ≤1.400 chars.

### Modified Capabilities
- `ai-assistant`: guarda "agente activo" (SEC) + acción `stop` con labels por intent. *(Vive en `openspec/changes/ai-assistant-multiagent/specs/ai-assistant/` — sin archivar.)*

## Approach

Sin motor nuevo; se enchufa en las 6 etapas:

| Etapa | Cambio |
|---|---|
| 0 guardas | + guarda agente activo (C) |
| 4 hechos | + resolver GR `cliente.facturas` (A) |
| 5 redactar | el modelo escribe **solo texto corto**; links y cifras las arma el código |
| 6 SEC-4 | bloque determinístico **anexado post-verificación** → 0 rechazos por URLs con dígitos, 0 alucinación de montos |
| `executeAction` | + STOP con labels de la intent (B) |

**STOP gana** si el mensaje mezcla pago + reclamo. Se reusa `assistant-balance-guard` ("estás al día" solo con `debt ≤ 0` fresco) y `assistantPiiGuard` (al modelo solo montos, nros. de factura y vencimientos).

## Affected Areas

| Área | Impacto |
|---|---|
| `src/application/use-cases/assistant/` | guardas, STOP, precedencia |
| `src/infrastructure/adapters/assistant/` | resolver GR + renderer/splitter (New) |
| `domain/ports/` | gateway expone assignee y autoría de salientes |
| `prisma/schema.prisma` + migration | campo aditivo de labels |
| `src/infrastructure/http/app.ts` | ⚠️ God Object (3326 líneas) — wiring |
| seeds de catálogos | intents, acción, perfil, routing |

## Risks

| Riesgo | Prob. | Mitigación |
|---|---|---|
| Cobrar a un cliente sin servicio | Media | precedencia dura del STOP, pineada con test |
| Mensaje >1.600 chars rechazado | Media | splitter ≤1.400 + test con ≥6 facturas reales |
| GR caído/lento | Media | resolver degrada a no-op → handoff (port MUST NOT throw) |
| "Estás al día" sin dato fresco | Baja | `assistant-balance-guard` |
| Colisión de merge en `app.ts` | Alta | tocar solo el bloque del assistant |
| Decirle "no vemos tu pago" a alguien que pagó (GR caído) | Media | `recibos_no_disponibles` ⇒ deriva, nunca niega el pago (DAT-4) |
| Decir "estás al día" a quien pagó una parte | Media | el mensaje lo decide el SIGNO de `debt` fresco (RSP-1), pineado con el caso Vargas |
| Desasignar sólo en el espejo local y no en Chatwoot | Alta | ACT-4 exige los dos lados — `AssignConversation` NO habla con Chatwoot (verificado) |

## Rollback Plan

1. Flag `ai-assistant-enabled=false` (sin deploy). 2. `AssistantProfile.enabled=false` (kill parcial).
3. Volver a modo borrador (`private_note`). 4. Revert de código: la migration es aditiva con default, puede quedar.

## Dependencies

Labels `soporte`/`administracion` creadas en Chatwoot · API key en `AssistantProviderConfig` (hoy ausente) · credenciales GR vigentes (password diario).

## Success Criteria

- [ ] 0 respuestas de cobranza en conversaciones con reclamo de servicio (eval sobre conversaciones reales).
- [ ] 100% de montos, nros. de factura y links vienen de GR en la llamada del momento; 0 generados por el modelo.
- [ ] Ningún saliente supera 1.600 chars (cap 1.400), verificado con detalle de ≥6 facturas.
- [ ] 0 respuestas del bot en conversaciones asignadas a un humano o ya contestadas por un agente.
- [ ] Todo STOP deja etiqueta + nota privada con motivo; 0 STOP silenciosos.
- [ ] Semana 1 en borrador: ≥90% aprobados sin editar cifras ni links.
- [ ] 0 comprobantes dados por buenos "a ojo": todo comprobante se confirma contra un recibo de GR
      del día o deriva a Administración.
- [ ] 0 mensajes que digan "estás al día" con `debt > 0`.
- [ ] 100% de las promesas de pago quedan etiquetadas `administracion` y SIN asignar, en Chatwoot y
      en el inbox de Prominense.

## Open Questions

1. Perfil en **Facturación** (`e09fac32-…`) o **Administración** (`5c33f985-…`) como `defaultAreaId`.
2. Labels: `labels String[]` en `AssistantIntent` (aditivo) vs. catálogo `AssistantLabel` (normalizado).
3. Número equivocado / auto-respondedor: ¿intent con `resolve_conversation` o no-op silencioso?
