# Spec — `ai-assistant` (asistente IA multi-agente, configurable por área)

RFC-2119. Cada scenario MUST quedar cubierto por al menos un test verde (`sdd-verify`).

Capability NUEVA. Base: `proposal.md` de este mismo change.

Prefijos: **CFG** configuración · **RTR** router/clasificador · **RUN** runtime ·
**SEC** seguridad (invariantes) · **ACT** acciones · **OBS** observabilidad · **EVAL** evaluación.

---

## Configuración (CFG) — todo editable en runtime

### Requirement: CFG-1 — un perfil por área, 1:1 con `TicketAreaCatalog`

MUST existir el modelo `AssistantProfile` con FK **`@unique`** a `TicketAreaCatalog`. Como ese
catálogo ya es compartido por `Ticket.areaId` y `Conversation.areaId`, un perfil MUST servir a las
dos superficies sin duplicación. Borrar un área MUST arrastrar su perfil (`onDelete: Cascade`).
`enabled` MUST tener default `false` (un perfil recién creado NUNCA habla sin acto explícito).

#### Scenario: alta de área nueva sin perfil
- Given un `TicketAreaCatalog` nuevo sin `AssistantProfile`
- When llega una conversación o ticket de esa área
- Then el motor hace **handoff** (no responde) y NO lanza

#### Scenario: el perfil nace apagado
- Given se crea un `AssistantProfile` sin especificar `enabled`
- Then `enabled === false` y el agente NO responde hasta que se lo habilite explícitamente

#### Scenario: borrar el área borra el perfil
- Given un área con perfil e intenciones cargadas
- When se borra el área del catálogo
- Then el perfil y sus intenciones se borran en cascada, sin filas huérfanas

### Requirement: CFG-2 — las intenciones son FILAS, no vocabulario en código

MUST existir `AssistantIntent` (N por perfil) con `name`, `description`, `examples[]`, `enabled`,
`dataSourceKeys[]`, `responseGuide`, `actionKey`. El motor MUST NOT contener ninguna intención
hardcodeada: agregar, editar, deshabilitar o borrar comportamiento MUST ser posible **sin deploy**,
vía las rutas CRUD de configuración.

#### Scenario: alta de intención sin deploy
- Given un perfil habilitado con 3 intenciones
- When se crea una 4ta intención vía API con `enabled:true`
- Then la siguiente invocación del motor la considera en la clasificación, sin reiniciar el proceso

#### Scenario: apagar una intención la saca del juego
- Given una intención con `enabled:false`
- When llega un mensaje que la matchearía
- Then el clasificador NO la considera candidata y el resultado es handoff (si no matchea otra)

### Requirement: CFG-3 — catálogos de fuentes y acciones: implementación en código, habilitación por config

MUST existir `AssistantDataSource` (`key`, `label`, `enabled`) y `AssistantAction`
(`key`, `label`, `riskLevel: 'green'|'yellow'|'red'`) como **catálogos**. Cada `key` MUST
corresponder a una implementación registrada en código. Una `dataSourceKeys[]` o `actionKey` que no
resuelva a una implementación registrada MUST ser rechazada en validación (400), NUNCA ejecutada.

El sistema MUST NOT ofrecer ningún camino para definir una fuente o una acción **nueva** desde la UI
o la API de configuración (frontera de seguridad, R5 del proposal): sólo habilitarlas y asignarlas.

#### Scenario: key inexistente rechazada en configuración
- Given el catálogo NO contiene la key `cliente.tarjeta`
- When se intenta guardar una intención con `dataSourceKeys:['cliente.tarjeta']`
- Then responde 400 y NO persiste

#### Scenario: fuente deshabilitada en el catálogo no se resuelve
- Given `AssistantDataSource('noc.cortes').enabled === false`
- And una intención habilitada que la referencia
- When el motor arma el contexto
- Then esa fuente NO se resuelve ni viaja al modelo; el resto del contexto se arma igual

---

## Router y clasificación (RTR)

### Requirement: RTR-0 — agente DEFAULT + re-ruteo (SUPERSEDE a RTR-1)

