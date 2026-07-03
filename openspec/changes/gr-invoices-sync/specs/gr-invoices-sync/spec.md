# Capability: gr-invoices-sync

Las facturas de Gestión Real se persisten en la tabla local `Invoice` durante el refresh de balance y se exponen al tab Facturación con un contrato estable.

## ADDED Requirements

### Requirement: capturar `cuentas.invoices[]` en el parse del balance
`parseClientBalanceResponse` SHALL leer `clientes[0].cuentas.invoices[]` y devolver `GrClientBalance.invoices: GrInvoice[]` con `{ tipo, sucursal, numero, moneda, fecha, fecha_vto, importe, saldo, urlPdf, cuponPdf, paymentUrl }`. Si `invoices` está ausente, vacío o malformado, SHALL devolver `[]` sin lanzar.

#### Scenario: sample real de GR
- **GIVEN** una respuesta `cliente` con `cuentas.invoices` = `[{tipo:"FB",sucursal:"00010",numero:"000074035",moneda:"PES",fecha:"26-06-2026",fecha_vto:"07-07-2026",importe:35121.37,saldo:35121.37,url_pdf:"...",cupon_pdf:"...",payments_url:{MercadoPago:"..."}}]`
- **THEN** `balance.invoices[0]` tiene todos los campos mapeados y `paymentUrl` = el link MercadoPago

#### Scenario: sin invoices
- **GIVEN** `cuentas.invoices` = `[]` o ausente
- **THEN** `balance.invoices` = `[]` (sin error)

### Requirement: persistir facturas GR con replace-all scopeado
`ClientMirrorRepository.upsertInvoices(clientId, grInvoices, at)` SHALL, en una transacción: borrar las `Invoice` del cliente con `grInvoiceId` NO nulo que NO estén en el set actual, y upsertear cada factura actual por `grInvoiceId` (= `"{tipo}-{sucursal}-{numero}"`). Las facturas con `grInvoiceId` null (manuales) NUNCA SHALL borrarse.

#### Scenario: espejo exacto (factura pagada desaparece)
- **GIVEN** un cliente con 3 GR-invoices locales y GR ahora devuelve solo 2 (una se pagó)
- **WHEN** `upsertInvoices` con las 2 actuales
- **THEN** el cliente queda con 2 GR-invoices; la tercera fue borrada

#### Scenario: factura manual protegida
- **GIVEN** un cliente con 1 factura manual (`grInvoiceId=null`) y GR devuelve `[]`
- **WHEN** `upsertInvoices(clientId, [], at)`
- **THEN** la manual SOBREVIVE; cero GR-invoices

#### Scenario: re-sync actualiza saldo
- **GIVEN** una GR-invoice local con saldo 35121.37
- **WHEN** GR la devuelve con saldo 10000
- **THEN** la fila local pasa a balance 10000 y status recalculado

### Requirement: status derivado de saldo + vencimiento (TZ AR)
El status SHALL derivarse: `saldo<=0`→`pagada`; `saldo>0 && dueDate>=hoy(AR)`→`pendiente`; `saldo>0 && dueDate<hoy(AR)`→`vencida`. Las fechas `DD-MM-YYYY` SHALL parsearse en `America/Argentina/Buenos_Aires`.

#### Scenario: bordes
- **GIVEN** saldo 100 y vto = hoy(AR) → `pendiente`
- **GIVEN** saldo 100 y vto = ayer(AR) → `vencida`
- **GIVEN** saldo 0 → `pagada`
- **GIVEN** saldo -500 (nota de crédito) → `pagada`

### Requirement: sync en batch (deudores) y on-demand (todos)
`RefreshDebtorBalances` y `RefreshClientBalanceIfStale` SHALL llamar `upsertInvoices` junto a `updateClientBalance`. `GetClientDetail` SHALL disparar el refresh on-demand (TTL-gated) para CUALQUIER cliente con `grClienteId`, no solo `status==='late'`.

#### Scenario: cliente activo al abrir la ficha
- **GIVEN** un cliente activo con `grClienteId` y `lastBalanceAt` stale
- **WHEN** se abre su ficha (`GetClientDetail`)
- **THEN** se dispara `RefreshClientBalanceIfStale` → sus facturas se sincronizan

## MODIFIED Requirements

### Requirement: `GET /clients/:id/invoices` devuelve un `InvoiceDto` estable
El endpoint SHALL devolver `InvoiceDto[]` con `{ id, number, grType, amount, balance, currency, status: 'pagada'|'pendiente'|'vencida', issueDate (ISO), dueDate (ISO), pdfUrl, couponPdfUrl, paymentUrl }` — NO la entidad de dominio cruda. El FE consume exactamente este contrato.

#### Scenario: shape del DTO
- **GIVEN** un cliente con GR-invoices persistidas
- **WHEN** `GET /clients/:id/invoices`
- **THEN** 200 con array de `InvoiceDto`, cada uno con `balance`, `status` derivado y los 3 links (o null)

### Requirement: tab Facturación muestra facturas reales
`BillingTab` SHALL renderizar las columnas Número/Emisión/Vencimiento/Importe/Saldo/Estado + acciones PDF y MercadoPago (cuando el link existe), con "Saldo pendiente" = Σ `balance` de las de status != `pagada`. SHALL no crashear con lista vacía.

#### Scenario: deudor con facturas
- **GIVEN** un deudor con 3 facturas pendientes
- **THEN** el tab lista las 3 con su saldo, badge por status, y "Saldo pendiente" = suma de los 3 saldos

## Non-functional
- **Cero llamadas GR nuevas:** el sync reusa el payload del refresh de balance.
- **Aislamiento GR:** `grInvoiceId` nullable + columnas dedicadas → droppable al deprecar GR; el sync jamás toca facturas sin `grInvoiceId`.
- **Migración aditiva** sobre tabla vacía en prod (+ drop del unique index de `number`).
