# Spec — `assistant-cobranzas` (intents de cobranza sobre el motor `ai-assistant`)

RFC-2119. Cada scenario MUST quedar cubierto por al menos un test verde (`sdd-verify`).

Capability NUEVA. Se apoya en `ai-assistant` (motor, guardas, catálogos) — ver delta en ese
capability para SEC-4, ACT-3 (`handoff`), RTR-4 (`triggerPatterns`) y SEC-6 (`agent_active`).

Prefijos: **DAT** fuente de datos · **REN** render/split · **RSP** contenido de la respuesta ·
**INT** intents del seed · **CFG** config del perfil · **DFT** modo borrador.

> **Enmienda 2026-09-04** — DAT-4, RSP-1 e INT-2/3/4 incorporan las 5 reglas de negocio agregadas
> por el usuario (design D9–D11). DAT-1/2/3, REN-1/2, INT-1, CFG-1/2 y DFT-1/2 no cambian.

## Purpose

Enciende el motor de `ai-assistant` para cobranzas: responde el detalle de facturas impagas con
datos vivos de Gestión Real (link de pago por factura y del total, PDF, alias con titularidad) y
**frena en seco** ante cualquier señal que no sea cobranza pura, dejando etiqueta y nota privada.

## Requirements

### Requirement: DAT-1 — `cliente.facturas` nunca emite un dato stale

El resolver de `cliente.facturas` MUST intentar `RefreshClientBalanceIfStale.execute` (el MISMO
colaborador que usa `cliente.saldo`) antes de leer facturas. Si el balance sigue `balanceStale`
tras el intento, MUST devolver `motivoNoDisponible('facturas_no_disponibles')` y NUNCA una factura
vieja. Una lista de facturas VACÍA MUST NOT interpretarse como "al día" — sólo `cliente.saldo`
(`assistant-balance-guard`) puede afirmarlo (ver DFT-2).

#### Scenario: balance fresco, facturas disponibles
- GIVEN un cliente con `balanceStale:false` y 3 facturas impagas en el espejo
- WHEN se resuelve `cliente.facturas`
- THEN se devuelven las 3 facturas con saldo total, sin refrescar de nuevo

#### Scenario: stale y el refresh falla
- GIVEN `balanceStale:true` y GR no responde
- WHEN se resuelve `cliente.facturas`
- THEN el resultado es `{disponible:false, motivo:'facturas_no_disponibles'}`, sin facturas viejas

#### Scenario: lista vacía no afirma "al día"
- GIVEN el refresh corrigió `balanceStale:false` pero no hay facturas abiertas en el espejo
- WHEN se resuelve `cliente.facturas`
- THEN el resultado NO contiene una afirmación de "al día"; esa afirmación sólo sale de
  `cliente.saldo` en la misma corrida

### Requirement: DAT-2 — puerto angosto, anclado al cliente, sin PII

MUST existir `AssistantInvoicesReader.listOpenByClientId(clientId)` (domain port) devolviendo,
por factura, sólo: tipo, número, vencimiento, saldo, `pdfUrl`, `couponPdfUrl`, `paymentUrl`. La
proyección del SELECT MUST NOT incluir `customerName` ni ningún campo de identidad del cliente.
`BillingRepository.listInvoices` (query admin paginada, sin filtro por cliente) MUST NOT usarse
para este propósito.

#### Scenario: la proyección es libre de PII
- GIVEN un cliente con facturas abiertas
- WHEN `listOpenByClientId` resuelve
- THEN ningún campo devuelto es nombre, documento, domicilio, email o teléfono

### Requirement: DAT-3 — `Client.grPaymentUrl` se escribe en la MISMA transacción que el saldo

`Client.grPaymentUrl` (columna aditiva) MUST escribirse desde `balance.paymentUrls.MercadoPago`
dentro de la misma transacción de `updateBalanceAndInvoices` que ya persiste saldo y facturas —
NUNCA en una llamada GR separada, para que el link del total jamás divierja del saldo citado en el
mismo mensaje.