> **REEMPLAZA a RTR-1 (hallazgo bloqueante, 2026-07-26).** RTR-1 asumía que el motor podía
> clasificar el área desde cero. Se verificó que `Conversation.areaId` lo escribe ÚNICAMENTE
> `SetConversationArea` —acción manual en la UI de Prominense— y que los agentes trabajan en
> **Chatwoot**: las conversaciones de WhatsApp entran con `areaId = NULL` y nadie las clasifica.
> Un motor que exigiera área **nunca se habría activado**: feature inerte en producción con toda
> la suite en verde. Además, `TicketAreaCatalog` sólo tiene `name` y `color` — sin semántica,
> clasificar por área a ciegas rutearía mal y le contestaría el agente equivocado.

Cuando la conversación NO tiene `areaId`, el motor MUST resolver el perfil vía
`AssistantRoutingConfig.defaultAreaId`. Si no hay default, MUST no intervenir (`noop`).
El área EXPLÍCITA siempre gana: si un humano la clasificó, no se pisa.

Con `rerouteEnabled` y SÓLO cuando la conversación llegó sin área, si el agente default clasifica
`out_of_scope` el motor MUST buscar el tema entre las otras áreas con agente habilitado y, si lo
encuentra, reasignar vía **`SetConversationArea`** (dejando el evento `area_changed`) y dejar que
ese agente responda.

#### Scenario: sin área y sin default ⇒ silencio
- Given `defaultAreaId: null` (el valor del seed)
- When llega un mensaje en una conversación sin área
- Then el motor no interviene y no envía nada

#### Scenario: sin área con default ⇒ atiende el agente default
- Given `defaultAreaId` configurado y su perfil habilitado
- Then ese agente atiende la conversación

#### Scenario: el área puesta por un humano NO se pisa
- Given una conversación con `areaId` explícito
- Then se usa ese área aunque haya default, y el re-ruteo no corre

### Requirement: RTR-2 — clasificación de intención SÓLO contra las intenciones habilitadas del perfil

El clasificador MUST recibir como universo de candidatas exclusivamente las `AssistantIntent` con
`enabled:true` del perfil del área resuelta — NUNCA un vocabulario global ni las de otro perfil.
`description` y `examples[]` de cada fila son el material de matcheo.

#### Scenario: aislamiento entre perfiles
- Given el perfil "Ventas" tiene la intención `cambio de plan` habilitada
- And el perfil "Facturación" NO la tiene
- When llega un mensaje de cambio de plan en una conversación del área Facturación
- Then el motor NO la matchea y hace handoff

### Requirement: RTR-3 — default deny: sin match, handoff

Si ninguna intención habilitada matchea, el motor MUST hacer **handoff**: no responde al cliente,
deja la conversación/ticket intacto para el humano, y emite el `handoffMessage` del perfil sólo si
éste está configurado y la acción `reply` está habilitada. **La ausencia de configuración MUST
resolver siempre a "no hablar", nunca a "improvisar".**

#### Scenario: mensaje fuera de la allowlist
- Given un perfil habilitado cuyas intenciones no cubren "quiero hacer un reclamo"
- When el cliente escribe eso
- Then el motor NO genera respuesta de contenido; la conversación queda para el humano

---

## Conversación (CONV) — el bot es conversacional, no un matcher de una sola pregunta

### Requirement: CONV-1 — el insumo es el HILO, no el último mensaje

El clasificador (RTR-2) y el redactor MUST recibir los últimos N turnos de la conversación
(`ChatMessage`, ya espejados de Chatwoot), no sólo el texto entrante. Un turno que sólo se entiende
en contexto ("¿y cuándo vence?") MUST resolverse contra el tema que la conversación ya traía.

#### Scenario: seguimiento que depende del turno anterior
- Given un hilo donde el cliente ya consultó su estado de cuenta y el bot respondió
- When el cliente escribe "¿y cuándo vence?"
- Then el clasificador resuelve el MISMO tema (estado de cuenta) y el bot responde en contexto

#### Scenario: cambio de tema a mitad del hilo
- Given un hilo sobre estado de cuenta
- When el cliente escribe "che, y hay corte en mi zona?"
- Then el clasificador resuelve el tema nuevo, no el anterior

### Requirement: CONV-2 — dos modos: INFORMAR y CONVERSAR

