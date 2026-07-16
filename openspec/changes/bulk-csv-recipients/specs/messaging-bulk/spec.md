# Spec BE — bulk-csv-recipients (delta sobre messaging-bulk)

RFC-2119. Cada scenario cubierto por al menos un test verde (sdd-verify).

Delta ADITIVO sobre `messaging-bulk` + `messaging-campaign-manual-recipients`. NO reabre decisiones
LOCKED (send-path Twilio, opt-out enforcement en clientes, RBAC `messaging.bulk`, keyset del envío).
Agrega el 4to dominio de destinatarios: contactos crudos (`manualContacts`), con vinculación por
teléfono, persistencia sin `clientId` y preview con detalle por persona.

Vocabulario de motivos de exclusión (wire): `sin_nombre | sin_telefono | telefono_invalido |
opt_out | duplicado`. `baja` NO es motivo de exclusión — es flag no-excluyente (viaja como
`status: 'baja'` del item).

---

## Capability: creación de campaña — contactos CSV (`manualContacts`)

### Requirement: CSV-1 — campaña con contactos crudos, combinable
`CreateCampaign` MUST aceptar `manualContacts?: Array<{name: string, phone: string}>` PARALELO a
`segment` y `manualClientIds`. Una campaña MUST ser válida cuando tiene segmento filtrado, O
`manualClientIds` no vacío, O `manualContacts` no vacío, o cualquier combinación. Los destinatarios
finales MUST ser la UNIÓN de las tres fuentes, deduplicada por `clientId` y por `phoneNormalized`.

#### Scenario: solo segmento / solo manual (no-regresión)
- Given una campaña sin `manualContacts` (con segmento y/o `manualClientIds` como hoy)
- When se crea
- Then se resuelve y materializa EXACTAMENTE igual que antes de este change (suites existentes
  verdes sin cambiar aserciones de comportamiento)

#### Scenario: solo contactos CSV
- Given `segment: {statuses: []}`, sin `manualClientIds`, y `manualContacts: [{name:'Ana',
  phone:'11 2345-6789'}, {name:'Beto', phone:'011 15-3456-7890'}]` (ningún teléfono matchea un Client)
- When se crea la campaña
- Then se materializan 2 `CampaignRecipient` con `clientId: null`, `contactName` = nombre del CSV,
  `phoneE164` = `toWhatsAppE164(phone)` y NO se rechaza por segmento sin criterio

#### Scenario: segmento + manual + CSV (unión)
- Given un segmento que resuelve `[c1]`, `manualClientIds: [c2]` y `manualContacts` con 1 contacto
  no-cliente de teléfono distinto
- When se crea
- Then se materializan 3 recipients (c1, c2, contacto crudo)

### Requirement: CSV-2 — vinculación por teléfono
Cada contacto válido de `manualContacts` MUST matchearse contra la base de `Client` por igualdad de
clave `normalizePhone` (match EXACTO, no suffix). Si matchea, el recipient MUST crearse VINCULADO
(`clientId` del Client) y el candidato del CLIENTE MUST entrar al pipeline de compliance (opt-out,
status, balanceDue). En ambigüedad (2+ clientes con la misma clave) MUST ganar un cliente cuyo
`status != 'baja'` sobre uno `baja`, con desempate determinístico por `clientId` menor.

#### Scenario: contacto matchea cliente activo → vinculado
- Given un Client activo con `phone` que normaliza igual que el `phone` del contacto CSV
- When se crea la campaña con ese contacto
- Then el recipient se materializa con `clientId` = el del Client (NO `null`)

#### Scenario: contacto matchea cliente con opt-out → excluido
- Given un Client con `whatsappOptOutAt != null` cuyo teléfono matchea un contacto CSV
- When se crea/previsualiza
- Then ese contacto MUST quedar excluido (motivo `opt_out`), NUNCA materializado ni enviado

#### Scenario: contacto matchea cliente de baja → admitido y señalado
- Given un Client `status: 'baja'` (sin opt-out) cuyo teléfono matchea un contacto CSV
- When se crea/previsualiza
- Then el recipient SE ADMITE (vinculado, cuenta en `count`/`total`) y su item del preview lleva
  `status: 'baja'` (flag no-excluyente); `statusCounts.baja` lo refleja

