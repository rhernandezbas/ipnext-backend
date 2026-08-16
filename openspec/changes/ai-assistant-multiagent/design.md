# Design — `ai-assistant-multiagent`

Decisiones técnicas. Cada `D*` resuelve una pregunta abierta del `proposal.md` / `spec.md`.

---

## D1 — Bot CONVERSACIONAL de dos modos: conversa libre, actúa acotado

> **Corrección del usuario (2026-07-26):** *"el bot tiene que contestar al cliente y ser un bot
> conversacional"*. La primera versión de este diseño clasificaba UN mensaje y devolvía UNA
> respuesta: cada turno empezaba de cero, así que un "¿y cuándo vence?" después de una consulta de
> saldo caía en el vacío. Eso no conversa, dispara respuestas sueltas. Corregido acá.

**El insumo es el HILO, no el mensaje.** `ChatMessage` ya guarda la conversación completa espejada
de Chatwoot: el clasificador y el redactor reciben los últimos N turnos, no el último texto.

**Dos modos, y la frontera entre ellos es lo que hace segura la libertad conversacional:**

| Modo | Cuándo | Datos inyectados | Puede emitir cifras |
|---|---|---|---|
| **INFORMAR** | el hilo matchea un tema habilitado | los `dataSourceKeys` de ese tema | **Sí**, sólo las de los hechos |
| **CONVERSAR** | saludo, agradecimiento, repregunta, aclaración | **ninguno** | **No. Ninguna.** |
| **DERIVAR** | piden algo fuera de alcance | ninguno | — (avisa y hace handoff) |

```
1. CARGAR      → CÓDIGO: últimos N turnos del hilo (SEC-1 redacta PII de TODOS, no del último)
2. CLASIFICAR  → el modelo lee el HILO y devuelve: una key del set cerrado | 'charla' | 'fuera'
3. DECIDIR     → CÓDIGO: ¿intent enabled? ¿acción habilitada? ¿canReply? ¿opt-out? ¿flag?
4. RESOLVER    → CÓDIGO: los dataSources del tema (sólo en modo INFORMAR; en CONVERSAR: nada)
5. REDACTAR    → el modelo escribe con el hilo como contexto + los hechos (si los hay)
6. VERIFICAR   → CÓDIGO: SEC-4 (números) + longitud + formato   → si falla: handoff
7. EJECUTAR    → `whatsapp_reply` vía `SendMessage` + rastro en Chatwoot (D11)
```

Los pasos 1, 3, 4 y 6 son **tests unitarios puros**, sin modelo. Ahí vive toda la seguridad. El
modelo participa de 2 y 5, y en ambos su salida se valida antes de usarse.

### La propiedad que hace segura la charla libre

En modo CONVERSAR **no se inyecta ningún hecho**. Entonces el whitelist de SEC-4 queda vacío, y la
regla se vuelve trivial y absoluta:

> **Una respuesta en modo CONVERSAR que contenga cualquier secuencia de 3+ dígitos se descarta.**

No hace falta razonar sobre qué número es válido: en charla, **ningún** número lo es. Si el modelo
empieza a emitir cifras mientras charla, está alucinando por definición — y el verificador lo ataja
sin ambigüedad. La libertad conversacional no debilita la seguridad porque los dos modos están
separados en el código, no en el prompt.

**Guardrails del modo CONVERSAR** (en el prompt, además del verificador): prohibido prometer plazos,
cotizar precios, afirmar políticas comerciales o comprometer visitas. Puede saludar, acusar recibo,
repreguntar y explicar qué puede consultar.

**Costo.** El paso 2 es una llamada corta y barata (`classifierModel`, puede ser un modelo más chico
que `model`). El paso 5 corre siempre que haya algo que decir — que es lo esperable en un bot
conversacional.

## D2 — Registry de fuentes de datos (la frontera de CFG-3 hecha código)

