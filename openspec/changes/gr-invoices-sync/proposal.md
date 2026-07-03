# Proposal: Sincronizar facturas de Gestión Real al tab Facturación (`gr-invoices-sync`)

## Intent

Persistir las facturas de Gestión Real (GR) en la tabla local `Invoice` durante el refresh de balance, para que el tab **Facturación** del cliente muestre el "Saldo pendiente" y el detalle de facturas REALES (hoy muestra $0 porque la tabla está vacía). La data ya la fetcheamos: la acción `cliente` de GR devuelve `cuentas.invoices[]` en el MISMO payload que usamos para el balance — cero llamadas GR nuevas.

## Why

- **Inconsistencia visible:** el tab Facturación suma la tabla `Invoice` local (vacía) → un deudor muestra **$0**, contradiciendo el `balanceDue` que SÍ calculamos y mostramos. `parseClientBalanceResponse` (`GestionRealClient.ts:289`) hoy **descarta** `cuentas.invoices` silenciosamente.
- **La data ya viaja:** ambos refresh de balance (batch `RefreshDebtorBalances`, on-demand `RefreshClientBalanceIfStale`) ya tienen el payload completo (`GrClientBalance.raw`) en mano al escribir el balance. Persistir las facturas es un write más, junto al `updateClientBalance` existente.
- **Forma VERIFICADA en vivo (Phase-0, 2026-07-03):** probados 25 deudores, **25/25 con `invoices[]` poblado**. Item real:
  ```jsonc
  { "tipo":"FB", "sucursal":"00010", "numero":"000074035", "moneda":"PES",
    "fecha":"26-06-2026", "fecha_vto":"07-07-2026", "importe":35121.37, "saldo":35121.37,
    "url_pdf":"https://clientes.ipnext.com.ar/.../factura_prt.php?...",
    "cupon_pdf":"https://.../...&cupon=SI",
    "payments_url":{"MercadoPago":"https://pagos.gestionreal.com.ar/mp.php?..."} }
  ```
  GR NO da `status` ni un id atómico: la identidad es compuesta (`tipo`+`sucursal`+`numero`) y el estado se DERIVA de `saldo`+`fecha_vto`.
