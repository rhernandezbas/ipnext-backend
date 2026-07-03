# Design: gr-invoices-sync

## Datos verificados (Phase-0 en vivo, 2026-07-03)

`cliente` → `clientes[0].cuentas.invoices[]`, item real (25/25 deudores probados lo tienen):

| GR field | tipo | → `Invoice` | Notas |
|----------|------|-------------|-------|
| `tipo` | str ("FB") | `grType` | tipo de comprobante |
| `sucursal` | str ("00010") | (parte de grInvoiceId) | |
| `numero` | str ("000074035") | `number` | NO único solo |
| `moneda` | str ("PES") | `currency` | |
| `fecha` | str "DD-MM-YYYY" | `issueDate` | parse TZ AR |
| `fecha_vto` | str "DD-MM-YYYY" | `dueDate` | parse TZ AR |
| `importe` | float | `amount` (Decimal) | total |
| `saldo` | float | `balance` (Decimal) | pendiente; deriva status |
| `url_pdf` | str | `pdfUrl` | |
| `cupon_pdf` | str | `couponPdfUrl` | |
| `payments_url.MercadoPago` | str | `paymentUrl` | link de pago |

**Identidad (upsert key):** `grInvoiceId = "{tipo}-{sucursal}-{numero}"` (ej. `"FB-00010-000074035"`). GR no da id atómico.

## Decisiones

### AD-1 — `grInvoiceId String? @unique` como clave e isolation (mirror de grClienteId/grContratoId)
Nullable + unique, exactamente como `Client.grClienteId`/`Contract.grContratoId`. Sirve de clave de upsert y de marcador de "esto vino de GR" → trivialmente droppable cuando GR se deprecie. Una factura futura no-GR simplemente deja `grInvoiceId` null y el sync jamás la toca.

### AD-2 — Status DERIVADO, no persistido desde GR
GR no manda status. Se deriva al upsertear:
```
saldo <= 0            → pagada
saldo > 0 && vto >= hoy(AR) → pendiente
saldo > 0 && vto <  hoy(AR) → vencida
```
Mapea 1:1 al enum `InvoiceStatus` existente (`pagada`/`pendiente`/`vencida`) — sin migración de enum. `hoy` en TZ AR (bordes de vencimiento). Nota: notas de crédito (`saldo` negativo) → `pagada` (saldo<=0), correcto para "no debe nada".

### AD-3 — Replace-all scopeado (decisión del usuario: espejo exacto)
Por cliente, en transacción:
1. Calcular `currentIds = grInvoiceId de las facturas devueltas ahora`.
2. `deleteMany({ clientId, grInvoiceId: { not: null }, NOT: { grInvoiceId: { in: currentIds } } })` → borra SOLO GR-invoices del cliente que GR ya no devuelve. **`grInvoiceId: { not: null }` protege las manuales.**
3. `upsert` cada actual por `grInvoiceId` (crea o actualiza importe/saldo/status/links).
Si GR devuelve `invoices: []` para el cliente → borra todas sus GR-invoices (quedó sin deuda). Idempotente.

### AD-4 — TZ Argentina en el parse de fechas (gotcha conocido)
`fecha`/`fecha_vto` son `DD-MM-YYYY`. El container corre UTC → parsear con `getDate()` corre el día en la franja noche-AR. Parsear fijando `America/Argentina/Buenos_Aires` (mismo patrón que `isoDate()` del password GR, ICU embebido de node). Se guardan como `DateTime` (medianoche AR).

### AD-5 — Wire en ambos refresh + on-demand para todos
- `RefreshDebtorBalances` (batch, deudores) y `RefreshClientBalanceIfStale` (on-demand) llaman `mirror.upsertInvoices(...)` junto al `updateClientBalance` que ya hacen. Ambos ya tienen el `GrClientBalance` con las invoices parseadas → cero llamadas GR nuevas.
- **On-demand para TODOS:** en `GetClientDetail`, el gate hoy es `status==='late'`. Se extiende a "cualquier cliente con `grClienteId`" (sigue TTL-gated por `RefreshClientBalanceIfStale`, timeout 4000ms, swallow de errores → nunca bloquea la ficha). Así todo cliente que se abre sincroniza sus facturas.
- Batch proactivo se mantiene solo en deudores (no se barre activos por carga GR).

### AD-6 — Contrato `InvoiceDto` explícito (fix del bug latente BE↔FE)
El route `GET /clients/:id/invoices` hoy devuelve la entidad de dominio cruda (nombres/status que el FE NO entiende). Se define un `InvoiceDto` estable y un mapper en el route. Campos del DTO (contrato, va idéntico en el type del FE):
```ts
interface InvoiceDto {
  id: string; number: string; grType: string | null;
  amount: number; balance: number; currency: string | null;
  status: 'pagada' | 'pendiente' | 'vencida';
  issueDate: string;  // ISO
  dueDate: string;    // ISO
  pdfUrl: string | null; couponPdfUrl: string | null; paymentUrl: string | null;
}
```
El FE (`types/billing.ts` + `BillingTab.tsx`) se reescribe contra ESTE contrato. "Saldo pendiente" = Σ `balance` de status != 'pagada'. Se dropea el vocabulario viejo (`draft/sent/paid/...`) del type del cliente.

## Áreas afectadas

**BE:** `GestionRealClient.ts` (parse) · `domain/entities/gestionReal.ts` (`GrInvoice`, `GrClientBalance.invoices`) · `prisma/schema.prisma` + migración · `domain/ports/ClientMirrorRepository.ts` (`upsertInvoices`) · `PrismaClientMirrorRepository.ts` + `InMemoryClientMirrorRepository` · `RefreshDebtorBalances.ts` · `RefreshClientBalanceIfStale.ts` · `GetClientDetail.ts` (gate) · `application/dto/invoice.dto.ts` (nuevo) · `clients.routes.ts` (mapper) · `PrismaCustomerRepository.toInvoice` + `domain/entities/billing.ts` (campos nuevos).

**FE:** `types/billing.ts` · `pages/customers/tabs/BillingTab.tsx` · `api/customers.api.ts` (si cambia el shape) · tests.

## Verificación
BE: parse con el sample real, upsert replace-all (incl. protección de manuales + `invoices:[]`), status derivation en bordes, TZ de fechas, mapper del DTO. FE: BillingTab con el DTO nuevo (saldo, links, badge). Migración dry-run rolled-back vs prod. Review adversarial (foco TZ, replace-all, contrato, aislamiento).
