# Tasks: pppoe-preprovision-autoinstall

> TDD estricto. Worktrees. Review adversarial. Push con validaciones verdes.

## W0 — Recon GO/NO-GO (read-only, lo corre el orquestador)

- [ ] 0.1 Por cada MikroTik restante (hipico/vialidad/ugarte/parque/rodriguez/opendoor/estudiantes): pppoe-server → perfil → remote-address/pool → GO/NO-GO documentado en la card. (NE8000 ✅, canepa ✅.)

## W1 — BE (worktree `pppoe-preprovision-be`)

- [ ] 1.1 Migración: `nasId` nullable + `ipTypePreference` default 'cgnat' + backfill públicas clasificables (idempotente, sin BEGIN/COMMIT). Snapshot test.
- [ ] 1.2 Tests RED S1.1–S1.4, S2.1–S2.2 → `CreatePppoeService` rama sin NAS + `ipTypePreference` obligatorio en ambos flujos + DTO.
- [ ] 1.3 Barrido nasId-null (S4.1–S4.3): listados/DTOs/rutas tolerantes; enforce de pendiente → 409 tipado; move manual de pendiente = adopción (usa `ipTypePreference`).
- [ ] 1.4 Tests RED S3.1–S3.7 → rama "pending install" en `AutoMovePppoe` (adopción con defensas compartidas, reason `auto_install`).
- [ ] 1.5 Wiring + composition pins. Gate: tsc + suite completa.

## W1 — FE (worktree `pppoe-preprovision-fe`)

- [ ] 2.1 ui-ux-pro-max PRIMERO.
- [ ] 2.2 Tests RED S5.1–S5.4 → form (tipo de IP requerido sin preselección; "Sin router — auto-instalación"; IP remota oculta sin router) + wire `{ipTypePreference, nasId?}`.
- [ ] 2.3 Badge "Pendiente de instalación" + filtro Pendientes (tab PPPoE) + panel del cliente.
- [ ] 2.4 Gate: tsc + Vitest TZ=UTC.

## Cierre

- [ ] 3.1 Review adversarial (BE: 2 focos — adopción/nasId-null + wiring; FE: 1) → fix waves → CLEAN.
- [ ] 3.2 Push BE→FE (validaciones) + deploys verdes + card BACKLOG.
- [ ] 3.3 Prueba en vivo: pre-provisionar un usuario de PRUEBA, conectarlo (o simular sesión), ver la adopción en el tab + limpiar.