#### Scenario: ambigüedad activo vs baja → gana el no-baja
- Given dos Clients (uno `active`, uno `baja`) cuyos teléfonos normalizan a la MISMA clave que un
  contacto CSV
- When se resuelve
- Then el vínculo MUST ser con el Client `active`

### Requirement: CSV-3 — contacto crudo: persistencia y envío sin Client
Un contacto que NO matchea ningún Client MUST persistirse con `clientId: null` y
`contactName` = nombre del CSV. En el envío (`SendCampaign`), un recipient con `clientId: null`
MUST saltear el re-check SEND-5 (no hay Client que consultar) y resolver variables así: `name` ←
`contactName`, `balanceDue` ← `''` (string vacío — NUNCA `"$0"`), `literal` ← su valor. El envío,
retry, backoff y persistencia de `sent`/`failed` MUST ser idénticos al path actual.

#### Scenario: envío a contacto crudo
- Given una campaña con un recipient `clientId: null`, `contactName: 'Ana'`, variableSpec
  `{1: {source:'name'}, 2: {source:'balanceDue'}}`
- When corre `SendCampaign`
- Then `sendTemplate` recibe `{1: 'Ana', 2: ''}` y el recipient queda `sent` con `providerId`

#### Scenario: recipient vinculado sigue con re-check (no-regresión)
- Given un recipient con `clientId` seteado cuyo Client pasó a opt-out DESPUÉS de crear la campaña
- When corre `SendCampaign`
- Then ese recipient MUST quedar `opted_out` sin envío (SEND-5 intacto)

### Requirement: CSV-4 — dedup cross-source con precedencia
La deduplicación por `phoneNormalized` MUST aplicar precedencia segmento > manual > CSV (extiende
FIX-1). Dentro de `manualContacts`, ante claves repetidas MUST ganar la PRIMERA aparición (orden
del archivo); las siguientes MUST excluirse con motivo `duplicado`. Un contacto cuyo teléfono (o
cuyo Client vinculado) ya está en la unión MUST excluirse con motivo `duplicado`.

#### Scenario: contacto duplica teléfono del segmento
- Given un segmento que resuelve al cliente c1 (teléfono X) y un contacto CSV con teléfono que
  normaliza a X
- When se crea/previsualiza
- Then se materializa/cuenta UN solo recipient (c1) y el contacto queda `duplicado`

#### Scenario: duplicado interno del CSV
- Given `manualContacts` con dos filas cuyos teléfonos normalizan igual
- When se resuelve
- Then entra la PRIMERA fila; la segunda queda excluida con motivo `duplicado`

### Requirement: CSV-5 — validación de payload, filas y cap
El parseo del body MUST ser fail-loud: `manualContacts` presente pero no-array, o con algún item
que no sea `{name: string, phone: string}` → 400 (`InvalidManualContactsError`). Más de 5000
contactos normalizados → 422 (`TooManyManualContactsError`). Por fila (defensa en profundidad —
el FE ya filtra): `name` vacío post-trim → excluida `sin_nombre`; `phone` vacío → `sin_telefono`;
`toWhatsAppE164(phone) === null` → `telefono_invalido`. Las exclusiones de fila MUST ser
silenciosas para la creación (la campaña se crea con las válidas) pero VISIBLES en el preview
(DET-2). Un item con `name` y `phone` ambos vacíos post-trim MUST descartarse en la normalización
(ni cap ni detalle).

#### Scenario: payload malformado → 400
- Given `manualContacts: [{name:'Ana', phone: 123}]` (phone no-string)
- When POST /campaigns o /segment/preview o /segment/recipients
- Then 400 VALIDATION_ERROR, nada persistido

#### Scenario: más de 5000 contactos → 422
- Given `manualContacts` con 5001 items válidos
- When se crea/previsualiza
- Then 422 tipado ANTES de tocar la DB

