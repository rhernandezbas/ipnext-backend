# Proposal: notificaciones push a clientes (avisos de servicio + promociones)

> v2.C del EPIC de la app de clientes. **Bloqueada por un trámite del usuario**: Android exige
> FCM/Firebase (proyecto gratis + `google-services.json`) porque buildeamos nosotros, no con EAS.

## Intent

Que el cliente **se entere sin abrir la app**. Dos casos con naturaleza —y reglas— distintas:

1. **Avisos de servicio** (transaccional): "hay una falla en tu zona, estimamos resolverla a las
   15:30", "tu visita técnica es mañana entre 9 y 13", "el operador respondió tu reclamo".
2. **Promociones** (marketing): ofertas, upgrades de plan, beneficios.

**El caso 1 es el que descomprime tu operación**: hoy una caída de nodo son 40 llamadas
preguntando lo mismo. Un aviso proactivo mejora la percepción del servicio *aunque el servicio
esté caído*.

## Las reglas (verificadas 2026-07-31)

| | Avisos de servicio | Promociones |
|---|---|---|
| Apple 4.5.4 | Sin restricción (transaccional) | **Opt-in EXPLÍCITO** con texto de consentimiento en la app + forma de darse de baja **desde la app** |
| Google Play | Sin restricción | Permiso de notificaciones explícito (Android 13+) + política de no-engaño |
| Ambos | El push **NUNCA** puede ser requisito para que la app funcione | ídem |
| AR (Ley 25.326 art. 27) | — | El titular puede pedir ser retirado de bases de marketing |

## Scope

### In Scope

1. **DOS canales separados** (Android notification channels + toggles propios en iOS):
   **"Avisos de servicio"** y **"Promociones"**. ⚠️ **Innegociable**: el cliente puede apagar las
   promos **manteniendo** los avisos. Bundlear ambos en un permiso único es mala práctica *y*
   zona gris con las stores — y el resultado real sería gente apagando TODO y perdiéndose los
   avisos que importan.
2. **Registro de dispositivos**: tabla de push tokens por `PortalAccount` (varios dispositivos
   por cliente), con baja al cerrar sesión/borrar cuenta y limpieza de tokens muertos que FCM
   reporte inválidos.
3. **Consentimiento de promociones**: persistido y auditable (cuándo aceptó, desde qué versión),
   revocable desde la app en un toque.
4. **Segmentación por topología** (lo que ningún ISP grande hace bien): cuando cae un nodo,
   Prominense **sabe qué clientes están afectados** — el aviso va **solo a ellos**, no a los 5.000.
   Esa es la diferencia entre una app que informa y una que molesta.
5. **Envío desde Prominense**: pantalla de operador para disparar un aviso de servicio (con
   preview de a cuántos clientes le llega y confirmación de impacto — regla de acciones de alto
   riesgo) y otra para campañas promocionales que respeta el consentimiento.
6. **Deep link**: tocar la notificación abre lo que corresponde (el reclamo, la factura, la
   orden de servicio), no la home.

### Out of Scope

- Push a iOS (necesita el Apple Developer Program, fase 5 del EPIC).
- Mail/SMS como canal alternativo (Chatwoot ya cubre WhatsApp para otro flujo).
- Notificaciones dentro de la app (in-app inbox) — se evalúa después.

## Prerequisito BLOQUEANTE

**Proyecto Firebase + `google-services.json`** (gratis, ~10 min de trámite del usuario). Sin eso
no hay push de ningún tipo en Android. Es lo único que falta para arrancar.
