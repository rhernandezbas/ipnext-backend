# Proposal: Mover PPPoE de NAS (radius-aware) — manual + automático

## Intent

Que mover un cliente PPPoE a otro NAS le reasigne la IP: una IP NUEVA, libre, del pool **CGNAT del NAS destino**, que queda **FIJA** (Framed-IP en radreply). Dos disparadores:

1. **Manual** — el operador usa el botón "Mover NAS" (tab PPPoE de Gestión de Red).
2. **Automático** — un watcher periódico detecta que el cliente autenticó por un NAS **distinto** al asignado (la antena se movió físicamente) y dispara el mismo move solo.

## Problema

- El requisito operativo es **IP siempre estática** (gestión de las antenas Ubiquiti por IP). El **único** caso donde la IP puede cambiar es el cambio de NAS: la IP CGNAT vieja no rutea/NATea en el nodo nuevo → cliente sin internet hasta que alguien lo arregle a mano.
- El use case actual `MovePppoeServiceToRouter` es **pre-HA**: copia el secret por API MikroTik al router destino y NO reasigna la IP. Con los 10 NAS en `radius_orchestrator` (migración 2026-06-30), ese flujo es inservible: el secret vive en el RADIUS central (no hay nada que copiar) y la IP queda rota.

## Contexto verificado (recon 2026-06-30/07-01, en vivo)

- Los **10 NAS** de Prominense son `radius_orchestrator`; `NasServer.nasIpAddress` (IP RADIUS del NAS) está **poblado en los 10**.
- **30 pools** cargados en `IpPool`/`IpNetwork`, coinciden con los rangos CGNAT reales de cada router (verificado contra los MikroTik + NE8000).
- El **netmap CGNAT es exhaustivo** (/24 completo pre-mapeado) en los routers verificados → cualquier IP del pool tiene NAT.
- El orchestrator ya expone todo lo necesario: `changeFramedIp`, `disconnectSessions`, `listAllSessions` (cada sesión trae `nasIpAddress`), `listAssignedIps`.
- `FindFreeIp` (multi-pool por NAS) está en prod.
- **sqlippool DESCARTADO** para este requisito: daría IP dinámica de lease (puede cambiar) — rompe "estática para llegar a las Ubiquiti".

## Decisiones del usuario (2026-07-01)

- **(a) Solo CGNAT en el auto-move.** Un cliente cuya IP actual es PÚBLICA fija (negocio) NUNCA se cambia solo: se detecta, se loguea/avisa, y queda para move manual.
- **(b) Sin ventana anti-rebote.** Los clientes no rebotan entre nodos (el cambio de nodo es un movimiento físico/manual de la antena). El watcher actúa al tick siguiente de detectar el mismatch; no necesita ser instantáneo. Intervalo env-configurable.
- **(c) Disconnect inmediato** tras reasignar, para que la re-auth tome la IP nueva ya.

## Refinamientos del usuario (2026-07-01, 2ª ronda)

- **(1) Errores VISIBLES en el sistema:** el fallo del auto-move (pool lleno) y los skips NO viven solo en logs de container — se registran en la **page de auditoría de Gestión de Red** (`/admin/networking/audit`), tab nuevo "Movimientos NAS" (tabla `PppoeNasMoveEvent`).
- **(2) Historial del cliente:** cada move queda en el historial del servicio de Internet que ya se maneja (confirma REQ-HIST-1).
- **(3) Flag en la Config UI:** el ON/OFF del auto-move es un feature flag visible/toggleable desde la UI (patrón del toggle de `radius-auth-ingest`), no solo env.
- **(4) Intervalo del watcher: 2 minutos** (default 120000 ms, env-configurable).

## Scope

- **BE**: rama radius-aware del move (nuevo use case `MovePppoeToNas` que subsume al legacy para NAS no-radius) + use case de detección/auto-move + watcher/scheduler gateado por feature flag (UI) + eventos de historial + **tabla `PppoeNasMoveEvent` (migración ADITIVA)** con endpoint de listado para el registro visible.
- **FE**: el modal "Mover NAS" existente pasa a avisar "se asignará una IP nueva del pool del destino y se desconectará la sesión"; mostrar la IP nueva en el resultado. + **Tab "Movimientos NAS"** en la page de auditoría (`/admin/networking/audit`) listando movimientos y fallos. ui-ux-pro-max.
- **Fuera de scope**: FreeRADIUS/AAA (cero cambios), sqlippool, RDA1/RDA2 fibra local (no están en el HA), alerta Telegram (Ola 3, se deja el hook de log estructurado).

## Waves

1. **W1 — Move manual radius-aware** (BE + FE). La pieza core reutilizable.
2. **W2 — Auto-move** (BE): watcher + detección + flag, reusa el core de W1.

## Proceso

SDD completo + worktrees dedicados + TDD estricto + review adversarial + verify antes de push + push con OK del usuario, wave por wave.