El motor MUST distinguir dos modos de respuesta:

- **INFORMAR** — el hilo matchea un tema habilitado. Se inyectan los `dataSourceKeys` de ese tema y
  la respuesta PUEDE contener cifras, sujetas a SEC-4.
- **CONVERSAR** — saludo, agradecimiento, repregunta o aclaración. **NO se inyecta ningún hecho.**
  El bot MUST poder saludar, acusar recibo, repreguntar y explicar qué puede consultar, sin derivar.

Un saludo o un "gracias" MUST NOT producir handoff (RTR-3 aplica a los PEDIDOS fuera de alcance, no
a la charla).

#### Scenario: saludo no dispara handoff
- Given un perfil habilitado
- When el cliente escribe "hola"
- Then el bot responde en modo CONVERSAR y la conversación NO se deriva

#### Scenario: repregunta cuando falta un dato
- Given un tema habilitado que necesita una precisión que el cliente no dio
- When el motor no puede responder con lo que hay
- Then el bot repregunta en vez de derivar

### Requirement: CONV-3 — en modo CONVERSAR ninguna cifra es válida

Como en modo CONVERSAR no se inyectan hechos, el whitelist de SEC-4 no contiene valores de datos.
Toda secuencia de 3+ dígitos en una respuesta de charla que no provenga del perfil o del propio
cliente MUST descartar la salida (`outcome: 'rejected_numbers'`).

#### Scenario: el bot inventa un monto mientras charla
- Given el bot responde en modo CONVERSAR
- And su salida contiene "$45.000"
- Then la salida se descarta y no se envía nada al cliente

### Requirement: CONV-4 — guardrails de la charla libre

En modo CONVERSAR el bot MUST NOT prometer plazos, cotizar precios, afirmar políticas comerciales ni
comprometer visitas. Ante un pedido de esa naturaleza MUST decirlo y derivar (modo DERIVAR).

#### Scenario: piden un precio en charla
- Given el cliente pregunta "¿cuánto sale subir de plan?"
- And no hay tema habilitado que lo cubra
- Then el bot no cotiza, avisa que lo deriva, y la conversación queda marcada para un humano

### Requirement: CONV-5 — SEC-1 se aplica sobre TODO el hilo

La redacción de PII (SEC-1) MUST recorrer todos los turnos que se envían al modelo, no sólo el
mensaje entrante. Un DNI escrito ocho mensajes atrás viaja igual si el hilo se manda completo.

#### Scenario: PII en un turno viejo del hilo
- Given el cliente escribió su DNI en un mensaje anterior del mismo hilo
- When el motor arma el contexto con los últimos N turnos
- Then ese DNI aparece redactado en el payload enviado al modelo

## Runtime del motor (RUN)

### Requirement: RUN-1 — el port `AssistantRuntime` MUST NOT throw

Molde `InstallationAuditor`: cualquier fallo (modelo caído, timeout, salida inválida, JSON
malformado, fuente de datos que revienta) MUST degradar a **no-op** silencioso-logueado. El motor
MUST NOT propagar excepciones a sus call sites.

#### Scenario: proveedor caído no rompe el webhook
- Given el adapter de IA lanza timeout
- When llega un `message_created` inbound
- Then el mensaje se espeja igual, la ruta responde **200**, y no se envía nada al cliente

#### Scenario: salida inválida del modelo
- Given el modelo devuelve texto que no cumple el contrato esperado
- Then el motor descarta la salida, loguea y hace handoff — NUNCA envía la salida cruda

### Requirement: RUN-2 — enganches best-effort, aislados del flujo principal

La invocación del motor desde `ReceiveChatwootWebhook`, `CreateTicket` y `AddTicketComment` MUST ir
en rama aislada (molde `captureAttachments` / `projectToInbox`): un fallo del asistente MUST NOT
alterar el espejado del mensaje, la creación del ticket, el comentario, ni el status HTTP de la ruta.

#### Scenario: el ticket se crea aunque el asistente falle
- Given el motor lanza internamente
- When se crea un ticket
- Then el ticket queda creado y la ruta responde 201

### Requirement: RUN-3 — el agente NO tiene camino propio de salida

