# Spec — service-transfer (delta)

Formato RFC-2119. Cada scenario DEBE quedar cubierto por al menos un test verde (sdd-verify).

## Capability: transferencia de TV entre clientes

### Requirement: TV-1 — transferencia exitosa
El sistema MUST transferir la cuenta TV (CIC) del cliente origen al destino sin dar de baja la
cuenta del partner y sin alterar login/packs/OTT.

#### Scenario: happy path
- Given cliente origen vinculado a un CIC (cuenta resuelve por su internal_id vigente) y cliente
  destino sin TV, con contrato destino propio
- When se ejecuta TransferTvToCustomer
- Then se llama setInternalId(cic, internalIdDestino), se VERIFICA re-leyendo por el internal_id
  destino que account.cic == cic, se marca tvCancelledAt en el origen, se limpia en el destino,
  el slot TV local del origen queda inactivo con credenciales limpias, el slot TV del contrato
  destino queda activo con el CIC, y se graban eventos transfer-out (contrato origen) y
  transfer-in (contrato destino) con actor y nombres de ambos clientes

#### Scenario: el CUA acepta pero el alias no tomó
- Given el partner responde 200 al PATCH pero el GET por internal_id destino devuelve 404 o un CIC distinto
- When se ejecuta la transferencia
- Then el use case MUST lanzar error (rejected) SIN tocar estado local (ni flags ni slots ni eventos)

#### Scenario: destino ya tiene TV
- Given el internal_id vigente del destino resuelve a una cuenta
- When se intenta transferir
- Then MUST rechazar con 409 sin llamar setInternalId

#### Scenario: origen sin TV
- Given el origen tiene tvCancelledAt seteado, o su internal_id no resuelve (404 upstream)
- When se intenta transferir
- Then MUST responder 404 TV_NOT_LINKED sin efectos

#### Scenario: contrato destino ajeno
- Given targetContractId existe pero pertenece a otro cliente
- When se intenta transferir
- Then MUST responder 404 (sin leak) ANTES de cualquier llamada a Gigared

#### Scenario: fallo local tras alias exitoso (parcial)
- Given el alias del partner se verificó OK
- When markCancelled(origen) o un reconcile de slot falla
- Then la operación partner NO se revierte y el router MUST responder 207 con el detalle
  (severed/localSource/localTarget) para retry direccionado

### Requirement: TV-2 — el origen nunca se "limpia" con CancelTv
El flujo de transferencia MUST NOT invocar CancelTv/removeService/renewCic sobre la cuenta.

#### Scenario: sin teardown
- Given una transferencia en curso
- When se completa (éxito o parcial)
- Then el GigaredPort NUNCA recibió removeService/setOtt/renewCic

## Capability: transferencia de PPPoE

### Requirement: PPPOE-1 — modo as-is (fallback con motivo)
El sistema MUST permitir reasignar un PppoeService a otro contrato sin tocar RADIUS, con motivo
obligatorio y marca distintiva en el historial.

#### Scenario: as-is happy path
- Given un PPPoE enabled asociado al contrato A (cliente X) y un contrato B (cliente Y) sin PPPoE enabled
- When se transfiere con mode=as-is y reason="sin acceso a la antena"
- Then contractId pasa a B sin llamadas al orchestrator/router, ensureInternet(A,false) y
  ensureInternet(B,true) se intentan best-effort, y se graban transfer-out en A y transfer-in en B
  con reason y notes marcando "tal cual (sin recrear) — pendiente de regularizar"

#### Scenario: as-is sin motivo
- When se transfiere con mode=as-is sin reason
- Then MUST responder 400 VALIDATION_ERROR sin efectos

#### Scenario: destino ya tiene PPPoE enabled
- Given el contrato destino ya tiene un PppoeService enabled
- When se intenta transferir (cualquier modo)
- Then MUST rechazar 409 (PppoeContractAlreadyHasServiceError) sin efectos

### Requirement: PPPOE-2 — modo recreate (crear PRIMERO, borrar después)
El sistema MUST crear el PPPoE nuevo en el destino antes de borrar el viejo; si el create falla
el viejo queda intacto.

#### Scenario: recreate happy path
- Given datos válidos del PPPoE nuevo para el contrato destino
- When se transfiere con mode=recreate
- Then el create ejecuta primero; con create OK se ejecuta el terminate del viejo (hard);
  se graban transfer-out (notes "recreado: viejo → nuevo") y transfer-in

#### Scenario: create falla
- When el create del PPPoE nuevo falla (p.ej. orchestrator rechaza)
- Then MUST abortar sin borrar el viejo y sin eventos (el estado previo queda íntegro)

#### Scenario: terminate falla tras create OK
- When el create fue OK pero el terminate del viejo falla
- Then MUST responder 207 parcial que lo diga explícito (nuevo vivo, viejo pendiente de borrar)
  y los eventos igual se graban con la marca del parcial

## Capability: transferencia de equipos

### Requirement: EQ-1 — mover ítems seleccionados con rastro
El sistema MUST mover los ContractInstalledItem seleccionados al contrato destino y, si el ítem
tiene assetId, registrar el movimiento TRANSFER entre CLIENTE-locations en el ledger.

#### Scenario: transferencia de ítems
- Given dos ítems active del contrato A (uno con assetId, otro sin)
- When se transfieren ambos al contrato B
- Then ambos quedan con contractId B; el que tiene assetId genera un InventoryMovement TRANSFER
  de la CLIENTE-location de A a la de B (find-or-create); se graban transfer-out/in con la lista
  de ítems en notes

#### Scenario: ítem ajeno o inactivo
- Given un itemId que no pertenece al contrato A o no está active
- When se intenta transferir el lote
- Then MUST fallar completo ANTES de mover nada (ningún ítem se mueve)

## Capability: RBAC

### Requirement: RBAC-1 — permiso granular doble capa
Las tres rutas MUST estar gateadas por la acción nueva `transfer` del módulo correspondiente
(tv/pppoe/inventory); sin el permiso → 403 fail-closed.

#### Scenario: sin permiso
- Given un usuario autenticado sin tv:transfer
- When llama POST /api/gigared/customers/:id/transfer-tv
- Then 403 sin efectos

### Requirement: RBAC-2 — no cuelga (lección 504)
Los handlers nuevos MUST forwardear errores con next(err) y responder status inmediato ante
errores tipados del orchestrator/partner.

#### Scenario: partner caído
- Given el GigaredPort lanza GigaredUnavailableError
- When se llama la ruta de transferencia
- Then responde inmediato con el status mapeado (503 GIGARED_UNAVAILABLE / 502 GIGARED_AUTH
  según el mapping local del router gigared), nunca cuelga
