# Tasks: add-by-pppoe-router-model

## 1. Dominio (port)
- [ ] `AirOsInspectResult.leases?: Record<string,string>` (mac→hostname)

## 2. Infraestructura (adapter)
- [ ] `parseDhcpLeases(text)` puro + exportado (formato dnsmasq, ignora `*`)
- [ ] `Ssh2AirOsGateway.inspect`: 3er comando `cat /tmp/dhcpd.leases` + parseo de la 3ra sección
- [ ] `InMemoryAirOsGateway`: default `leases: {}`

## 3. Aplicación (use case)
- [ ] `InspectPppoeDevices`: `router.model` = `leases[routerMac]` ?? null (cruce por MAC)
- [ ] `InspectPppoeDevicesResult.router` gana `model: string | null`

## 4. Tests (TDD — rojo primero)
- [ ] `airOsParsers.test.ts`: `parseDhcpLeases` (formato real, `*`, inválidas, vacío)
- [ ] `InspectPppoeDevices.test.ts`: router.model desde lease; null sin lease
- [ ] suite completa + tsc limpio

## 6. Robustez (de judgment-day)
- [x] `splitAirOsSections` (split por líneas-marcador EXACTAS, robusto a marcador embebido) + 3 tests

## 5. Cierre
- [x] suite completa verde + tsc limpio
- [x] judgment-day → APPROVED (0 críticos; WARNING real del split fixeado inline + testeado;
      theoretical de dnsmasq —duplicados/espacios— no bloquean)
- [ ] push + PR (BE). FE coordinado aparte (mostrar el modelo en AddByPppoeReviewModal).
