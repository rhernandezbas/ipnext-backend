# Spec FE — bulk-csv-recipients (ipnext-frontend)

RFC-2119. Cada scenario cubierto por al menos un test verde (Vitest/RTL, molde de las suites de
`src/__tests__/whatsapp/composer/`).

NOTA de coordinación: el REDISEÑO del composer (Change C) corre DESPUÉS y se hace SOBRE estos
componentes — mantener el uploader y el detalle de excluidos como módulos aislados y presentacionales.

---

## Capability: parser CSV estricto (`parseRecipientsCsv`)

### Requirement: CSV-FE-1 — contrato del parser
`parseRecipientsCsv(text: string)` MUST ser una función pura sin dependencias nuevas que devuelve
un resultado discriminado: `{ok: true, contacts: {name, phone}[], invalidRows: {line, name?,
phone?, reason}[], headerSkipped: boolean}` o `{ok: false, error: {code, line?}}` (rechazo TOTAL).
MUST NOT usarse ninguna librería CSV externa (decisión D8 — sin papaparse).

### Requirement: CSV-FE-2 — matriz del validador (archivo)
El archivo entero MUST rechazarse (`ok: false`) cuando:
- alguna fila de datos tiene ≠ 2 columnas (código `ESTRUCTURA`, con línea),
- no se puede autodetectar un separador (`;`, `,` o TAB — contados FUERA de comillas en la primera
  línea no vacía; en empate gana `;` > `,` > TAB) que produzca exactamente 2 columnas,
- hay una comilla sin cerrar (código `COMILLAS`, con línea),
- el archivo está vacío o solo tiene header (código `VACIO`),
- supera 5000 filas de datos (código `DEMASIADAS_FILAS`) o 1MB (validado antes de parsear).

#### Scenario: 3 columnas en una fila → rechazo total
- Given un CSV con 10 filas correctas y la fila 7 con 3 columnas
- When se parsea
- Then `ok: false`, `error.code: 'ESTRUCTURA'`, `error.line: 7` — NINGUNA fila entra

#### Scenario: separador punto y coma (Excel es-AR)
- Given `nombre;telefono\nAna;11 2345-6789`
- When se parsea
- Then `ok: true`, 1 contacto, `headerSkipped: true`

#### Scenario: BOM + CRLF
- Given un archivo que empieza con `﻿` y termina líneas con `\r\n`
- When se parsea
- Then el BOM no contamina la primera celda y las filas se separan bien

#### Scenario: comillas con separador adentro y `""` escapado
- Given `"Perez, Ana";"11 2345-6789"` y `"Juan ""Chueco"" Lopez",1134567890`
- When se parsea (cada uno con su separador)
- Then los nombres resultan `Perez, Ana` y `Juan "Chueco" Lopez`, 2 columnas cada fila

#### Scenario: header detectado por heurística
- Given fila 1 `nombre,numero` (sin dígitos en col 2) y fila 1 alternativa `Ana,1123456789`
- When se parsea cada caso
- Then en el primero la fila 1 se salta (`headerSkipped: true`); en el segundo se trata como dato

### Requirement: CSV-FE-3 — matriz del validador (filas)
De un archivo válido MUST entrar SOLO las filas válidas: `name` vacío post-trim → inválida
`sin_nombre`; `phone` vacío post-trim → inválida `sin_telefono`; línea totalmente vacía en el medio
→ inválida (no rompe el archivo); las inválidas MUST reportarse con número de línea y motivo. La
VALIDEZ del teléfono (formato AR) MUST NOT evaluarse en el FE — es autoridad del BE (D9).

#### Scenario: filas inválidas visibles, válidas entran
- Given 4 filas: válida / sin nombre / sin teléfono / válida
- When se parsea
- Then `contacts.length: 2` y `invalidRows` tiene 2 items con línea y motivo

---

## Capability: uploader en el composer

### Requirement: CSV-FE-4 — `CsvRecipientsUploader`
El composer MUST montar un uploader de CSV (input file, `.csv`/`text/csv`) que: parsea
client-side, y en éxito muestra el resumen (nombre de archivo, N filas válidas, M inválidas con
detalle expandible línea+motivo) con acción "Quitar archivo"; en rechazo total muestra el motivo y
la línea (rol `alert`, texto — nunca solo color). Un archivo nuevo MUST reemplazar al anterior.