#### Scenario: fila con teléfono basura entra al preview como inválida, no rompe el create
- Given `manualContacts: [{name:'Ana', phone:'11 2345-6789'}, {name:'Beto', phone:'no-es-numero'}]`
- When se crea la campaña
- Then se materializa 1 recipient (Ana); Beto NO bloquea la creación y aparece como
  `telefono_invalido` en la vista de excluidos del preview

### Requirement: CSV-6 — preview agregado cuenta la unión de 3 fuentes
`PreviewCampaignSegment` MUST aceptar `manualContacts` y devolver `count` = unión deduplicada de
las 3 fuentes. `skipped` MUST reconciliar también las exclusiones de contactos (en los buckets
existentes del wire: `optedOut` += `opt_out` de vinculados; `duplicatePhone` += `duplicado`;
`invalidPhone` += `sin_nombre + sin_telefono + telefono_invalido`). `statusCounts` MUST incluir el
bucket `no_cliente` para los contactos crudos resueltos. Invariante: `count + Σ skipped` = personas
consideradas (candidatos del segmento + manuales no-overlap + contactos normalizados).

#### Scenario: preview solo-CSV
- Given 3 contactos: 1 válido no-cliente, 1 teléfono inválido, 1 vinculado a cliente opt-out
- When POST /segment/preview con solo `manualContacts`
- Then `count: 1`, `skipped.invalidPhone: 1`, `skipped.optedOut: 1`,
  `statusCounts: {no_cliente: 1}`

---

## Capability: preview con detalle por persona (`/segment/recipients` extendido — cierra deuda F4)

### Requirement: DET-1 — la unión completa en el listado paginado
`POST /api/messaging/bulk/segment/recipients` MUST aceptar `manualClientIds` y `manualContacts`
(además del segmento) y el guard MUST pasar a "hay destinatarios" (segmento filtrado O manuales O
contactos) — un preview solo-manual o solo-CSV MUST dejar de ser 400. Los items de la vista
`recipients` MUST exponer `clientId: string | null`, `name`, `phoneE164`, `status` (`'baja'`
señalable; `'no_cliente'` para crudos) y `source: 'segment' | 'manual' | 'csv'`.

#### Scenario: solo-manual ya no es 400 (cierra la deuda F4)
- Given body `{statuses: [], manualClientIds: ['c1']}` (c1 existe, enviable)
- When POST /segment/recipients
- Then 200 con `total: 1` y el item de c1 (`source: 'manual'`) — antes: 400 UNFILTERED_SEGMENT

#### Scenario: unión mixta con CSV
- Given segmento que resuelve [c1], `manualContacts` con 1 crudo válido
- When POST /segment/recipients
- Then `total: 2`; item de c1 `source:'segment'`; item crudo `clientId: null`,
  `status:'no_cliente'`, `source:'csv'`

### Requirement: DET-2 — vista `excluded`: detalle por persona, paginado
El endpoint MUST aceptar `view?: 'recipients' | 'excluded'` (default `'recipients'`, comportamiento
actual). Con `view:'excluded'` MUST devolver PAGINADO (`data/total/page/limit`) el detalle de cada
persona excluida: `{name, phone, reason, source, clientId?, status?}` con `reason ∈ {sin_nombre,
sin_telefono, telefono_invalido, opt_out, duplicado}`. El wire MUST estar SIEMPRE acotado por
`limit` (nunca fetch-all en la respuesta). Los `skipped`/`statusCounts` agregados MUST acompañar
ambas vistas.

#### Scenario: excluidos con motivo por persona
- Given `manualContacts` con: fila sin nombre, fila con teléfono basura, fila duplicada del
  segmento, contacto vinculado a cliente opt-out
- When POST /segment/recipients con `view:'excluded'`
- Then `data` contiene 4 items con `reason` respectivamente `sin_nombre`, `telefono_invalido`,
  `duplicado`, `opt_out` (con `name`/`phone` de cada persona)

#### Scenario: paginado de excluidos
- Given 30 exclusiones y `page: 2, limit: 20`
- When POST view excluded
- Then `data.length: 10`, `total: 30`, `page: 2`

#### Scenario: no-regresión del shape actual
- Given un body SIN `view` ni `manualClientIds` ni `manualContacts` (solo segmento)
- When POST /segment/recipients
- Then el shape y los valores de la respuesta son EXACTAMENTE los actuales

