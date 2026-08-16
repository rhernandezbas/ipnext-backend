# Proposal — `ai-assistant-multiagent`

> Agentes IA configurables **por área**, sobre conversaciones de WhatsApp (Chatwoot) **y** tickets.
> Fecha: 2026-07-26 · Pedido del usuario: *"quiero agregar a chatwoot un bot con ia"* → ampliado a
> *"multi agentes personalizados por area para cuando lleguen los tickets"*.

---

## 1. Intención

Un asistente IA que atiende **automáticamente** un set CERRADO de intenciones, con **una configuración
distinta por área** (Soporte / Facturación / Ventas / NOC / …), operando sobre las dos superficies de
entrada que ya existen en el sistema:

- **Conversaciones de WhatsApp** (mirror de Chatwoot) — el agente responde al cliente final.
- **Tickets** — el agente comenta, reclasifica y (a futuro) resuelve.

Todo lo que caiga fuera del set configurado hace **handoff a humano**: el agente no contesta y la
conversación/ticket sigue su curso normal.

## 2. Por qué ahora (y por qué es barato)

**Esto no es una integración nueva. Es una rama sobre infraestructura que ya está en producción.**

| Pieza necesaria | Estado |
|---|---|
| Ingreso de mensajes con HMAC verificado | ✅ `ReceiveChatwootWebhook` + `chatwootSignatureMw` |
| Espejo de conversaciones e historial | ✅ `Conversation` / `ChatMessage` / `ConversationEvent` |
| Resolución de cliente por teléfono | ✅ `toWhatsAppE164` + `GetClientContextByPhone` |
| Salida hacia el cliente | ✅ `SendMessage` → `ChatwootGateway.sendMessage` |
| Catálogo de áreas **compartido** tickets↔conversaciones | ✅ `TicketAreaCatalog` (#49/#69 + F1.5-C2) |
| Acciones sobre tickets | ✅ `AddTicketComment`, `UpdateTicket`, `CloseTicket`, `CreateTaskFromTicket` |
| Molde de puerto de IA que degrada sin romper | ✅ `InstallationAuditor` (MUST NOT throw) |
| Kill-switch en runtime | ✅ feature flags DB-backed (molde `iclass-audit`) |

Lo genuinamente nuevo: **un adapter HTTP a DeepSeek, una tabla de perfiles, y la decisión de cuándo
hablar.** El resto se enchufa.

## 3. Alcance

### 3.1 Backend

1. **Port `AssistantRuntime`** (`domain/ports/`) — molde `InstallationAuditor`: **MUST NOT throw**,
   cualquier fallo (modelo caído, timeout, salida inválida) degrada a no-op.
2. **Adapter `HttpDeepSeekAssistant`** (`infrastructure/adapters/deepseek/`) — **el ÚNICO archivo del
   repo que sabe que DeepSeek existe.**
3. **Modelo de configuración — TODO editable en runtime, sin deploy** (requisito duro del usuario,
   2026-07-26: *"lo más auto configurable posible, que pueda editarlo a futuro como quiera"*).
   Las intenciones **NO** son un `String[]` con vocabulario fijo en código: son **filas**.

   ```
   AssistantProfile          (1:1 con TicketAreaCatalog)
     enabled · persona · handoffMessage · model · timeoutMs
     └── intents: AssistantIntent[]        ← se cargan desde la UI

   AssistantIntent           (una fila = una intención, ALTA/BAJA sin deploy)
     name · description · examples[]        ← lo que lee el clasificador
     enabled
     dataSourceKeys[]                       ← qué datos se le pasan (checkboxes)
     responseGuide                          ← cómo debe responder
     actionKey                              ← qué hace: reply | handoff | comment | …

   AssistantDataSource       (CATÁLOGO — implementación en código, habilitación por config)
     key · label · enabled
     ej: cliente.saldo · cliente.servicio · os.abiertas · noc.cortes · plan.contratado

   AssistantAction           (CATÁLOGO — ídem)
     key · label · riskLevel                ← green | yellow | red (ver §7)
   ```

   **Frontera de seguridad (§6 R5):** agregar una *intención* es un formulario. Agregar una *fuente
   de datos* o una *acción* nueva requiere código — cada una es una puerta a la base, y permitir
   definirlas desde la UI sería una inyección SQL con formulario bonito. Habilitarlas por agente,
   en cambio, es un checkbox. En la práctica casi nunca limita: el catálogo se programa una vez y
   queda disponible para todos los agentes.

4. **Use case `ReplyWithAssistant`** — el motor único, **sin una sola intención hardcodeada**:
   resuelve perfil por área → carga sus `AssistantIntent` habilitadas → clasifica contra sus
   `description`/`examples` → resuelve las `dataSourceKeys` de la intención ganadora (SIN PII) →
   ejecuta la `actionKey` → o hace handoff. Agregar comportamiento = cargar filas, no tocar código.
5. **Enganches best-effort** (molde `captureAttachments` / `projectToInbox` — jamás tumban el flujo
   principal ni el ack 200 del webhook):
   - `ReceiveChatwootWebhook` → WhatsApp
   - `CreateTicket` + `AddTicketComment` → tickets
6. **Router = clasificador**: sin área asignada, una llamada barata clasifica e invoca
   `SetConversationArea` (existente) → queda evento `area_changed` → auditoría gratis.
7. **Feature flag** `ai-assistant-enabled` (seed OFF) — kill-switch global, independiente del
   `enabled` por perfil.

### 3.2 Frontend

8. Sub-página de configuración de agentes: un editor por área (persona, intenciones, acciones,
   handoff, modelo, ON/OFF), con `Select` propio (nunca nativo) y las 4 ramas de estado.
9. Visibilidad en el hilo/ticket: distinguir claramente qué escribió el agente y qué un humano.

### 3.3 Evaluación (no es opcional)

10. **Eval set** construido con ~100 conversaciones REALES del propio inbox
    (`Conversation`/`ChatMessage`), en dos particiones:
    - **resolución** — la respuesta correcta existe y se conoce
    - **abstención** — no existe respuesta buena; se mide si el agente **se calla**
11. El eval queda como **test de regresión permanente**: se corre ante cada cambio de modelo o de
    prompt. Sin él no se prende ninguna acción 🔴.

## 4. Fuera de alcance (v1)

- Acciones 🔴 (`close_ticket`, `create_task`) — el motor las soporta, quedan **apagadas** por config.
- Voz, llamadas, canales distintos de WhatsApp/tickets.
- Fine-tuning o entrenamiento de modelos.
- Self-hosting del modelo (evaluado y descartado: la RTX 2060 de 6 GB no corre un modelo del tamaño
  necesario — Qwen3-32B Q4 pide ~20-25 GB).

## 5. Decisiones tomadas (cerradas con el usuario)

| # | Decisión | Alternativas descartadas |
|---|---|---|
| D1 | **Autónomo acotado** (responde al cliente, allowlist cerrada, handoff fuera de ella) | Copiloto con nota privada; triage puro |
| D2 | **DeepSeek V4 Pro por su API oficial directa** (~US$19/mes a 40 chats/día) | Fireworks (~US$34/mes); Claude Sonnet 5 (~US$52/mes); self-hosted |
| D3 | **Un motor con N configuraciones**, no N bots | N agentes independientes |
| D4 | **Conversaciones + tickets desde el arranque** | Solo WhatsApp; solo tickets |
| D5 | El agente **nunca tiene camino propio de salida** — usa los use cases de los humanos | Adapter que escriba directo a Chatwoot/DB |
| D6 | **Auto-configurable al máximo**: intenciones/fuentes/acciones son FILAS, no vocabulario en código. Agregar comportamiento = cargar datos desde la UI | `allowedIntents: String[]` con enum fijo (primera versión, descartada por rígida) |

## 6. Reglas duras (invariantes, se pinean con tests)

### R1 — Cero PII en el prompt
El `AssistantRuntime` **NUNCA** recibe campos de identidad del `Client` (nombre, DNI, domicilio,
teléfono). Solo hechos derivados: `saldo`, `vencimiento`, `estado de servicio`, `OS abiertas`.
La identidad se resuelve del lado local; la personalización se hace por plantilla en post-proceso.

*Motivo:* la API oficial de DeepSeek procesa en China; el Art. 12 de la Ley 25.326 prohíbe transferir
datos personales a países sin nivel adecuado de protección. Si no viaja dato personal, el Art. 12 no
se activa.

*Limitación conocida y aceptada:* el mensaje **entrante** del cliente es texto libre y puede contener
PII que igual viaja. Se redactan los patrones evidentes (DNI/CUIT/email); la cobertura no es total.
Lo que sí se controla al 100% es **no agregar** datos de la base.

### R2 — Anti-loop
Solo se procesan mensajes con `direction === 'inbound'` y `private !== true`. Sin este filtro el
agente se auto-alimenta con el eco de su propia respuesta que Chatwoot reenvía por webhook.

### R3 — Ventana de 24 h
Se respeta `Conversation.canReply` (cache del flag de Chatwoot). Fuera de ventana, el agente **no
improvisa**: o usa template aprobado, o hace handoff.

### R4 — Los números salen de la DB
El modelo **redacta**; jamás calcula ni recuerda saldos, fechas ni estados. Todo dato duro viaja como
hecho ya resuelto por el backend.

### R5 — Frontera CONFIGURACIÓN vs CAPACIDAD

La regla que ordena todo el diseño: **la configuración es 100% editable en runtime; las capacidades
nuevas requieren código.**

| Editable desde la UI (sin deploy) | Requiere código |
|---|---|
| Crear/editar/borrar **agentes** por área | Una **fuente de datos** nueva (`AssistantDataSource`) |
| Crear/editar/borrar **intenciones** (nombre, ejemplos, guía de respuesta) | Una **acción** nueva (`AssistantAction`) |
| Qué fuentes de datos usa cada intención (checkbox) | R1 (cero PII), R2 (anti-loop), R3 (ventana 24 h), R4 (números de la DB) |
| Qué acción ejecuta cada intención | El opt-out BAJA/STOP |
| Persona, tono, mensaje de handoff, modelo, ON/OFF | La validación de que una acción 🔴 esté habilitada |

*Motivo de la frontera:* cada fuente de datos y cada acción es **una puerta a la base**. Definirlas
desde la UI sería una inyección con formulario. Habilitarlas, en cambio, es seguro y es un tilde.

*El operador compone comportamiento con piezas seguras; jamás fabrica piezas nuevas ni toca el
límite de seguridad.*

## 7. Gradiente de acciones y orden de encendido

```
🟢 comment_internal   lo lee un EMPLEADO — daño ~0
🟢 suggest_area       reclasificar — reversible
🟡 whatsapp_reply     lo lee el CLIENTE, en su teléfono
🟡 comment_public     lo lee el cliente
🔴 close_ticket       entierra un problema quizá vivo      → APAGADO en v1
🔴 create_task        despacha una cuadrilla (cuesta $)    → APAGADO en v1
```

El agente comentando **internamente** en tickets ejercita el motor completo en producción con
tráfico real, donde el único que ve un error es el propio equipo. Es el banco de pruebas ideal y
sale gratis.

## 8. Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| 1 | **Alucinación cuando no sabe** — la métrica crítica, no el resolution rate | Partición de abstención en el eval; allowlist cerrada; handoff por defecto |
| 2 | Loop de auto-respuesta | R2, pineado con test |
| 3 | Fuga de PII a jurisdicción sin nivel adecuado | R1, pineado con test |
| 4 | Un prompt mal editado desde la UI vuelve loco al agente | R5: los límites no son editables |
| 5 | Costo de mantener N agentes | El código no se multiplica; **N prompts + N evals sí**. Arrancar con 1 área prendida |
| 6 | Caída/latencia de DeepSeek | Port MUST NOT throw → no-op; el humano atiende como hoy |
| 7 | Deriva silenciosa al cambiar modelo o prompt | El eval como test de regresión |

## 9. Supuesto abierto (a confirmar en el spec)

**Allowlist inicial de intenciones**, propuesta y pendiente de validación del usuario:

| Intención | ¿Agente solo? | Razón |
|---|---|---|
| Estado de cuenta / cuánto debo | ✅ | Dato duro, cero ambigüedad |
| ¿Hay corte en mi zona? | ✅ | Sale del hub de alertas NOC ya construido |
| ¿Cuándo viene el técnico? | ✅ | Dato duro de la OS |
| Medios de pago | ✅ | Información estática |
| No tengo internet | ⚠️ handoff | Diagnóstico real, requiere criterio |
| Quiero darme de baja | ❌ handoff | Ya lo captura el opt-out; retención es humana |
| Cambio de plan | ❌ handoff | Es venta, no soporte |
| Reclamo / queja | ❌ handoff | Un bot contestando una queja es gasolina al fuego |

*Criterio de la línea:* el agente habla donde la respuesta es **un dato**; calla donde hace falta
**un juicio**.

## 10. Próximos pasos

`specs` → `design` → `tasks` → `apply` (TDD estricto) → review adversarial → `sdd-verify` → deploy
detrás de flag OFF (dark launch) → eval → encendido por área.
