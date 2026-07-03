# Proposal: Pre-provisión de PPPoE sin NAS + tipo de IP obligatorio + auto-instalación

## Intent

Crear un PPPoE con usuario + contraseña + plan + **tipo de IP (obligatorio, persistido)** y **SIN router**. El cliente se instala físicamente en cualquier nodo; el watcher de pppoe-move-nas (W2, EN PROD) lo detecta como "pendiente de instalación" y lo **adopta automáticamente**: NAS real + IP fija del pool del tipo elegido + kick → el cliente queda con su IP estática definitiva sin que ningún operador haya elegido NAS.

## Por qué funciona (validado contra la arquitectura)

- El RADIUS HA es **CENTRAL**: un usuario en radcheck autentica desde cualquiera de los 10 NAS (verificado — la migración 2026-06-30 unificó todos los NAS al HA).
- Sin Framed-IP, el NAS asigna una IP **temporal** de su pool local/fallback (NE8000: `ip-pool asur-cgnat` del domain, verificado Free=83; canepa: perfil default → `pool-emergencia`, verificado). **La IP temporal NO necesita NAT**: alcanza con que la sesión exista en radacct para que el watcher la vea (≤2 min sin internet es aceptable).
- El watcher ya tiene TODO el motor: detección por sesiones, move con FindFreeIp + changeFramedIp + kick, defensas (freshness, breaker, cooldown, conflicto multi-NAS), registro visible.

## Requisito del usuario (2026-07-02)

1. **Tipo de IP OBLIGATORIO** al crear (Privada/Pública) — hoy es solo una ayuda visual del form.
2. **NAS NO requerido** al crear — el PPPoE "se auto-instala" cuando el cliente conecta.

## Scope

- **BE**: migración `nasId` → nullable + campo nuevo `ipTypePreference` ('cgnat'|'public', NOT NULL con default 'cgnat' para las filas existentes + backfill best-effort de las públicas clasificables) + rama de creación sin NAS + extensión del watcher (rama "pending install") + DTO/listados tolerantes a NAS null.
- **FE**: form "Cargar PPPoE" — tipo de IP requerido SIN preselección + opción "Sin router (auto-instalación)" en el selector + badge "Pendiente de instalación" en el tab PPPoE y en el panel del cliente.
- **Fuera de scope**: cargar los pools públicos faltantes (deuda existente, aparte); enforcement de servicios pendientes (limitación documentada: no aplica hasta la adopción); cambiar la semántica del move manual.

## Waves

- **W0 — Recon GO/NO-GO (read-only):** verificar en los 8 MikroTiks restantes que el PPPoE server asigna dirección SIN Framed-IP (perfil default con `remote-address`/pool). NE8000 ✅ y canepa ✅ ya verificados. Un NAS sin fallback = los pre-provisionados NO conectan ahí (documentar por NAS).
- **W1 — BE + FE** (worktrees, TDD, review adversarial, push con validaciones).

## Dependencias

- Flag `pppoe-auto-move` ON para que la auto-instalación ocurra (el auto-instalador ES el watcher). Con flag OFF, los pre-provisionados quedan visibles como "Pendiente de instalación" hasta move manual o flag ON.