### Requirement: DET-3 — GET conserva paridad segment-only
El `GET /segment/recipients` MUST seguir aceptando el segmento + paginado por query-params y MAY
aceptar `view`; `manualContacts` MUST NOT viajar por query-string (payload arbitrario, límites de
URL) — el flujo con contactos usa POST.

#### Scenario: GET segment-only intacto
- Given `?statuses=late&page=1&limit=25`
- When GET /segment/recipients
- Then responde igual que hoy

---

## Capability: persistencia (`CampaignRecipient`)

### Requirement: PER-1 — migración aditiva
El schema MUST cambiar `CampaignRecipient.clientId` a nullable (relación opcional, `onDelete:
Cascade` conservado) y agregar `contactName String?`. `@@unique([campaignId, clientId])` MUST
conservarse. La migración MUST generarse con `npm run prisma:migrate` (sin SQL a mano) y MUST ser
puramente aditiva (sin backfill, sin rewrite).

#### Scenario: filas existentes intactas
- Given recipients de campañas viejas (todas con clientId)
- When corre la migración
- Then ninguna fila cambia; los uniques/índices existentes siguen

### Requirement: PER-2 — `bulkCreateRecipients` con filas contact
`CampaignRecipientCreateRow` MUST aceptar `clientId: string | null` y `contactName?: string | null`.
El adapter Prisma MUST: (1) persistir `contactName`; (2) garantizar idempotencia también para filas
con `clientId: null` — re-llamar con las mismas filas MUST NOT duplicar (pre-filtro por
`phoneNormalized` ya existente en la campaña); (3) re-fetchear el set persistido por
`phoneNormalized IN (...)` (NUNCA `clientId IN` — revienta con null). `InMemoryCampaignRepository`
MUST reflejar el mismo contrato.

#### Scenario: idempotencia de filas contact
- Given `bulkCreateRecipients(campaignId, [filaContact])` llamado DOS veces con la misma fila
- When se consulta `listRecipients`
- Then hay UNA sola fila

#### Scenario: mezcla vinculadas + crudas
- Given filas `[{clientId:'c1',...}, {clientId:null, contactName:'Ana',...}]`
- When bulkCreateRecipients
- Then devuelve ambas persistidas con sus campos

### Requirement: PER-3 — DTOs y entity tolerantes a null
La entity `CampaignRecipient` y `CampaignRecipientDto` MUST exponer `clientId: string | null` y
`contactName: string | null`. `GetCampaign` (detalle con recipients) MUST servir filas CSV sin
romper: `toCampaignRecipientDto` mapea ambos campos.

#### Scenario: detalle de campaña con recipient crudo
- Given una campaña con un recipient `clientId: null, contactName: 'Ana'`
- When GET /campaigns/:id?includeRecipients=true
- Then el item viaja con `clientId: null` y `contactName: 'Ana'`, resto del shape intacto

---

## Capability: proyección al inbox

### Requirement: PRJ-1 — proyección sin clientId
`ProjectSentMessageInput` MUST reemplazar `candidate` por `contactName: string`. `SendCampaign`
MUST pasar `candidate?.name ?? recipient.contactName ?? ''`. La proyección de un recipient crudo
MUST crear/appendear la conversación por `phoneE164` exactamente como hoy (`upsertBulkByPhone` es
phone-keyed; `Conversation` no tiene clientId) y setear `recipient.conversationId`. El contrato
best-effort/aislado (un fallo JAMÁS re-marca `failed`) MUST conservarse.

#### Scenario: contacto crudo aterriza en el inbox
- Given un envío `sent` a un recipient `clientId: null, contactName: 'Ana'`
- When corre la proyección
- Then existe una Conversation con `contactName: 'Ana'`, `contactPhoneE164` = phoneE164 del
  recipient, y un ChatMessage outbound `origin:'bulk'`; `recipient.conversationId` seteado

#### Scenario: no-regresión vinculados
- Given un envío a un recipient vinculado
- When corre la proyección
- Then la conversación lleva el nombre del CLIENTE (candidate fresco), igual que hoy