- **Bug latente que este change destapa (obligatorio arreglar):** el BE `GET /clients/:id/invoices` devuelve la forma de DOMINIO (`issueDate`/`dueDate`/`amount`, status `pagada|pendiente|vencida`) pero el FE espera `issuedAt`/`dueAt`/`total`, status `draft|sent|paid|overdue|cancelled`. Hoy no explota porque la tabla está vacía; **el instante que sincronicemos filas reales, `BillingTab` renderiza `$NaN` y crashea el badge**. El contrato BE↔FE se define explícito campo-a-campo (lección #28/W6).

## Decisiones del usuario (2026-07-03)

- **Reconciliación = espejo exacto de GR (replace-all).** Cada refresh borra las GR-invoices del cliente que ya no vuelven y upserta las actuales → el tab muestra EXACTO lo pendiente en GR (una factura pagada desaparece). Scopeado a `grInvoiceId IS NOT NULL` (no toca facturas manuales futuras).
- **Alcance = todos los clientes.** Mecanismo: **on-demand al ver la ficha** (cualquier cliente con `grClienteId`, TTL-gated) + el **batch horario sigue proactivo para deudores**. Se evita deliberadamente un batch horario sobre TODOS los activos (miles de llamadas GR/hora, sin beneficio si nadie mira la ficha). Follow-up posible: sweep proactivo de activos.

## Scope

### In Scope
- **BE — parse:** extender `parseClientBalanceResponse` para capturar `cuentas.invoices[]` en un `GrInvoice[]` tipado sobre `GrClientBalance`.
- **BE — schema:** migración aditiva a `Invoice` (tabla VACÍA en prod → segura): `grInvoiceId String? @unique` (= `"{tipo}-{sucursal}-{numero}"`), `balance Decimal?` (= saldo), `pdfUrl`/`couponPdfUrl`/`paymentUrl`/`grType`/`currency` nullable; quitar `@unique` de `number` (numero solo no es único).
- **BE — persistencia:** `ClientMirrorRepository.upsertInvoices(clientId, grInvoices, at)` con **replace-all scopeado a `grInvoiceId IS NOT NULL`**; status derivado (`saldo<=0`→pagada · `saldo>0 & vto≥hoy`→pendiente · `saldo>0 & vto<hoy`→vencida); fechas `DD-MM-YYYY`→DateTime en TZ `America/Argentina/Buenos_Aires`. Llamado en `RefreshDebtorBalances` (batch) y `RefreshClientBalanceIfStale` (on-demand).
- **BE — on-demand para todos:** extender el trigger en `GetClientDetail` de `status==='late'` a cualquier cliente con `grClienteId` (TTL-gated).
- **BE — contrato:** `InvoiceDto` explícito + mapper en `GET /clients/:id/invoices` con los campos nuevos (importe, saldo, vencimiento, PDF, cupón, MercadoPago, status derivado).
- **FE:** actualizar `types/billing.ts` + `BillingTab.tsx` al DTO nuevo; columnas importe/saldo/vencimiento + botones PDF y MercadoPago + badge por status; "Saldo pendiente" = suma de `balance` de las no-pagadas; ui-ux-pro-max.

### Out of Scope
- Sweep proactivo (batch) de clientes ACTIVOS (follow-up).
- El módulo finanzas Splynx (`billing.routes.ts`/`FacturasPage`) — sistema aparte, no se toca.
- Generar/almacenar PDFs propios (solo se guardan los links de GR).
- Pagos / MercadoPago server-side (solo se expone el link que ya da GR).

## Capabilities

### Added
- `gr-invoice-sync`: las facturas de GR se persisten en `Invoice` durante el refresh de balance (batch deudores + on-demand cualquier cliente), replace-all.

### Modified
- `client-invoices-read`: `GET /clients/:id/invoices` pasa a devolver un `InvoiceDto` estable con los campos GR (saldo, links, status derivado) en vez de la entidad de dominio cruda.
- `billing-tab`: el tab Facturación consume el DTO nuevo y muestra facturas reales.

## Approach

1. **Migración** (aditiva, tabla vacía): `prisma migrate diff` sin DB → revisar SQL → archivo. Aditiva + drop de un unique index vacío → segura, pero dry-run rolled-back vs prod antes de deploy.
2. **Parse:** `GrInvoice` tipado + parse de `cuentas.invoices[]` (números AR ya vienen float; fechas DD-MM-YYYY parseadas con guard). TDD con el sample real capturado.
3. **Upsert replace-all:** transacción por cliente — `deleteMany({clientId, grInvoiceId:{not:null}, NOT:{grInvoiceId:{in:currentIds}}})` + `upsert` por `grInvoiceId`. Status derivado. TDD con in-memory.
4. **Wire:** llamar `upsertInvoices` junto a `updateClientBalance` en batch + on-demand; extender el trigger on-demand a todos.
5. **Contrato + FE:** `InvoiceDto` + mapper; FE type + BillingTab campo-a-campo (ambos prompts con el contrato explícito).
6. **Gate:** BE suite+tsc, FE suite+tsc, migración dry-run, review adversarial (foco: TZ de fechas, replace-all no borra manuales, contrato BE↔FE, status derivation en bordes de vencimiento, aislamiento GR).

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Fechas DD-MM-YYYY parseadas con TZ del proceso (container UTC) → vencimiento corrido | Media | Parsear con TZ AR explícita (mismo patrón que `isoDate()` del password GR) |
| Replace-all borra facturas manuales | Baja | Scope estricto `grInvoiceId IS NOT NULL` + test que planta una manual y verifica que sobrevive |
| Contrato BE↔FE driftado → tab crashea | Media | DTO explícito campo-a-campo en AMBOS repos + test de mapper + foco de review |
| `numero` no único rompe el upsert | Baja | Clave = `grInvoiceId` compuesto (`tipo-sucursal-numero`), no `numero` |
| Tipos de comprobante distintos a "FB" (notas de crédito con saldo negativo) | Media | `grType` guardado; status por `saldo` maneja saldo<=0→pagada; documentar y testear saldo negativo |

## Rollback
Revertir los commits BE+FE. La migración es aditiva (+ drop de un índice unique sobre tabla vacía) → un revert dropea las columnas nuevas sin pérdida (la tabla no tenía data previa).

## Success Criteria
- [ ] Abrir un deudor real → el tab Facturación muestra sus facturas GR (importe/saldo/vencimiento/PDF/MercadoPago) y "Saldo pendiente" coherente con `balanceDue`.
- [ ] Pagar una factura en GR → tras el refresh, desaparece del tab (replace-all).
- [ ] Una factura manual (grInvoiceId null) nunca es borrada por el sync.
- [ ] Status derivado correcto en bordes (vto hoy, saldo 0, saldo negativo).
- [ ] Fechas correctas en TZ AR (no corridas por UTC).
- [ ] BE suite+tsc verdes, FE suite+tsc verdes, migración dry-run OK, review CLEAN.