#### Scenario: payload autoritativo actualiza saldo, facturas y link del total juntos
- GIVEN un refresh exitoso con `payments_url_saldos.MercadoPago` presente
- WHEN se persiste el resultado
- THEN `Client.balanceDue`, las facturas del espejo y `Client.grPaymentUrl` quedan escritos en la
  misma transacción

#### Scenario: payload no autoritativo no toca el link
- GIVEN un payload sin `payments_url_saldos` (schema drift)
- WHEN se persiste
- THEN `Client.grPaymentUrl` conserva su valor anterior, sin vaciarse

### Requirement: DAT-4 — `cliente.recibos_hoy`: verificar el comprobante en GR, nunca a ojo

MUST existir la fuente `cliente.recibos_hoy`, resuelta con una llamada GR **en vivo y anclada al
cliente** (`fetchClientReceipts({grClienteId, fechaDesde, fechaHasta})`, `grClienteId` OBLIGATORIO
en la firma). MUST devolver, por recibo VIGENTE (no anulado) del día: hora, `recaudador`, importe y
las referencias de sus `items[].numero_transferencia`. MUST NOT devolver nombre, documento,
domicilio, email ni teléfono.

El motor MUST calcular por CÓDIGO, nunca con el modelo:
- `matchOperacion`: el número de operación extraído del adjunto `comprobante_<op>.(pdf|jpg|jpeg|png)`
  del último inbound (mínimo 6 dígitos) matchea si ALGUNA referencia de un recibo de hoy CONTIENE
  esa secuencia de dígitos (GR las manda como `"MercadoPago: <op>"`).
- `posibleDoblePago`: `true` si hay ≥2 recibos vigentes del día con el MISMO importe.

Si GR no responde, MUST devolver `{disponible:false, motivo:'recibos_no_disponibles'}` y el bot
MUST NOT afirmar que no encontró el pago — deriva por `comprobante_transferencia` (INT-1). El
espejo `FinancePaymentReceipt` MUST NOT usarse como fuente de esta verificación (lo alimenta un
scheduler por delta: un pago de minutos atrás puede no estar).

#### Scenario: comprobante de MercadoPago verificado contra los recibos de hoy
- GIVEN el inbound trae `comprobante_177332834792.pdf`
- AND existe un recibo de hoy con `recaudador:'mercadopago'` y una referencia `"MercadoPago: 177332834792"`
- WHEN se resuelve `cliente.recibos_hoy`
- THEN `matchOperacion.encontrado` es `true` con el importe del recibo

#### Scenario: sin recibo que matchee ⇒ transferencia bancaria, no MercadoPago
- GIVEN el inbound trae un comprobante cuyo número de operación no aparece en ningún recibo de hoy
- WHEN se resuelve la fuente
- THEN `matchOperacion.encontrado` es `false` y el resultado deriva a `comprobante_transferencia`

#### Scenario: GR caído no se confunde con "no pagaste"
- GIVEN GR no responde al pedido de recibos
- WHEN se resuelve la fuente
- THEN el resultado es `{disponible:false, motivo:'recibos_no_disponibles'}`
- AND el bot NO afirma que el pago no existe

#### Scenario: la fecha del recibo viaja en el hecho
- GIVEN la ventana consultada es HOY−1 y GR devuelve un recibo de ayer y otro de hoy
- WHEN se arman los hechos
- THEN cada recibo emite su `fecha` y el de ayer va marcado `esDeAyer:true`
- AND `matchOperacion` y `posibleDoblePago` se evalúan SÓLO sobre los recibos de HOY

#### Scenario: dos recibos del mismo importe el mismo día
- GIVEN hay 2 recibos vigentes de hoy por $77.997,19 cada uno
- WHEN se resuelve la fuente
- THEN `posibleDoblePago` es `true`

