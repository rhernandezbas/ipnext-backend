# Design — bulk-csv-recipients

Decisiones numeradas D1..D12, cada una con evidencia del código real (`file:line` del worktree
`feat/bulk-csv-recipients` BE y de `ipnext-frontend@main`).

---

## §0. Estado actual del pipeline (evidencia)

**Creación** (`CreateCampaign.ts:39-104`): normaliza `manualClientIds` → guard
`assertHasRecipients(segment, manualClientIds)` (`assertHasRecipients.ts:13-16`) → valida template
approved + variables → `resolveCombinedRecipients` (unión segmento ∪ manual, dedup por `clientId` Y
por `phoneNormalized` con precedencia segmento, `resolveCombinedRecipients.ts:129-151`) →
`campaignRepo.create` + `bulkCreateRecipients` con filas `{clientId, phoneNormalized, phoneE164}`
(`CreateCampaign.ts:94-101`).

**Compliance** (`resolveRecipients.ts:54-102`): opt-out (`whatsappOptOutAt != null`) excluido
SIEMPRE; `toWhatsAppE164(phone) === null` → `excludedNoPhone`; dedup por `normalizePhone` (gana
`clientId` menor). Devuelve CONTADORES, no detalle — la raíz de que el preview no pueda mostrar
"quién y por qué".

**Cap manual**: `MAX_MANUAL_RECIPIENTS = 5000` (`resolveCombinedRecipients.ts:21`), chequeado ANTES
de tocar la DB (`:83-85`) → `TooManyManualRecipientsError` 422.

**Preview agregado** (`PreviewCampaignSegment.ts:43-64`): `count` + `sample(20)` +
`skipped {optedOut, duplicatePhone, invalidPhone}` (suma segmento+manual) + `statusCounts`.

**Preview paginado** (`ListSegmentRecipients.ts:33-68`): SOLO segmento
(`assertSegmentIsFiltered`, `:36`), re-resuelve el universo y pagina el array en memoria — tradeoff
recall-over-pagination documentado (`:15-24`). Rutas `POST/GET /segment/recipients`
(`messagingBulk.routes.ts:176-220`) NO parsean `manualClientIds` → **deuda F4** que el FE
documenta y parchea con un aviso (`PreviewModal.tsx:20-29, 226-237`) y un gate segment-only
(`PreviewModal.tsx:93-104`).

**Persistencia** (`prisma/schema.prisma:3000-3027`): `CampaignRecipient.clientId String` NOT NULL
(FK a `Client`, `:3004-3005`), `@@unique([campaignId, clientId])` (`:3024`).
`PrismaCampaignRepository.bulkCreateRecipients` (`:142-158`): `createMany({skipDuplicates: true})`
(idempotencia por ese unique) + re-fetch `where: { campaignId, clientId: { in } }`.

**Envío** (`SendCampaign.ts:121-137`): por recipient, `findRecipientCandidate(recipient.clientId)`
(SEND-5 re-check opt-out) → `resolveCampaignVariables(spec, candidate)` (`:319-338`): `name` ←
`candidate.name`, `balanceDue` ← `formatArs(...)` o `''` si null (FIX-18, `:287-299`), `literal` ←
`value`.

**Proyección** (`PrismaCampaignInboxProjector.ts:26-48`): `upsertBulkByPhone(recipient.phoneE164,
{contactName: candidate.name, ...})` — del candidate usa SOLO `.name`. `Conversation` NO tiene
`clientId`; keyea por `contactPhoneE164` (`schema.prisma:2807-2823`,
`ConversationRepository.ts:109-134`).

**Teléfonos**: `toWhatsAppE164` (`toWhatsAppE164.ts:30-55`) reconstruye `+549` + NSN(10) o `null`
(nunca un número equivocado); `normalizePhone` (`matchActiveClient.ts:38-59`) es la clave LOSSY de
dedup/match. `Client.phone` es String NOT NULL sucio (`schema.prisma:176`); `ClientStatus` incluye
`baja` (`schema.prisma:226-232`).

