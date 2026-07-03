# Tasks: gr-invoices-sync

> TDD estricto (test primero). BE con adapters in-memory; FE con Vitest. Gate: BE suite+tsc, FE suite+tsc, migración dry-run, review adversarial CLEAN. Push con validaciones verdes.

## 1. BE — parse de invoices (TDD)
- [ ] 1.1 Test: `parseClientBalanceResponse` con el sample real (`gr_invoices_sample`) captura `cuentas.invoices[]` en `GrClientBalance.invoices: GrInvoice[]` (tipo, sucursal, numero, moneda, fecha, fecha_vto, importe, saldo, url_pdf, cupon_pdf, payments_url.MercadoPago). Casos: `invoices` ausente/`[]`/malformado → `[]` sin throw.
- [ ] 1.2 `GrInvoice` en `domain/entities/gestionReal.ts` + campo `invoices` en `GrClientBalance`. Parse en `GestionRealClient.ts` (números float directos; strings tal cual; guard null).

## 2. BE — schema + migración
- [ ] 2.1 `schema.prisma`: `Invoice` += `grInvoiceId String? @unique`, `balance Decimal? @db.Decimal(12,2)`, `grType String?`, `currency String?`, `pdfUrl String?`, `couponPdfUrl String?`, `paymentUrl String?`; **quitar `@unique` de `number`**.
- [ ] 2.2 Generar migración con `prisma migrate diff` (sin DB). Revisar SQL (ADD COLUMN + DROP INDEX del unique de number + CREATE UNIQUE INDEX grInvoiceId). Aditiva sobre tabla vacía.

## 3. BE — upsert replace-all (TDD)
- [ ] 3.1 Test in-memory: `upsertInvoices(clientId, grInvoices, at)` — crea; re-upsert actualiza saldo/status; una que ya no vuelve se BORRA; `invoices:[]` borra todas las GR; una factura MANUAL (`grInvoiceId=null`) SOBREVIVE siempre.
- [ ] 3.2 Test status derivado: saldo<=0→pagada; saldo>0 & vto futuro→pendiente; saldo>0 & vto pasado→vencida; borde vto==hoy(AR)→pendiente; saldo negativo→pagada.
- [ ] 3.3 Test TZ: `fecha_vto` "07-07-2026" → dueDate correcto en AR (no corrido por UTC).
- [ ] 3.4 `ClientMirrorRepository.upsertInvoices` (port) + `PrismaClientMirrorRepository` (tx: deleteMany scopeado + upsert por grInvoiceId) + `InMemoryClientMirrorRepository`. Helper de status derivation + parse de fecha AR compartido.

## 4. BE — wire
- [ ] 4.1 `RefreshDebtorBalances`: tras `updateClientBalance`, llamar `upsertInvoices(clientId, balance.invoices, at)`. Test.
- [ ] 4.2 `RefreshClientBalanceIfStale`: idem. Test.
- [ ] 4.3 `GetClientDetail`: extender el gate on-demand de `status==='late'` a cualquier cliente con `grClienteId`. Test (un activo con grClienteId dispara el refresh stale).

## 5. BE — contrato (DTO) + read
- [ ] 5.1 `domain/entities/billing.ts` `Invoice` += `grInvoiceId`, `balance`, `grType`, `currency`, `pdfUrl`, `couponPdfUrl`, `paymentUrl`. `PrismaCustomerRepository.toInvoice` mapea los nuevos (Decimal→number).
- [ ] 5.2 `application/dto/invoice.dto.ts` + mapper (ver design AD-6). `GET /clients/:id/invoices` devuelve `InvoiceDto[]`. Test de ruta con supertest (planta invoices reales, verifica el shape del DTO).

## 6. FE (TDD, ui-ux-pro-max)
- [ ] 6.1 `types/billing.ts`: reescribir `Invoice`/`InvoiceStatus` al contrato del DTO (status `pagada|pendiente|vencida`; campos amount/balance/issueDate/dueDate/links).
- [ ] 6.2 `BillingTab.tsx`: columnas Número/Emisión/Vencimiento/Importe/Saldo/Estado + acciones PDF y MercadoPago; "Saldo pendiente" = Σ balance de status!=pagada; "Próximo vencimiento" = min dueDate de no-pagadas; badge por status. Ajustar `invoiceStatusToBadge`.
- [ ] 6.3 Tests: BillingTab renderiza facturas reales, suma saldo correcta, badges, links; no crashea con lista vacía.

## 7. Gate + review
- [ ] 7.1 BE: suite completa + `tsc --noEmit` (orquestador).
- [ ] 7.2 FE: suite completa + typecheck.
- [ ] 7.3 Migración: dry-run rolled-back vs prod (aditiva; confirmar DROP INDEX de number no rompe).
- [ ] 7.4 Review adversarial (foco: TZ fechas, replace-all no borra manuales, contrato BE↔FE, status en bordes, aislamiento GR, saldo negativo/notas de crédito).
- [ ] 7.5 Fix wave + re-review hasta CLEAN.

## 8. Salida
- [ ] 8.1 Commits BE + FE (conventional). Push con OK/validaciones verdes. Migración corre en el deploy BE.
- [ ] 8.2 Verify en vivo: abrir un deudor real en prod → facturas reales en el tab. BACKLOG → ✅ EN PROD.