#### Scenario: los hechos de recibos son libres de PII
- GIVEN cualquier resolución exitosa de `cliente.recibos_hoy`
- WHEN se inspeccionan los hechos inyectados al modelo
- THEN ningún campo es nombre, documento, domicilio, email o teléfono

### Requirement: RSP-1 — tras un pago, el SIGNO del saldo decide el mensaje

Cuando se verificó un pago (DAT-4), el mensaje MUST decidirse por el signo de `debt` de
`cliente.saldo` **resuelto en la MISMA corrida** (mismo gate de frescura que DFT-2): `debt > 0` ⇒
sigue debiendo y el bot MUST NOT decir "estás al día"; `debt = 0` ⇒ al día; `debt < 0` ⇒ al día y
MUST mencionar el saldo A FAVOR. El recibo sólo dispara la verificación: **nunca** es por sí solo
prueba de que la deuda quedó saldada. Si `cliente.saldo` no está disponible en la corrida, el bot
MUST NOT afirmar ninguno de los dos estados.

El mensaje MUST informar "en N facturas" **sólo si N se conoce** (`cliente.facturas` disponible);
con la fuente no disponible la cláusula MUST omitirse — nunca "en 0 facturas". El importe del pago
MUST omitirse si GR no lo trajo — nunca "$0,00". Y el texto REDACTADO POR EL MODELO MUST
descartarse si contradice el signo del saldo: queda sólo el bloque determinístico, y si no hay
bloque, handoff. El verificador MUST distinguir la POLARIDAD de la oración — con `debt <= 0` sólo
se descartan las AFIRMACIONES de deuda ("tenés una deuda", "debés"), nunca sus negaciones ("no
tenés facturas pendientes", la respuesta correcta del cliente al día); con `debt > 0`, simétrico:
"estás al día" se descarta, "todavía no estás al día" no.

#### Scenario: la respuesta correcta del cliente al día se envía
- GIVEN `debt: 0` y el modelo devuelve "No tenés facturas pendientes, estás al día"
- WHEN corre el verificador de frase
- THEN el texto se ENVÍA tal cual (no se descarta ni deriva)

#### Scenario: pagó una parte y sigue debiendo
- GIVEN se verificó un pago de $41.410,56 (op 177332834792)
- AND `cliente.saldo` fresco devuelve `debt: 72589.41`
- AND `cliente.facturas` devuelve 3 facturas abiertas
- WHEN se arma la respuesta
- THEN el mensaje reconoce el pago recibido e informa el saldo restante y "en 3 facturas"
- AND NO contiene ninguna afirmación de "estás al día"

#### Scenario: deuda restante con `cliente.facturas` no disponible
- GIVEN `debt: 72589.41` y `cliente.facturas` devuelve `{disponible:false}`
- WHEN se arma la respuesta
- THEN el mensaje informa el saldo restante SIN mencionar ninguna cantidad de facturas

#### Scenario: el modelo dice "estás al día" con deuda
- GIVEN `debt: 72589.41` y el modelo devuelve un texto que afirma "estás al día"
- WHEN corre el verificador de frase (después de SEC-4)
- THEN ese texto se descarta y sólo se envía el bloque determinístico; si no hubiera bloque, la
  conversación deriva con `necesita-humano`

#### Scenario: saldo en cero
- GIVEN se verificó el pago y `cliente.saldo` fresco devuelve `debt: 0`
- WHEN se arma la respuesta
- THEN el bot confirma que quedó al día

#### Scenario: saldo negativo ⇒ a favor
- GIVEN se verificó el pago y `cliente.saldo` fresco devuelve `balanceDue: -77997.19`
- AND el resolver emite `saldo: 0` (FW2-1) más el hecho INTERNO `_aFavor: 77997.19`
- WHEN se arma la respuesta
- THEN el bot confirma que está al día Y menciona el saldo a favor de $77.997,19
- AND el importe del crédito NO llega ni al prompt del modelo ni al whitelist de SEC-4

#### Scenario: saldo no disponible tras verificar el pago
- GIVEN `matchOperacion.encontrado:true` pero `cliente.saldo` devuelve `{disponible:false}`
- WHEN se arma la respuesta
- THEN el bot NO afirma ni "te queda saldo" ni "estás al día"; deriva según la `guia` del saldo

### Requirement: INT-2 — `promesa_pago` ⇒ handoff a Administración + desasignar

MUST sembrarse la intent `promesa_pago` con `actionKey:'handoff'`, `labels:['administracion']`,
`unassign:true` y `triggerPatterns[]` con las frases de promesa ("pago mañana", "el lunes", "la
semana que viene", "a fin de mes", "cuando cobre", "no puedo ahora", "pago luego"). Al resolverla,
el motor MUST NOT responderle al cliente, MUST aplicar `administracion` + `necesita-humano` con nota
privada, y MUST desasignar la conversación para que quede en la COLA de Administración
(`ai-assistant` ACT-4). La lista de patrones de `promesa_pago` es la ÚNICA fuente de frases de
promesa: INT-3 la reusa.

#### Scenario: promesa sin comprobante deriva y libera la conversación
- GIVEN el cliente escribe "esta semana no puedo, te pago el lunes"
- WHEN corre el pre-chequeo (RTR-4)
- THEN se aplica `handoff` con `administracion` + `necesita-humano`, nota privada con el motivo,
  la conversación queda SIN asignar y NO se le responde al cliente

### Requirement: INT-3 — `pago_parcial_con_promesa` ⇒ un acuse Y sigue en Administración

MUST sembrarse la intent `pago_parcial_con_promesa` (`roleKey` homónimo) con
`labels:['administracion']` y `unassign:true`. MUST aplicar cuando se cumplen las TRES condiciones:
comprobante verificado (DAT-4), `debt > 0` (RSP-1) y el texto matchea un patrón de promesa. El bot
MUST enviar **un solo** mensaje que reconozca el pago, informe el saldo restante y sus facturas, y
mencione la fecha prometida si el cliente la dijo. Responder MUST NOT sacar la conversación de la
cola: los labels y el `unassign` se aplican IGUAL (`ai-assistant` ACT-3 modificado).

#### Scenario: pago parcial con promesa de fin de mes
- GIVEN el cliente manda un comprobante por $24.999 que matchea un recibo de hoy
- AND `cliente.saldo` fresco devuelve `debt: 100122.95`
- AND el texto dice "el resto a fin de mes"
- WHEN se ejecuta la acción
- THEN se envía UN mensaje con el pago reconocido, el saldo restante y sus facturas
- AND la conversación queda con label `administracion` y SIN asignar

#### Scenario: comprobante con deuda pero SIN promesa no desasigna
- GIVEN el mismo comprobante verificado y `debt > 0`, pero el texto no promete nada
- WHEN se resuelve el selector
- THEN gana `comprobante_mp` (responde por RSP-1) y no se aplica el `unassign` de INT-3

### Requirement: INT-4 — doble pago: avisar y mandarlo a caja

Cuando `posibleDoblePago` es `true` (DAT-4), la respuesta MUST mencionar explícitamente que se ven
dos pagos del mismo importe en el día e invitar al cliente a avisar si fue por error, MUST informar
el saldo a favor resultante si `debt < 0` (RSP-1), y la conversación MUST quedar etiquetada
`administracion` para que caja lo revise. El bot MUST NOT prometer una devolución ni un plazo.

#### Scenario: dos pagos idénticos el mismo día
- GIVEN hay 2 recibos vigentes de hoy por $77.997,19 y `cliente.saldo` fresco devuelve `debt: -77997.19`
- WHEN se arma la respuesta
- THEN el mensaje menciona los dos pagos y el saldo a favor de $77.997,19
- AND la conversación queda etiquetada `administracion`
- AND el mensaje NO promete devolución ni plazo

### Requirement: REN-1 — bloque "Detalle por factura" es determinístico, escrito por código

`renderInvoiceBlock(facts): string | null` (función pura, `application/`) MUST renderizar el
detalle de facturas y el link de pago total a partir de los HECHOS de `cliente.facturas`, nunca a
partir de texto del modelo. El bloque se ANEXA DESPUÉS de la verificación SEC-4 sobre
`generated.text` (ver `ai-assistant` SEC-4 modificado): el bloque mismo no pasa por el verificador
de números, porque nunca fue redactado por el modelo. El `responseGuide` de las intents de
cobranza MUST instruir al modelo a NO escribir montos ni links — si el modelo lo hace igual, SEC-4
lo rechaza sobre `generated.text` (el bloque anexado no se ve afectado). El bloque MUST incluir la
aclaración de alias "titular IPNEXT S.A., CUIT 30-70849985-0. Si ves otro dato, no transfieras"
CADA VEZ que se ofrece el alias, y el motor MUST pasarle el alias configurado al renderizador (una
aclaración implementada pero nunca invocada es un requisito incumplido).

#### Scenario: el bloque ofrece el alias
- GIVEN hay un alias de pago configurado y al menos una factura abierta
- WHEN se arma el bloque determinístico
- THEN el mensaje muestra el alias junto con "titular IPNEXT S.A., CUIT 30-70849985-0. Si ves otro
  dato, no transfieras"

#### Scenario: el modelo respeta la instrucción y el código arma el detalle
- GIVEN 2 facturas impagas y `Client.grPaymentUrl` presente
- WHEN el motor redacta y arma la respuesta final
- THEN el texto del modelo no contiene montos ni links, y el bloque anexado lista ambas facturas
  con su `paymentUrl`, más el link de pago total

#### Scenario: el modelo escribe un monto igual y SEC-4 lo rechaza (no el bloque)
- GIVEN el modelo devuelve un texto con un monto no inyectado
- WHEN corre SEC-4 sobre `generated.text`
- THEN esa salida se descarta antes de anexar el bloque; el bloque determinístico nunca se evalúa
  por SEC-4 porque no proviene del modelo

### Requirement: REN-2 — split ≤1.400 caracteres, numerado, orden preservado

`splitForWhatsapp(text, cap=1400): string[]` (función pura) MUST partir el mensaje final (texto +
bloque) en trozos ≤1.400 caracteres — margen bajo el límite duro de Twilio (1.600) — numerados
`(i/N)` con el prefijo DENTRO del cap, cortando en `\n\n` > `\n` > espacio y NUNCA a mitad de una
URL. `executeAction` MUST iterar los chunks secuencialmente sobre el mismo `reply`/`privateNote`
existente (el puerto no cambia). El mismo split MUST aplicarse cuando el `actionKey` es
`private_note` (modo borrador, DFT-1).

#### Scenario: 6 facturas producen 2 mensajes numerados
- GIVEN un cliente con 6 facturas impagas cuyo detalle renderizado supera 1.400 caracteres pero no
  2.800
- WHEN se arma y se parte la respuesta
- THEN se generan 2 chunks, cada uno ≤1.400 caracteres, numerados como `(1/2)` y `(2/2)`, y ninguna
  URL queda cortada a la mitad

#### Scenario: falla un chunk a mitad de la secuencia — nunca silencioso
- GIVEN una respuesta partida en 3 chunks
- AND el envío del 2do chunk falla
- WHEN `executeAction` termina de iterar
- THEN `AssistantRun.outcome:'partial_send'` con el motivo, y queda una nota privada
  `🤖 envié N de M mensajes, seguí vos` — el fallo NUNCA queda mudo

### Requirement: INT-1 — intents STOP iniciales del seed, todas con `actionKey:'handoff'`

MUST sembrarse las siguientes intents STOP, todas resolviendo a la acción `handoff`
(`ai-assistant` ACT-3) y por lo tanto sin responder nunca al cliente:

| Intent | `labels[]` | Nota |
|---|---|---|
| `reclamo_servicio` | `['soporte']` | ej. "no tengo internet" |
| `plan_pago` | `[]` | pedido de refinanciación |
| `disputa_monto` | `[]` | el cliente cuestiona una cifra |
| `baja` | `[]` | pedido de baja de servicio |
| `enojo` | `[]` | tono agresivo/queja fuerte |
| `comprobante_transferencia` | `['administracion']` | transferencia bancaria, no MP |
| `equivocado` / `auto-responder` | `[]` | handoff silencioso — sin label de área, la
  conversación no se cierra (`resolve_conversation` queda descartado) |

Sólo intents con `actionKey:'handoff'` MAY llevar `triggerPatterns[]` (`ai-assistant` RTR-4 y
CFG-2 modificado); guardar `triggerPatterns` en una intent con otro `actionKey` MUST rechazarse
con 400.

#### Scenario: "ya pagué y no tengo internet" fuerza `reclamo_servicio`, no cobranza
- GIVEN el último inbound del cliente es "ya pagué y no tengo internet"
- AND `reclamo_servicio` tiene un `triggerPattern` que matchea "no tengo internet"
- WHEN corre el pre-chequeo (RTR-4)
- THEN se fuerza `reclamo_servicio` sin consultar al modelo, se aplica `handoff` con label
  `soporte` + `necesita-humano`, NO se responde al cliente, y `AssistantRun.reason='trigger_pattern'`

#### Scenario: transferencia bancaria deriva a Administración Y acusa recibo
- GIVEN el cliente escribe "te hice una transferencia, ahí te mando el comprobante"
- WHEN el clasificador (o el pre-chequeo) matchea `comprobante_transferencia`
- THEN se aplica `handoff` con labels `administracion` + `necesita-humano`, nota privada con el
  motivo y `unassign`
- AND se envía al cliente el acuse DETERMINÍSTICO: reconoce el comprobante (con la operación si se
  conoce), avisa que todavía no lo ve impactado y que administración lo revisa e imputa a mano, e
  informa el saldo **calificado como pre-imputación** ("tu saldo a hoy, sin contar este pago, es
  $X") sólo si `cliente.saldo` está disponible (decisión del dueño, 2026-09-05)
- AND el acuse MUST NOT afirmar el MEDIO de pago (ni "transferencia" ni "MercadoPago"): a esta
  rama se llega con cualquier comprobante que no matchee los recibos de HOY, incluido un pago por
  link que GR todavía no ingestó o uno hecho ayer
- AND si la acción `whatsapp_reply` no está habilitada o la ventana de 24 h está cerrada, el acuse
  NO se envía y la derivación ocurre igual

#### Scenario: comprobante de un pago por LINK hecho ayer
- GIVEN el recibo de MercadoPago existe pero es de ayer 23:55, por lo que no matchea entre los de
  HOY
- WHEN se arma el acuse de `comprobante_transferencia`
- THEN el mensaje NO dice "transferencia" ni "no por link", y el saldo va calificado con "sin
  contar este pago"

#### Scenario: "ya pagué, te paso el comprobante, pero no tengo internet"
- GIVEN el último inbound trae un adjunto `comprobante_<op>.pdf` Y matchea el `triggerPattern` de
  `reclamo_servicio`
- WHEN corre el pre-chequeo
- THEN gana `reclamo_servicio` (`handoff` + `soporte` + `necesita-humano`) y NO se le responde de
  cobranza: la excepción del adjunto sólo puede sobrescribir a `promesa_pago`

#### Scenario: número equivocado no habla ni deja etiqueta de área
- GIVEN el mensaje matchea `equivocado`
- WHEN se ejecuta `handoff`
- THEN se aplica sólo `necesita-humano` (labels vacío), la conversación NO se cierra, y no se
  responde al cliente

### Requirement: CFG-1 — perfil único de cobranza, `defaultAreaId` en Facturación

`AssistantRoutingConfig.defaultAreaId` MUST apuntar al área Facturación
(`e09fac32-34eb-46cc-8ec0-c809039eb8ea`). El único `AssistantProfile` de este change vive ahí;
Administración no recibe un perfil propio en este change.

#### Scenario: conversación sin área explícita
- GIVEN una conversación de WhatsApp sin `areaId`
- WHEN llega un inbound
- THEN el motor resuelve el perfil de Facturación vía `defaultAreaId` (RTR-0 de `ai-assistant`)

### Requirement: CFG-2 — seed idempotente de catálogo, flag OFF hasta activación manual

La migración MUST insertar `AssistantAction('handoff', riskLevel:'green')` y
`AssistantDataSource('cliente.facturas', enabled:true)` con `ON CONFLICT DO NOTHING`. La segunda
migración (enmienda D9–D11) MUST insertar además `AssistantDataSource('cliente.recibos_hoy',
enabled:true)` con el mismo criterio idempotente. El flag
global `ai-assistant-enabled` MUST permanecer en `false` tras aplicar este change: activarlo es un
acto explícito y posterior, fuera de este seed.

#### Scenario: instalación nueva no habla sola
- GIVEN se aplicó la migración y el seed de este change
- WHEN se re-despliega
- THEN el flag global sigue OFF y ningún cliente recibe una respuesta hasta que alguien lo prenda

### Requirement: DFT-1 — modo borrador: las 4 intents que responden nacen con `private_note`

Las intents que SÍ generan contenido de cobranza (respuesta con `cliente.facturas`) MUST nacer con
`actionKey:'private_note'` y sin `whatsapp_reply` habilitado en el perfil. El bot redacta, un
agente humano lee la nota y decide. "Soltar" una intent (pasar a `whatsapp_reply`) MUST ser un
cambio de configuración, sin deploy. El split de REN-2 se aplica igual sobre la nota privada.

#### Scenario: el bot redacta pero no envía
- GIVEN una intent de cobranza con `actionKey:'private_note'`
- WHEN el motor resuelve la respuesta
- THEN el contenido (incluido el bloque de facturas partido) queda como nota privada en Chatwoot y
  NO se envía al cliente por WhatsApp

#### Scenario: soltar la intent sin deploy
- GIVEN la misma intent
- WHEN un operador cambia `actionKey` a `whatsapp_reply` y habilita la acción en el perfil
- THEN la siguiente corrida responde directo al cliente, sin cambios de código

### Requirement: DFT-2 — "estás al día" sólo con `cliente.saldo` fresco y `saldo ≤ 0`

`cliente.facturas` MUST NOT afirmar que el cliente está al día bajo ninguna circunstancia (ver
DAT-1). Esa afirmación MUST venir exclusivamente de `cliente.saldo` (`assistant-balance-guard`)
con `disponible:true` y `tieneDeuda:false` EN LA MISMA CORRIDA.

#### Scenario: facturas vacías pero saldo no disponible — no afirma nada
- GIVEN `cliente.facturas` devuelve lista vacía y `cliente.saldo` devuelve
  `{disponible:false, motivo:'saldo_desactualizado'}` en la misma corrida
- WHEN se arma la respuesta
- THEN el bot NO dice "estás al día"; deriva según la `guia` de `cliente.saldo`

#### Scenario: saldo fresco en cero — sí afirma al día
- GIVEN `cliente.saldo` devuelve `{disponible:true, saldo:0, tieneDeuda:false}` en la misma corrida
- WHEN se arma la respuesta
- THEN el bot puede decir "estás al día"