**FE composer** (`CampaignComposer.tsx`): estado `manualRecipients` (`:66`), payload
`manualClientIds` omitido si vacío (`:85-88, 161-163`), gate `hasRecipients(segment,
manualClientIds)` (`segmentCriteria.ts:37-39`), debounce 500ms con deps primitivas (`:96-109`).
`useSegmentRecipients` → `POST /segment/recipients` con SOLO el segmento
(`messagingBulk.api.ts:61-70`). No hay ninguna lib CSV en `package.json` del FE (verificado).

---

## D1 — Modelo de datos: `clientId` nullable + `contactName` (migración aditiva)

**Decisión**: en `CampaignRecipient`:

```prisma
clientId    String?                    // era NOT NULL
client      Client?  @relation(...)    // relación opcional (onDelete: Cascade se mantiene)
contactName String?                    // snapshot del nombre del CSV (solo filas contact)
```

Se **CONSERVA** `@@unique([campaignId, clientId])` — sigue protegiendo las filas vinculadas
exactamente como hoy; en PG los NULL son distintos entre sí en un unique (mismo precedente ya
usado en `Conversation.chatwootConversationId`, `schema.prisma:2809-2812`), así que N filas
contact conviven.

**Alternativa rechazada — tabla `Contact` separada + FK**: el contacto crudo no tiene ciclo de
vida propio (no se lista, no se edita, no se reusa — Scope OUT); una tabla extra agrega un JOIN a
todos los paths (send/list/keyset) para 2 campos denormalizables. Los campos "sueltos"
(`contactName` junto a `phoneNormalized`/`phoneE164` que YA viven en el recipient) son el molde
existente: el recipient ya ES un snapshot auditable (`schema.prisma:3006-3007`).

**Alternativa rechazada — `@@unique([campaignId, phoneNormalized])` para idempotencia universal**:
(1) pre-FIX-1 pudieron materializarse duplicados de teléfono dentro de una campaña en prod (el
propio fix wave lo describe: "materializaba 2 recipients → 2 WhatsApp al mismo número",
`tasks.md` de messaging-campaign-manual-recipients FIX-1) — el CREATE UNIQUE INDEX fallaría el
deploy; (2) un índice parcial `WHERE clientId IS NULL` lo evitaría, pero Prisma no lo soporta en
PSL y editar el SQL de la migración a mano está prohibido (CLAUDE.md: "jamás editar SQL a mano").

**Idempotencia de filas contact** (clientId NULL): la garantiza el adapter — ver D2.

**Migración**: `npm run prisma:migrate` genera `ALTER TABLE ... ALTER COLUMN "clientId" DROP NOT
NULL` + `ADD COLUMN "contactName" TEXT` — aditivo, sin rewrite ni backfill, seguro en prod.

## D2 — `bulkCreateRecipients`: filas contact y el re-fetch roto

`CampaignRecipientCreateRow` pasa a `{clientId: string | null, contactName?: string | null,
phoneNormalized, phoneE164}` (`CampaignRepository.ts:40-44`).

Dos gotchas encontrados en `PrismaCampaignRepository.ts:142-158`:

1. **Re-fetch**: hoy re-fetchea `where: { campaignId, clientId: { in: clientIds } }` (`:153-156`)
   — con `null` en la lista Prisma revienta/omite. Cambia a `phoneNormalized: { in: ... }`
   (NOT NULL SIEMPRE, y único dentro del set resuelto por construcción — FIX-1 dedupea la unión
   por teléfono). Contrato idéntico: devuelve nuevas + ya existentes.
2. **Idempotencia contact**: `skipDuplicates` solo dedupea vía unique — las filas NULL no chocan.
   El adapter pre-filtra: `findMany({where: {campaignId}, select: {phoneNormalized}})` y descarta
   las filas entrantes cuyo `phoneNormalized` ya existe en la campaña. Una query narrow extra SOLO
   cuando hay filas (la campaña recién creada tiene 0 filas → set vacío). No hay carrera real:
   `bulkCreateRecipients` se llama UNA vez, inmediatamente después de `campaignRepo.create`, desde
   el mismo request (`CreateCampaign.ts:81-101`); el unique de clientId sigue siendo la red para
   las vinculadas. `InMemoryCampaignRepository` refleja el mismo contrato.

## D3 — Vinculación por teléfono: escape hatch OPT-2, match exacto por `normalizePhone`

