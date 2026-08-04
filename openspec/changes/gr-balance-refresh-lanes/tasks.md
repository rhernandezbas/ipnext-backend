# Tasks — `gr-balance-refresh-lanes`

## Fase 1 — Carril explícito en el use case (LANE-1)
- [x] 1.1 Test: el carril rápido pide el balance de un cliente **Activo** (rojo primero — hoy no lo pide).
- [x] 1.2 Test: el carril lento pide el del **Baja** y NO el del Activo.
- [x] 1.3 Test: cada carril escribe su propia `entity` en `SyncState` y no se pisan.
- [x] 1.4 `RefreshDebtorBalances` recibe `{ entity, estados }` REQUERIDO; se borra `DEBTOR_LIKE_STATUSES`.
- [x] 1.5 Exportar `FAST_LANE` (`gr-debtor-balances`, estados 1/2/3/4) y `SLOW_LANE` (`gr-balances-bajas`, estado 6).
- [x] 1.6 Actualizar los tests que pineaban `not.toContain('A1')` — con el porqué en el propio test.
- [x] 1.7 Corregir el comentario falso sobre el estado 1, dejando escrito cómo se refutó.

## Fase 2 — Ventana diaria del carril lento (LANE-2)
- [x] 2.1 Test de `shouldRunDailyLane`: dentro de ventana + no corrió hoy → true.
- [x] 2.2 Test: fuera de ventana (14:00 ART) → false.
- [x] 2.3 Test: dentro de ventana pero ya corrió hoy → false.
- [x] 2.4 Test: última corrida AYER, dentro de ventana → true.
- [x] 2.5 Test de TZ: un instante UTC que es 00:30 ART (03:30 UTC) → **false** (probaría que se usa la TZ AR y no la del proceso).
- [x] 2.6 Implementar `shouldRunDailyLane` puro con `Intl` + TZ AR.

## Fase 3 — Scheduling de los dos carriles (LANE-3)
- [x] 3.1 Test: con el guard tomado, el segundo carril no llama a GR en ese tick.
- [x] 3.2 `bootstrapGestionRealSync` arma los dos jobs con el guard de exclusión compartido.
- [x] 3.3 Composition-root test: se instancian LOS DOS carriles con los estados correctos.

## Fase 4 — Parser: un payload no autoritativo nunca es "deuda cero" (PARSE-1)
- [x] 4.1 Test: sobre de error de GR (HTTP 200 + `{"error":"90"}`) ⇒ tira.
- [x] 4.2 Test: `clientes` vacío / falta `cuentas` / input basura ⇒ tira, con mensaje propio.
- [x] 4.3 Test: `debt` ausente / `null` / `''` / no numérico ⇒ tira.
- [x] 4.4 Test: basura NEGATIVA (`"-500 nota"`) ⇒ tira (el gate `n === 0` la dejaba pasar).
- [x] 4.5 Test: formato ambiguo (`"1.234"`) ⇒ tira; `"0.000"` NO tira.
- [x] 4.6 Test: deuda cero legítima (`"0.00"`) sigue permitiendo el borrado.
- [x] 4.7 Implementar `parseGrDebtStrict` + validación de TIPO de `cuentas` + borrar el `catch { return zero }`.

## Fase 4b — RETIRADO del change (cards propias)
- [x] 4b.1 Refresh on-demand del portal — retirado (carrera de replace-all concurrentes).
- [x] 4b.2 Alarma del carril lento — retirada (falló dos rondas de review).
- [x] 4b.3 Fix del bot de IA — retirado (requiere rediseñar la frescura).

## Fase 5 — Gate y cierre
- [x] 5.1 Suite completa + `tsc --noEmit` (corridos por el orquestador, no por el agente).
- [x] 5.2 Revert-probe de LANE-1.1: sacar el `'1'` del carril rápido ⇒ el test DEBE ponerse rojo.
- [x] 5.3 Revert-probe de PORTAL-1.1: sacar el colaborador del wiring ⇒ el composition-root test DEBE ponerse rojo.
- [x] 5.4 Review adversarial → 3 rondas × 3 revisores → 2 fix waves → reducción de alcance.
- [x] 5.5 Revert-probes finales: 4 aplicados, 4 mutantes muertos.
- [ ] 5.6 `sdd-verify` con matriz de spec-compliance.
- [ ] 5.7 Push con OK del usuario.
