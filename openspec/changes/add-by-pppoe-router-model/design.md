# Design: add-by-pppoe-router-model

## Decisión 1 — fuente del modelo: el DHCP lease de la antena
La antena airOS en `netrole=router` corre `dnsmasq` y guarda `/tmp/dhcpd.leases` (OJO: `dhcpd`, con
'd'). Formato dnsmasq por línea: `<expiry> <mac> <ip> <hostname> <client-id>`. El hostname es lo que
el router del cliente reporta en el DHCP request (opción 12) — en la práctica, su MODELO. Se cruza
por MAC con el router que ya se detecta en la ARP.

## Decisión 2 — parser puro + best-effort
`parseDhcpLeases(text): Record<mac_lowercase, hostname>` — puro y testeable (igual que
`parseMcaStatus`/`parseArpLan`), ignora `hostname = '*'` (router que no reportó nombre) y líneas
inválidas. El adapter agrega un 3er comando encadenado: `cat /tmp/dhcpd.leases 2>/dev/null`. Si la
antena está en bridge (no hay lease file) → `leases = {}` → `model: null`. Nunca rompe.

## Decisión 3 — `leases` opcional en `AirOsInspectResult`
`leases?: Record<string,string>` opcional, para NO romper los fakes/tests existentes que construyen
el result sin él. El adapter real siempre lo llena; el use case lo trata como `{}` si falta.

## Verificado en vivo (2026-06-22)
4/4 antenas de Acceso Sur tienen `/tmp/dhcpd.leases` con hostname = modelo del router. El CGNAT de
Fibra (RDA1/RDA2, 100.64.13-20/28-35) NO es alcanzable desde el `.37` → no se probó ahí; si esas
antenas están en bridge, el best-effort lo cubre (`model: null`).

## Fuera de scope
- FE (mostrar el modelo en `AddByPppoeReviewModal`) — cambio coordinado aparte.
- Antenas no-airOS / re-descubrimiento periódico.