**Decisión**: para resolver `manualContacts`, el helper llama
`segmentSource.listSegmentRecipients({statuses: []})` — el escape hatch YA documentado para
"matchear un teléfono inbound contra CUALQUIER estado (`late`/`blocked`/`baja`)"
(`PrismaCustomerRepository.ts:224-227`, `buildSegmentWhere` con statuses vacío = universo completo,
select narrow con `status`, `:429-438`). Se construye `Map<normalizePhone(client.phone),
candidate>` y se matchea cada contacto por su clave. **Cero port nuevo, cero query nueva** — misma
memoria que cualquier resolución de segmento (tradeoff recall-over-pagination ya aceptado,
`ListSegmentRecipients.ts:15-24`). Solo se paga cuando `manualContacts` no está vacío.

**Match EXACTO por clave normalizada, NO `suffixMatch`**: `GetClientContextByPhone` usa suffix
(`GetClientContextByPhone.ts:24`) porque su output es CONTEXTO informativo del inbox; acá el match
decide OWNERSHIP del envío (nombre, deuda, opt-out del cliente en el mensaje) — un falso positivo
manda la deuda de OTRO. Exacto sobre la misma clave que ya dedupea el pipeline (FIX-1) es
consistente y conservador.

**Ambigüedad** (2+ clientes con la misma clave): gana el NO-`baja` sobre el `baja` (el vínculo debe
reflejar al titular vigente), desempate por `clientId` menor (determinístico — mismo criterio que
`resolveRecipients.ts:88-90`).

**Semántica del vínculo**:
- Matchea cliente → recipient VINCULADO: `clientId` seteado, y el candidato del CLIENTE entra al
  pipeline (opt-out respetado, `status` real para el flag `baja`, `balanceDue` real).
- No matchea → contacto crudo: `clientId: null`, `contactName` = nombre CSV, status sintético
  `'no_cliente'` para statusCounts/preview.

## D4 — Variables de template para el 4to dominio

| Fuente (`CampaignVariableSource`) | Vinculado (clientId set) | Crudo (clientId null) |
|---|---|---|
| `name` | `Client.name` (candidate fresco, path intacto) | `contactName` (nombre del CSV) |
| `balanceDue` | `formatArs(balanceDue)` o `''` si null (FIX-18) | `''` SIEMPRE (no hay Client → monto no confirmable; precedente FIX-18: JAMÁS inventar "$0", `SendCampaign.ts:287-299`) |
| `literal` | `entry.value` | `entry.value` |

**Vinculado → gana el dato del Client (incluido el nombre)**: un solo camino de resolución
(`resolveCampaignVariables` intacto para vinculados), cero semántica duplicada, y el dato vivo del
cliente (deuda, opt-out) es EL motivo de vincular. El nombre que tipeó el operador en el CSV queda
auditado en `contactName` igual.

## D5 — `SendCampaign`: branch por `clientId === null`

`processRecipient` (`SendCampaign.ts:121-137`) hoy hace `findRecipientCandidate(recipient.clientId)`
y skippea si no resuelve. Nuevo flujo:

- `recipient.clientId != null` → **path EXACTO actual** (re-check opt-out SEND-5, skip si el
  Client desapareció, variables del candidate).
- `recipient.clientId == null` → NO hay lookup ni re-check posible (el opt-out vive en
  `Client.whatsappOptOutAt` — un contacto crudo no tiene registro; Scope OUT documentado).
  Variables: `{name: recipient.contactName ?? '', balanceDue: null}` por la misma
  `resolveCampaignVariables` (recibe un "contact candidate" sintetizado SOLO en este branch, no
  persiste). Envío/retry/persist idénticos.

Requiere `contactName` en la entity `CampaignRecipient` (`campaign.ts:71-96`) y en `toCampaignRecipient`.

## D6 — `ProjectSentMessageInput`: `candidate` → `contactName` (refactor mínimo del port)

Verificado: el projector usa del candidate ÚNICAMENTE `.name`
(`PrismaCampaignInboxProjector.ts:35`); el resto keyea por `recipient.phoneE164` (`:32-38`).

