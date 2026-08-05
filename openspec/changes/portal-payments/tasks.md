# Tasks — `portal-payments`

## Fase 1 — Dominio puro: el importe por moneda (PAY-1.3, PAY-1.4)
- [x] 1.1 Test: un recibo con un item ⇒ un `{currency, amount}`.
- [x] 1.2 Test: dos items de la MISMA moneda ⇒ se suman.
- [x] 1.3 Test: items de monedas DISTINTAS ⇒ NO se suman, salen separados.
- [x] 1.4 Test: `PES`/`DOL` se normalizan a ISO; moneda ausente ⇒ no se fusiona con otra conocida.
- [x] 1.5 Implementar `sumarItemsPorMoneda` puro.

## Fase 2 — Puerto + use case (PAY-1.1, PAY-1.2, PAY-1.5, PAY-1.6)
- [x] 2.1 Test: lista los pagos del cliente del token, orden fecha DESC.
- [x] 2.2 Test: expone `appliedTo[]` con el número de factura (el vínculo que el espejo pierde).
- [x] 2.3 Test: cliente SIN `grClienteId` ⇒ 200 con lista vacía, sin tocar el reader.
- [x] 2.4 Test: recibo `anulado` ⇒ no aparece.
- [x] 2.5 Test anti-IDOR: dos clientes seedeados, cada uno ve SOLO lo suyo.
- [x] 2.6 Puerto `PortalPaymentsReader` + DTO + use case `ListPortalPayments`.

## Fase 3 — Adapter Prisma (PAY-2.1)
- [x] 3.1 Test del adapter REAL: el filtro por `clientGrId` y el de `anulado` viven en el WHERE.
- [x] 3.2 Implementar `PrismaPortalPaymentsReader` con `include` de items + applications.

## Fase 4 — Ruta y wiring
- [x] 4.1 Test de ruta: 200 con el envelope paginado; 401 sin token de portal.
- [x] 4.2 Montar `GET /api/portal/payments` + wiring en `app.ts`.
- [x] 4.3 Composition-root test del wiring.

## Fase 5 — Gate y cierre
- [x] 5.1 Suite completa + `tsc --noEmit`, corridos por el orquestador.
- [x] 5.2 Revert-probes: sacar el filtro de cliente del WHERE · sacar el de `anulado`.
- [x] 5.3 Review adversarial → fix wave → re-review hasta CLEAN.
- [x] 5.4 Push con OK.
- [x] 5.5 **Después del deploy**: prender `enabled=true` + `backfillFloorYearMonth=2026-05`.
- [x] 5.6 **E2E en vivo**: verificar que el pago real del usuario (03-08, $2.500,01, MercadoPago, aplicado a FB-00010-000080104) aparece en el endpoint.
