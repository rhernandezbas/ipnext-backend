# tv-reactivation-sequential (#81)

## Why
Cuando un cliente da de baja la TV y luego quiere re-darse de alta, el modelo del partner (CUA/Gigared) tiene una trampa verificada EN VIVO:

- El `renew` del CIC (lo que hace la baja, #64) produce un CIC NUEVO **limpio** (`internal_id=null`). El CIC viejo queda MUERTO (403). El renew NO mueve ni limpia los `internal_id` viejos: quedan enterrados en el CIC muerto.
- El `internal_id` se **QUEMA al primer uso** (mapeo append-only, no se borra). Re-usar el `Client.id` crudo → "ID interno ya está en uso".
- El mail determinístico (#65) repetido → "más de una activación pendiente".

Resultado: con el modelo de hoy (internal_id = `Client.id` pelado, mail = `{apellido}{grId}@gmail.com` fijo), la SEGUNDA alta de TV de un cliente SIEMPRE falla. La identidad es de un solo uso.

## What
Mover la **identidad de TV a nivel Client** (compartida entre los N contratos del cliente) y hacerla **secuencial**:

- **BE (aditivo):**
  - `Client.tvActivationSeq Int @default(0)` (migración aditiva).
  - Helper de dominio `currentTvInternalId(clientId, seq)`: `seq<=0 → clientId` (back-compat), `seq>0 → {clientId}-{seq}`.
  - El `deterministicTvEmail` suma el seq: `{apellido}{grId}{seq}@gmail.com` cuando `seq>0` (seq=0 = el de hoy).
  - `RegisterGigaredAccount` incrementa el seq SOLO en re-alta (cliente que venía de baja), genera internal_id+mail con el seq nuevo, registra sobre el CIC renovado limpio. NUNCA reusa el id viejo.
  - TODOS los demás use cases (get/cancel/changePassword/add/remove/ott/reconcile) resuelven el internal_id VIGENTE vía `currentTvInternalId(clientId, seq)` en vez del `Client.id` pelado.
- **FE:** Credenciales (#65) muestra el internal_id y el mail ACTUALES (recuperables y determinísticos).

## Back-compat (crítico)
- Clientes con TV activa hoy: `seq=0`, internal_id = `Client.id` crudo, mail sin sufijo → SIGUEN funcionando idénticos. El seq solo avanza en la PRÓXIMA reactivación.
- Alta normal de cliente nuevo: primera alta = `seq=0`, sin sufijo, comportamiento byte-for-byte de hoy. El seq se incrementa SOLO cuando el cliente venía de baja (re-alta).

## Wire contract
- `Client.tvActivationSeq` (int, default 0) — nuevo campo aditivo en el modelo.
- `CustomerLookup.findById` gana `tvActivationSeq?: number | null` (opcional → seq 0, back-compat).
- Nuevo port `ClientTvActivationRepository { getSeq, incrementSeq }`.
- Credenciales (#65) endpoint expone `internalId` + `email` ACTUALES además de login/password.