**Decisión**: `ProjectSentMessageInput` reemplaza `candidate: CampaignRecipientCandidate` por
`contactName: string` (`CampaignInboxProjector.ts:20-31`). `SendCampaign.projectToInbox` pasa
`candidate?.name ?? recipient.contactName ?? ''`. La proyección para contactos crudos FUNCIONA sin
tocar `Conversation` (no tiene `clientId`; `upsertBulkByPhone` matchea/crea por `contactPhoneE164`,
`ConversationRepository.ts:128-134`) — la conversación del contacto crudo nace `origin:'bulk'` igual
que hoy, y si el contacto responde por WhatsApp la reconciliación Fase 2 la adopta por teléfono.

**Alternativa rechazada — candidate opcional + contactName opcional**: dos fuentes del mismo dato en
el port = ambigüedad para cada implementación; el refactor toca 2 archivos + tests y deja el
contrato más chico (ISP).

## D7 — Resolución con RETENCIÓN DE DETALLE (la base del punto (c))

`resolveRecipients` devuelve contadores (`resolveRecipients.ts:28-41`) — insuficiente para "ver a
QUIÉN excluí y por qué". **Decisión**: extender de forma ADITIVA:

- `resolveRecipients` suma `excluded: Array<{candidate, reason}>` con
  `reason ∈ {'sin_telefono','telefono_invalido','opt_out','duplicado'}`
  (`sin_telefono` = phone null/vacío; `telefono_invalido` = tenía dígitos pero `toWhatsAppE164 →
  null` — hoy ambos colapsan en `excludedNoPhone`). Los contadores existentes se DERIVAN del
  detalle (backcompat exacto del shape actual: `excludedNoPhone = sin_telefono +
  telefono_invalido`).
- `resolveCombinedRecipients` se extiende a 3 fuentes (`segment`, `manualClientIds`,
  `manualContacts`) y devuelve además:
  - `resolved` con `clientId: string | null`, `source: 'segment'|'manual'|'csv'` y
    `contactName?` por item; `status: 'no_cliente'` para crudos (alimenta `statusCounts` — el
    FE ya tiene fallback de texto para status desconocidos, `PreviewModal.tsx:64-67`).
  - `excludedDetail: Array<{name: string, phone: string, reason, source, clientId?: string,
    status?: string}>` — la lista plana que pagina la vista `excluded`.
- **Precedencia de dedup cross-source** (extiende FIX-1): segmento > manual > CSV. Dentro del CSV,
  la PRIMERA aparición de una clave `normalizePhone` gana (el orden del archivo es intencional);
  las siguientes → `duplicado`. Un contacto cuyo teléfono ya está en la unión (o cuyo clientId
  vinculado ya está) → `duplicado`.
- **Validación de fila en BE** (defensa en profundidad, el FE ya filtra): `name` vacío →
  `sin_nombre`; `phone` vacío → `sin_telefono`; `toWhatsAppE164 → null` → `telefono_invalido`.
  `reason` completo: `'sin_nombre'|'sin_telefono'|'telefono_invalido'|'opt_out'|'duplicado'`.
- Invariante del preview se conserva: `count + Σ skipped = universo considerado` (los contadores
  del wire — `optedOut`/`duplicatePhone`/`invalidPhone` — mantienen sus NOMBRES actuales para no
  romper el FE; `invalidPhone` agrega `sin_nombre + sin_telefono + telefono_invalido` de CSV).

**Cliente `baja` = flag NO-excluyente**: NO es un reason — el recipient vinculado a un `baja` entra
en `resolved` con `status:'baja'`; el señalado es responsabilidad de la capa de presentación (el
`status` ya viaja por item en sample/paginado, `messaging-bulk.dto.ts:60-66, 101-106`).

## D8 — Parser CSV: PROPIO, sin papaparse

**Evidencia**: el FE no tiene ninguna lib CSV (`package.json` verificado); la necesidad es UN
formato estricto de 2 columnas.

| | papaparse | Parser propio |
|---|---|---|
| Peso | ~45KB min agregados al bundle | ~150 líneas + tests |
| Cobertura | streaming, chunking, workers, dynamic typing… que NO usamos | exactamente lo que el validador estricto necesita |
| Filosofía | "aceptá lo que venga y adiviná" | RECHAZAR estructura rara = requerimiento (a) del usuario |
| Riesgo | dependencia nueva + su superficie de config | bug de quoting propio → mitigado con la matriz de tests del spec FE (BOM, comillas, separadores, CRLF) |