```ts
// domain/ports/AssistantDataSourceRegistry.ts
export interface AssistantDataSourceResolver {
  readonly key: string;                  // debe existir en AssistantDataSource
  resolve(ctx: AssistantSubjectContext): Promise<Record<string, unknown>>;
}
```

`AssistantSubjectContext` MUST NOT declarar campos de identidad (SEC-1 garantizado por tipo):

```ts
export interface AssistantSubjectContext {
  clientId: string;        // opaco, para que el resolver consulte — NUNCA viaja al modelo
  conversationId?: string;
  ticketId?: string;
  areaId: string;
}
```

El registry se arma en `app.ts` (`Map<string, Resolver>`). Un `key` configurado sin resolver
registrado → validación 400 en config (CFG-3), y en runtime se omite con warn.

**Resolvers de la v1** (cada uno devuelve hechos planos, sin identidad):

| key | devuelve |
|---|---|
| `cliente.saldo` | `{ saldo, moneda, vencimiento, estado: 'al_dia'\|'vencido' }` |
| `cliente.servicio` | `{ estado, plan, velocidadMbps }` |
| `os.abiertas` | `{ cantidad, proxima: { fecha, ventana } \| null }` |
| `noc.cortes` | `{ hayCorteEnZona: bool, desde?, estimado? }` |
| `ticket.resumen` | `{ estado, area, antiguedadHoras, comentarios }` |

> `noc.cortes` arranca **deshabilitado en el catálogo**: mientras el hub NOC esté en modo oscuro,
> responder "no hay cortes" sería afirmar sin saber — justo el modo de falla que el change combate.
> Se habilita con un tilde cuando el hub esté en producción.

## D3 — SEC-4: cómo se verifica que el modelo no inventó un número

Verificador **puramente sintáctico y testeable**, sin modelo:

