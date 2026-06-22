# Change: add-by-pppoe-router-model

## Why
La feature "Agregar por PPPoE" detecta el router del cliente por la ARP de la antena
(`/proc/net/arp`) → MAC + marca por OUI, pero NO trae el MODELO. Verificado EN VIVO (2026-06-22, 4/4
antenas de Acceso Sur): las antenas airOS están en `netrole=router` con `dnsmasq`, y el lease file
**`/tmp/dhcpd.leases`** guarda el hostname del router del cliente = su MODELO real
(`TL-WR820N`, `MW305R`, `TL-WR841HP`). El proposal original (`add-by-pppoe`) dejó "modelo exacto del
router" como Out of Scope; el DHCP lease lo resuelve gratis.

## What changes
- `Ssh2AirOsGateway.inspect` lee también `/tmp/dhcpd.leases` y expone `leases` (mac→hostname).
- `InspectPppoeDevices` cruza la MAC del router (de la ARP) con los `leases` → `router.model`.
- El DTO de `GET /contracts/:id/inspect-pppoe-devices` gana `router.model` (aditivo).

## Impact
- Affected code: `AirOsGateway` (port), `Ssh2AirOsGateway`, `InspectPppoeDevices`,
  `InMemoryAirOsGateway`, y el shape de respuesta (la ruta serializa el result del use case directo).
- ADITIVO: `router.model` es nuevo, no rompe el contrato. Best-effort: antena en bridge / sin
  hostname (`*`) → `model: null`.
- FE (mostrar el modelo en el modal de revisión) = cambio coordinado aparte.