**Decisión: parser propio** (`parseRecipientsCsv.ts`, puro, testeado a matriz). El requerimiento
ESTRICTO invierte el argumento habitual pro-lib: no queremos tolerancia, queremos rechazo
determinístico y explicable ("línea 7: 3 columnas").

Reglas del parser (matriz completa en el spec FE):
- **BOM** `﻿` inicial → strip. Fin de línea `\r\n`/`\n`/`\r` equivalentes. Líneas totalmente
  vacías al final → ignoradas; vacías en el medio → fila inválida (no rompen el archivo).
- **Separador**: autodetección sobre la primera línea no vacía, contando `;`, `,` y TAB FUERA de
  comillas; gana el que produce exactamente 2 columnas (prioridad `;` > `,` > tab en empate —
  Excel es-AR exporta `;`). Ninguno produce 2 → archivo RECHAZADO.
- **Comillas**: campo entre `"` puede contener separador/saltos; `""` = comilla literal. Comilla
  sin cerrar → archivo RECHAZADO (línea reportada).
- **Header**: la fila 1 se trata como header si su 2da columna NO contiene ningún dígito
  (heurística determinística: un header dice "telefono"/"número"; un dato siempre tiene dígitos).
- **Estructura**: CUALQUIER fila de datos con ≠ 2 columnas → archivo RECHAZADO ENTERO (decisión
  (a)), reportando línea. Archivo vacío / solo header → rechazado.
- **Filas** (archivo válido): nombre vacío → inválida `sin_nombre`; teléfono vacío → inválida
  `sin_telefono`. La VALIDEZ del teléfono NO se evalúa en FE (ver D9).
- **Límites**: 5000 filas de datos / 1MB → rechazo total con mensaje claro.

## D9 — Validación en dos niveles: FE = estructura, BE = autoridad

El FE NO porta `toWhatsAppE164` (98 líneas de plan de numeración AR con fix waves encima,
`toWhatsAppE164.ts` — duplicarlo en TS del FE = drift garantizado). División:

- **FE (parser)**: estructura del archivo (rechazo total) + filas obviamente inválidas
  (`sin_nombre`, `sin_telefono`) visibles ANTES de cualquier request.
- **BE (preview/create)**: `telefono_invalido` (toWhatsAppE164), `duplicado`, `opt_out`, vínculo y
  flag `baja` — todo visible por persona vía la vista `excluded` (D7). El preview debounced del
  composer (500ms, `CampaignComposer.tsx:96-109`) ya provee el round-trip sin fricción.

## D10 — Wire: caps y errores tipados

- `manualContacts` malformado (no-array, item sin `name`/`phone` string) →
  `InvalidManualContactsError` → 400 `VALIDATION_ERROR` (molde fail-loud `toManualClientIds`,
  `messagingBulk.routes.ts:57-78`).
- `> 5000` contactos normalizados → `TooManyManualContactsError` → 422 (molde
  `TooManyManualRecipientsError`, cap independiente del de `manualClientIds` — mismo razonamiento
  FIX-3: el insert masivo y la memoria del match; 5000+5000+segmento sigue acotado).
- Normalización de entrada: trim de `name`/`phone`; item con ambos vacíos post-trim se descarta en
  la normalización (no cuenta para el cap ni para el detalle — es ruido de parseo, no una persona).
- `assertHasRecipients` gana un 3er componente: válido si segmento filtrado O `manualClientIds` no
  vacío O `manualContacts` no vacío.

## D11 — `/segment/recipients` extendido (cierra deuda F4) + vista `excluded`

Input (`ListSegmentRecipientsInput`): `+ manualClientIds?` `+ manualContacts?` `+ view?:
'recipients' | 'excluded'` (default `'recipients'`). El guard pasa de `assertSegmentIsFiltered`
(`ListSegmentRecipients.ts:36`) a `assertHasRecipients` — el preview solo-manual/solo-CSV deja de
ser 400 (borra el gate `segmentHasCriteria` del FE, `PreviewModal.tsx:93-104`).