#### Scenario: carga válida
- Given un CSV con 3 válidas y 1 sin teléfono
- When el operador lo carga
- Then se ve "3 destinatarios del archivo" + "1 fila inválida" con el detalle (línea, motivo)

#### Scenario: rechazo total visible
- Given un CSV con una fila de 3 columnas
- When se carga
- Then aparece el error con la línea y NINGÚN contacto queda en el estado del composer

### Requirement: CSV-FE-5 — wiring del composer
`CampaignComposer` MUST: (1) mantener `csvContacts` en su estado (dueño único, molde
`manualRecipients`); (2) incluir `manualContacts` (omitido si vacío) en los payloads de
`previewSegment`, `listSegmentRecipients` y `createCampaign`; (3) extender el gate — una lista CSV
no vacía habilita preview/create aunque segmento y manuales estén vacíos; (4) re-disparar el
preview debounceado al cambiar el archivo usando un fingerprint estable (NO un `join` de 5000
items en las deps); (5) resetear `csvContacts` tras crear la campaña.

#### Scenario: solo-CSV habilita crear
- Given segmento vacío, sin manuales, CSV válido cargado, template + variables + nombre completos
  y preview con `count > 0`
- When se confirma
- Then `createCampaign` se llama con `manualContacts` y SIN `manualClientIds`

#### Scenario: payload omitido cuando no hay CSV (no-regresión)
- Given el flujo actual sin archivo
- When se previsualiza/crea
- Then el payload NO incluye la key `manualContacts`

---

## Capability: preview con excluidos visibles y señalado de bajas

### Requirement: CSV-FE-6 — PreviewModal consulta la unión completa
`PreviewModal` MUST pedir `/segment/recipients` con el input completo (segmento +
`manualClientIds` + `manualContacts`) y habilitar la query cuando HAY destinatarios de cualquier
fuente (reemplaza el gate segment-only). El aviso `manualNote` ("el detalle muestra solo el
segmento") MUST eliminarse — la tabla ES la unión. Las keys de fila MUST tolerar `clientId: null`
(`clientId ?? phoneE164`).

#### Scenario: solo-manual muestra la tabla (fin de la deuda F4)
- Given 2 manuales, segmento vacío
- When se abre el preview
- Then la tabla lista los 2 manuales (antes: solo una nota y ninguna tabla)

#### Scenario: fila CSV cruda visible
- Given un contacto CSV no-cliente resuelto
- When se abre el preview
- Then su fila muestra nombre + teléfono E164 + el estado "No es cliente" (texto, con fallback de
  status desconocido)

### Requirement: CSV-FE-7 — excluidos visibles por persona
El modal MUST ofrecer una vista/tab "Excluidos (N)" que consulta `view: 'excluded'` PAGINADO y
lista nombre + teléfono + motivo en es-AR (`sin_nombre` → "Sin nombre", `sin_telefono` → "Sin
teléfono", `telefono_invalido` → "Teléfono inválido", `opt_out` → "Optó por no recibir mensajes",
`duplicado` → "Duplicado") + la fuente. N sale de los contadores agregados ya presentes. El estado
vacío ("Sin excluidos") MUST existir.

#### Scenario: corregir el CSV mirando los excluidos
- Given un CSV con 2 filas de teléfono inválido
- When el operador abre "Excluidos"
- Then ve las 2 personas con nombre, teléfono y "Teléfono inválido" — sabe QUÉ corregir en el archivo

### Requirement: CSV-FE-8 — señalado de cliente de baja (no-excluyente)
Todo item con `status: 'baja'` MUST señalarse con `StatusBadge` + texto (p.ej. "cliente de baja"),
NUNCA solo color, tanto en la tabla del preview como en el resumen (`statusCounts.baja`). El item
MUST seguir contando como destinatario (no es exclusión).

#### Scenario: baja visible pero incluida
- Given un contacto CSV vinculado a un cliente `baja`
- When se abre el preview
- Then su fila está EN la tabla de destinatarios con el badge/texto de baja, y `count` la incluye

### Requirement: CSV-FE-9 — confirmación con el impacto completo
`CreateCampaignConfirmModal` MUST sumar la línea de contactos del archivo (cuando hay) y mostrar el
conteo de bajas (`statusCounts.baja`) cuando sea > 0.

#### Scenario: resumen con CSV y bajas
- Given 10 del segmento + 5 del CSV (2 de ellos baja)
- When se abre la confirmación
- Then se ven el total, la línea del CSV y "2 clientes de baja"