Toda salida MUST pasar por los use cases existentes: `SendMessage` (WhatsApp),
`AddTicketComment` / `UpdateTicket` (tickets). El motor MUST NOT invocar `ChatwootGateway` ni
escribir en repositorios de mensajes/tickets directamente.

#### Scenario: la respuesta queda en el historial como cualquier otra
- Given el agente responde en WhatsApp
- Then existe una fila `ChatMessage` outbound y `lastMessageAt`/preview se bumpean igual que con un
  agente humano

### Requirement: RUN-4 — kill-switch global independiente del perfil

MUST existir el feature flag DB-backed `ai-assistant-enabled` (seed **OFF**). Con el flag OFF, el
motor MUST ser un no-op total sin importar cuántos perfiles estén `enabled`. El flag se lee **por
invocación**, no cacheado al boot.

#### Scenario: flip a OFF corta todo en caliente
- Given 3 perfiles habilitados y el flag ON
- When se pone el flag en OFF
- Then la siguiente invocación no consulta al modelo ni envía nada

---

## Invariantes de seguridad (SEC) — NO editables desde la UI

### Requirement: SEC-1 — cero PII en el prompt

El `AssistantRuntime` MUST NOT recibir campos de identidad del `Client` (nombre, apellido,
documento, domicilio, email, teléfono). Sólo hechos derivados. El tipo de entrada del port MUST NOT
declarar esos campos (la garantía es de compilación, no de disciplina). La personalización con
nombre, si se requiere, MUST resolverse por plantilla en post-proceso local.

#### Scenario: el contexto no contiene identidad
- Given un `Client` con nombre, DNI y domicilio cargados
- When el motor arma el contexto para una intención de estado de cuenta
- Then el payload enviado al adapter contiene saldo/vencimiento/estado y **ningún** campo de identidad

#### Scenario: redacción best-effort del mensaje entrante
- Given el cliente escribe "soy Juan Pérez, DNI 20.123.456"
- When se arma el prompt
- Then los patrones de DNI/CUIT/email se redactan antes de enviar
- And se documenta que la cobertura no es total (texto libre)

### Requirement: SEC-2 — anti-loop

MUST procesarse únicamente lo que cumpla `direction === 'inbound'` **y** `private !== true`.
Sin este filtro el eco `message_created` de la propia respuesta del agente lo re-dispara en bucle.

#### Scenario: el eco de la propia respuesta no re-dispara
- Given el agente respondió y Chatwoot reenvía ese mensaje como `message_created` outbound
- When llega ese webhook
- Then el motor NO se invoca

#### Scenario: nota privada no dispara
- Given un `message_created` con `private:true`
- Then el motor NO se invoca

### Requirement: SEC-3 — ventana de 24 h

Con `Conversation.canReply === false`, el motor MUST NOT enviar texto libre. MUST hacer handoff o
usar un template aprobado por el gate existente. `canReply` se lee del mirror; NUNCA se recalcula.

#### Scenario: fuera de ventana no improvisa
- Given `canReply:false`
- When el motor resuelve una respuesta de contenido
- Then no se envía texto libre y la conversación queda para el humano

### Requirement: SEC-4 — los números salen de la DB, el modelo sólo redacta

Todo dato duro (saldo, fecha, estado, cantidad) MUST viajar al modelo como hecho ya resuelto por el
backend. El motor MUST NOT aceptar como válido un número presente en la salida del modelo que no
provenga del contexto inyectado.

#### Scenario: el modelo altera un monto y se descarta
- Given el contexto inyecta `saldo: 45000`
- And el modelo devuelve un texto que menciona `54000`
- Then la salida se descarta y se hace handoff (o se re-pide), NUNCA se envía

### Requirement: SEC-5 — el opt-out tiene precedencia absoluta

Si el cliente está en opt-out (BAJA/STOP, OPT-1/OPT-2 existentes), el motor MUST NOT enviarle nada,
sin importar la configuración del perfil.

#### Scenario: cliente dado de baja del canal
- Given un `Client` con opt-out registrado
- Then el motor no envía ninguna respuesta, aunque la intención matchee y el perfil esté habilitado

---

## Acciones (ACT)

### Requirement: ACT-1 — la acción se ejecuta sólo si está habilitada para ese perfil