- `view: 'recipients'` → shape ACTUAL (`data/total/page/limit/skipped/statusCounts`,
  `messaging-bulk.dto.ts:113-120`) con items `{clientId: string | null, name, phoneE164, status,
  source}`. `status: 'baja'` = el flag visual; `'no_cliente'` = crudo.
- `view: 'excluded'` → `{data: excludedDetail paginado, total, page, limit, skipped,
  statusCounts}` — items `{name, phone, reason, source, clientId?, status?}`.

**Sin OOM**: la resolución del universo YA es in-memory por diseño (decisión LOCKED de v1.1,
`ListSegmentRecipients.ts:15-24`) y este change no agrega NINGÚN fetch nuevo (el match CSV reusa la
misma pasada); lo que va al WIRE está SIEMPRE paginado (`slice`), en ambas vistas. La lección del
review del bulk (nada de fetch-all) aplica al wire y a la DB del send-path (keyset, FIX-4-v2) — se
respeta en ambos.

**Alternativa rechazada — endpoint hermano `/segment/excluded`**: duplicaría el parse/guard/
resolución completos por un `slice` distinto; `view` mantiene UNA resolución y un solo contrato de
input. GET equivalente conserva paridad (deep-links) SOLO para la vista y campos escalares —
`manualContacts` NO viaja por query-string (payload arbitrario, límites de URL): el GET queda como
hoy (segment-only) y se documenta.

`PreviewSegmentOutput.sample` items ganan `clientId: string | null` — el FE del PreviewModal keyea
filas con `id: r.clientId` (`PreviewModal.tsx:33-34, 187`): pasa a `clientId ?? phoneE164`
(el teléfono es único dentro del set resuelto).

`CampaignRecipientDto` (`messaging-bulk.dto.ts:182-190`): `clientId: string | null` +
`contactName: string | null` — el detalle de campaña muestra filas CSV; `RecipientsTable` del FE
no renderiza `clientId` hoy (`RecipientsTable.tsx:79-96`), cero breakage.

## D12 — FE: componentes y colisión con el Rediseño (Change C)

- `parseRecipientsCsv.ts` + `CsvRecipientsUploader` viven en
  `src/pages/whatsapp/BulkMessagingPage/components/composer/` — módulos NUEVOS y aislados
  (superficie de colisión mínima con el rediseño C, que corre DESPUÉS y se hace SOBRE esto).
- `CampaignComposer`: estado `csvContacts: {name, phone}[]` + metadata del archivo; entra al gate
  (`hasRecipients` FE gana 3er parámetro), al debounce del preview (dependencia = fingerprint
  estable `fileName+rowCount`, NO `join` de 5000 items) y a los payloads de
  preview/create (`manualContacts`, omitido si vacío — patrón `manualClientIds`,
  `CampaignComposer.tsx:85-88, 161-163`).
- `PreviewModal`: la query pasa a la UNIÓN completa (borra `manualCount`/`manualNote` y el gate
  segment-only); sección "Excluidos (N)" con tabla paginada (`view=excluded`) — labels es-AR por
  reason; señalado `baja` = `StatusBadge status='baja'` (ya existe, `PreviewModal.tsx:57`) + texto
  "cliente de baja" (nunca solo color); crudos = texto "No es cliente".
- `CreateCampaignConfirmModal`: suma la línea de contactos CSV y el conteo `baja`
  (de `statusCounts.baja`, ya disponible).
- API/types: `PreviewSegmentInput`/`CreateCampaignInput`/`SegmentRecipientsQuery` +
  `manualContacts`; `SegmentRecipientDto.clientId: string | null` + `source`; nuevo
  `ExcludedRecipientDto`; `listSegmentRecipients` acepta el input completo.

## §Wiring (app.ts)

`ListSegmentRecipients` gana el 2do arg `manualRecipientSource` (misma instancia `customerAdapter`
que ya implementa `ManualRecipientSource`, `PrismaCustomerRepository.ts:287-294`) — el wiring de
`CreateCampaign`/`PreviewCampaignSegment` no cambia de aridad (el match CSV entra por el
`segmentSource` que ya reciben).
