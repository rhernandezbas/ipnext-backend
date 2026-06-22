# add-by-pppoe (delta)

## MODIFIED Requirement: Detección del router del cliente
La inspección de equipos por PPPoE DEBE detectar el router del cliente con su MAC, su marca (por OUI)
y, cuando esté disponible, su MODELO leído del DHCP lease de la antena.

### Scenario: el modelo del router viene del DHCP lease (cruce por MAC)
- **WHEN** la antena tiene un lease en `/tmp/dhcpd.leases` para la MAC del router con hostname `TL-WR820N`
- **THEN** `router.model` es `"TL-WR820N"`
- **AND** `router.mac` y `router.brand` (OUI) se mantienen

### Scenario: sin lease para la MAC → modelo null (best-effort)
- **WHEN** la antena no tiene lease para la MAC del router (bridge, o hostname `*`)
- **THEN** `router.model` es `null`, sin romper la inspección

### Scenario: parser de leases ignora hostnames vacíos
- **WHEN** una línea del lease file tiene hostname `*`
- **THEN** esa MAC no aparece en el mapa de leases