MUST validarse, por invocación, que la `actionKey` de la intención ganadora esté presente y
habilitada en la configuración del perfil. Una acción no habilitada MUST resolver a handoff.

#### Scenario: intención con acción no habilitada
- Given una intención con `actionKey:'close_ticket'` y el perfil sin esa acción habilitada
- Then el motor NO cierra el ticket y hace handoff

### Requirement: ACT-2 — acciones `red` apagadas en v1, con gate explícito

`close_ticket` y `create_task` (`riskLevel:'red'`) MUST venir **deshabilitadas** en el seed.
Habilitarlas MUST requerir un acto de configuración explícito y MUST quedar auditado.

#### Scenario: seed conservador
- Given una instalación nueva
- Then ninguna acción `red` está habilitada en ningún perfil

---

## Observabilidad (OBS)

### Requirement: OBS-1 — toda intervención del agente queda auditada

Cada vez que el agente actúa (responde, comenta, reclasifica) o hace handoff, MUST registrarse:
área, perfil, intención ganadora (o "sin match"), fuentes resueltas, acción ejecutada y resultado.
La auditoría MUST NOT contener PII ni el prompt crudo.

#### Scenario: handoff auditado
- Given un mensaje sin match de intención
- Then queda registro del handoff con el motivo, sin contenido del cliente

### Requirement: OBS-2 — el humano distingue qué escribió el agente, EN CHATWOOT

> **REVISADO (sdd-verify, 2026-07-26).** La primera versión exigía una marca PERSISTIDA en el
> mirror (`ChatMessage.generatedByAssistant`). Se implementó la columna… y quedó **muerta**: nadie
> la escribía y nadie la leía. La causa es rastreable: cuando se confirmó que los agentes trabajan
> DENTRO de Chatwoot (D11), la responsabilidad de "que se note" se mudó al propio Chatwoot y la
> columna quedó como resto de un diseño anterior. Schema muerto es PEOR que no tener schema
> —invita a que alguien confíe en él— así que se removió y el requisito se reescribe acá para
> exigir lo que realmente cumple el objetivo.

Toda intervención del agente MUST dejar rastro VISIBLE EN CHATWOOT, que es donde trabajan los
agentes humanos:

- respondió ⇒ label `bot-respondió`
- no pudo / fuera de alcance / cifra descartada / fallo interno ⇒ label `necesita-humano` **y**
  nota privada con el motivo

El rastro MUST ser best-effort: si Chatwoot falla después de que la respuesta salió, el motor NO
se rompe (RUN-1).

#### Scenario: el agente respondió
- Given el agente respondió en una conversación
- Then la conversación queda etiquetada `bot-respondió` en Chatwoot

#### Scenario: el agente NO pudo — el humano se entera
- Given cualquier camino que termine sin responder (fuera de alcance, acción no habilitada,
  fuera de ventana, el modelo se declaró incapaz, SEC-4 descartó la salida, fallo interno)
- Then la conversación queda etiquetada `necesita-humano` y con una nota privada que explica
  por qué
- And NO se le envía nada al cliente

#### Scenario: Chatwoot caído al dejar el rastro
- Given la respuesta al cliente ya salió y el label falla
- Then el motor devuelve `replied` igual y no lanza

---

## Evaluación (EVAL)

### Requirement: EVAL-1 — eval set de dos particiones, construido con datos reales

MUST existir un eval reproducible sobre ~100 conversaciones reales del propio inbox, con dos
particiones: **resolución** (la respuesta correcta existe y se conoce) y **abstención** (no existe
respuesta buena; se mide si el agente se calla). Ambas métricas MUST reportarse por separado.

#### Scenario: la abstención se mide, no se asume
- Given la partición de abstención
- When corre el eval
- Then el reporte incluye la tasa de abstención correcta como métrica de primer orden

### Requirement: EVAL-2 — el eval es gate de las acciones `red`

Habilitar una acción `riskLevel:'red'` MUST requerir un corrida de eval registrada. Sin eval, la
habilitación MUST rechazarse.

#### Scenario: intento de habilitar sin eval
- Given ninguna corrida de eval registrada
- When se intenta habilitar `create_task` en un perfil
- Then la operación es rechazada con el motivo