1. Se construye un **whitelist de literales numéricos** con:
   - (a) los valores numéricos de los hechos inyectados en ESTE turno, normalizados a sus
     representaciones válidas (`45000` → `45000`, `45.000`, `45,000`);
   - (b) los números de `persona`, `responseGuide` y `handoffMessage` del perfil (ahí viven "24
     horas", el teléfono de la empresa, etc.);
   - (c) **los números que escribió EL CLIENTE en el hilo.** Si el cliente dice "pagué 45000 ayer",
     el bot tiene que poder citarlo sin que el verificador lo mate.
2. De la salida del modelo se extraen todas las secuencias de dígitos de **3 o más** (las de 1-2 son
   ruido: "2 días", "el 5 de…"; las fechas se inyectan ya formateadas como hecho).
3. Toda secuencia fuera del whitelist ⇒ **la salida se descarta** ⇒ handoff + `outcome:
   'rejected_numbers'`.

### La asimetría que impide el lavado de una alucinación

**Los números que dijo EL BOT en turnos anteriores NO entran al whitelist.** Sólo los del cliente.

Sin esa asimetría hay una fuga grave: si el bot alucina "$54.000" en el turno 2, ese número queda en
el hilo; en el turno 5 lo repite, el verificador lo encuentra "en el historial" y lo aprueba. **El
error se lava: pasa a ser verdad por repetición**, y encima con el sello del propio verificador.
Cada turno vuelve a validarse contra los hechos frescos, nunca contra lo que el bot dijo antes.

### Modo CONVERSAR: whitelist vacío

En charla no se inyectan hechos ⇒ (a) queda vacío y sólo sobreviven (b) y (c). En la práctica:
**cualquier cifra inventada durante una charla se descarta**, sin necesidad de razonar cuál sería
válida (D1).

**Limitación documentada:** números escritos en letras ("cuarenta y cinco mil") escapan al
verificador. Mitigación: el prompt del paso 5 instruye escribir cifras en dígitos, y el verificador
rechaza salidas donde aparezcan marcadores de magnitud en letras (`mil`, `millones`) sin un dígito
acompañante. No es hermético; es una red que ataja el caso frecuente.

## D4 — Una sola superficie: conversaciones de Chatwoot

> **Corrección del usuario (2026-07-26):** *"dije tickets, pero me equivoqué, me refería a las
> conversaciones"*. Los tickets salen de alcance por completo: se elimina el `TicketSubjectGateway`,
> los enganches en `CreateTicket`/`AddTicketComment`, la fuente `ticket.resumen` y la columna
> `TicketComment.generatedByAssistant`.

El motor opera sobre `Conversation` y delega en los use cases existentes (RUN-3):
`SendMessage` para responder, `SetConversationArea` para reclasificar. No hay abstracción de
"sujeto": una superficie, un camino.

## D11 — El rastro tiene que ser visible EN CHATWOOT, no en Prominense

> **Corrección del usuario (2026-07-26):** *"la conversación no se maneja en Prominense, sino desde
> Chatwoot"*. Los agentes humanos trabajan **dentro de Chatwoot**.

Esto invalida la primera versión de OBS-2, que marcaba el mensaje con una columna
`generatedByAssistant` en nuestra base: **el agente que trabaja en Chatwoot no ve nuestra base.**
Para él, el mensaje del bot era indistinguible del de un compañero. Peor todavía: un handoff
"silencioso" (el bot decide no contestar y la conversación queda para el humano) **no le avisaba a
nadie** — el cliente preguntaba, el bot callaba, y nadie se enteraba.

La columna se mantiene (sirve para reportes y auditoría en Prominense), pero **no es el mecanismo de
visibilidad operativa**. Ése vive en Chatwoot, con métodos que `ChatwootGateway` YA expone:

| Situación | Rastro en Chatwoot |
|---|---|
| El bot respondió | `addConversationLabels(['bot-respondió'])` |
| El bot no pudo / fuera de alcance | `addConversationLabels(['necesita-humano'])` + `sendMessage(..., {private:true})` explicando por qué |
| SEC-4 descartó la salida | label `necesita-humano` + nota privada con el motivo |

La **nota privada** es el canal clave: la ve el agente dentro de Chatwoot, el cliente no. Es donde el
bot explica qué hizo o por qué se frenó, sin obligar a nadie a cambiar de herramienta.

Todos estos rastros son **best-effort**: si el label o la nota fallan, la respuesta al cliente ya
salió y el motor no debe romperse (RUN-1).

## D5 — Esquema Prisma (todo aditivo)

```prisma
model AssistantProfile {
  id              String  @id @default(uuid())
  areaId          String  @unique
  area            TicketAreaCatalog @relation(fields: [areaId], references: [id], onDelete: Cascade)
  enabled         Boolean @default(false)          // CFG-1: nace apagado
  persona         String  @default("")
  handoffMessage  String  @default("")
  model           String  @default("deepseek-chat")
  classifierModel String?                          // null ⇒ usa `model`
  timeoutMs       Int     @default(20000)
  enabledActions  String[] @default([])            // keys de AssistantAction habilitadas
  intents         AssistantIntent[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model AssistantIntent {
  id             String  @id @default(uuid())
  profileId      String
  profile        AssistantProfile @relation(fields: [profileId], references: [id], onDelete: Cascade)
  name           String
  description    String                            // material de matcheo del clasificador
  examples       String[] @default([])
  enabled        Boolean  @default(true)
  dataSourceKeys String[] @default([])
  responseGuide  String   @default("")
  actionKey      String
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([profileId, name])
  @@index([profileId])
}

model AssistantDataSource {           // CATÁLOGO — seed por migración idempotente
  key       String  @id
  label     String
  enabled   Boolean @default(true)
  updatedAt DateTime @updatedAt
}

model AssistantAction {               // CATÁLOGO — idem
  key       String  @id
  label     String
  riskLevel String                    // 'green' | 'yellow' | 'red'
  updatedAt DateTime @updatedAt
}

model AssistantRun {                  // OBS-1 — auditoría, sin PII ni prompt crudo
  id           String   @id @default(uuid())
  profileId    String?
  areaId       String?
  subjectType  String                 // 'conversation' | 'ticket'
  subjectId    String
  intentName   String?                // null ⇒ sin match
  dataSources  String[] @default([])
  actionKey    String?
  outcome      String                 // 'replied'|'handoff'|'noop'|'rejected_numbers'|'error'
  reason       String?
  latencyMs    Int?
  createdAt    DateTime @default(now())

  @@index([subjectType, subjectId])
  @@index([createdAt])
}
```

`ChatMessage` gana `generatedByAssistant Boolean @default(false)` y `TicketComment` idem (OBS-2:
marca **persistida**, no heurística sobre el texto).

**Migración:** 100% aditiva (`ADD COLUMN` / `CREATE TABLE`) ⇒ segura, se pushea directo (regla 3 del
workflow). El seed de los dos catálogos va **en la migración**, idempotente
(`INSERT … ON CONFLICT (key) DO NOTHING`) — el deploy corre `migrate deploy` pero **no** `db seed`
(regla 5).

## D6 — Wiring en `app.ts` (y su test de composition-root)

El bug W6 del EPIC #38 (rutas cableadas, hook nunca inyectado ⇒ feature muerta en prod con CI verde)
obliga a: **el wiring se verifica a mano contra este design Y se pinea con un composition-root test**
(assertions estáticas sobre el fuente de `app.ts`) que exija:

- el registry con los 5 resolvers,
- `AssistantRuntime` inyectado en `ReceiveChatwootWebhook`, `CreateTicket` y `AddTicketComment`,
- los dos `SubjectGateway`.

## D7 — RBAC en las dos capas

| Backend (colon) | Frontend (punto) |
|---|---|
| `assistant:read` | `assistant.read` |
| `assistant:manage` | `assistant.manage` |

Ambos namespaces se agregan a sus catálogos (son distintos, no asumir equivalencia). Toda ruta de
configuración lleva guard granular; la sub-página va con `RequirePermission`, los botones con `Can`.

## D8 — Prompt del paso 4 (redacción)

Estructura fija, armada por código:

```
[persona del perfil]
[responseGuide de la intención]

HECHOS (única fuente de verdad — no inventes ni calcules nada fuera de esto):
{ saldo: 45000, vencimiento: "2026-08-10", estado: "vencido" }

Reglas: escribí los números en dígitos. Si los hechos no alcanzan para responder,
respondé exactamente: NO_PUEDO_RESPONDER
```

El centinela `NO_PUEDO_RESPONDER` es la vía por la que el propio modelo pide handoff — barata,
determinística de detectar, y no depende de interpretar su prosa.

## D9 — Frontend

Sub-página **Config → Asistente IA**: lista de áreas con su estado, editor de perfil (persona,
handoff, modelo, acciones habilitadas con su chip de riesgo) y CRUD de intenciones (con selector
múltiple de fuentes). `Select`/`Combobox` **propio** (nunca nativo), tokens `var(--color-*)`, 4 ramas
de estado, doble confirmación al habilitar una acción `red`. Skill `ui-ux-pro-max` para el diseño y
las de Emil para el motion, antes de escribir UI.

En el hilo y en el ticket: marca visual del mensaje generado por el asistente (lee
`generatedByAssistant`, OBS-2).

## D10 — Riesgos técnicos asumidos

| # | Riesgo | Postura |
|---|---|---|
| 1 | Números en letras evaden a SEC-4 | Documentado en D3; mitigación parcial explícita |
| 2 | El clasificador se equivoca de intención dentro de la allowlist | Todas las intents de la allowlist son de bajo daño por diseño; el eval lo mide |
| 3 | Latencia de dos llamadas | WhatsApp es asincrónico (investigación 2026-07-26); no es restricción |
| 4 | `noc.cortes` afirmando sin datos | Deshabilitada en el seed hasta que el hub NOC salga de modo oscuro |
| 5 | Costo del clasificador en tráfico basura | Se corre DESPUÉS de SEC-2/SEC-5, que ya descartan lo obvio sin gastar |
