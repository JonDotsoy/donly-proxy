# Política de seguridad

## Versiones soportadas

Solo la última versión publicada en [Releases](https://github.com/JonDotsoy/donly-proxy/releases/latest) recibe correcciones de seguridad. Si usas una versión anterior, actualiza antes de reportar.

| Versión | Soportada |
| ------- | --------- |
| Última release | Sí |
| Anteriores | No |

## Reportar una vulnerabilidad

**No abras un issue público** para reportar una vulnerabilidad.

Usa el reporte privado de GitHub:
<https://github.com/JonDotsoy/donly-proxy/security/advisories/new>

Incluye, si puedes:

- Versión de `donly-proxy` y de Bun.
- Descripción del problema y su impacto.
- Pasos para reproducirlo (idealmente un `manifest.donly` mínimo).
- Cualquier mitigación que conozcas.

## Qué esperar

- Acuse de recibo en un plazo de 7 días.
- Evaluación y respuesta sobre su validez lo antes posible.
- Si se confirma, se prepara una corrección y se publica una nueva release; se te acreditará en el aviso si lo deseas.

## Alcance

Dentro del alcance: el proxy, su CLI y el procesamiento de `manifest.donly` (por ejemplo, enrutamiento inesperado, exposición de cabeceras o credenciales, SSRF, ejecución de comandos no deseada).

Fuera del alcance: vulnerabilidades en dependencias de terceros (repórtalas a su proyecto; avísanos si nos afectan), y configuraciones inseguras elegidas por el usuario en su propio manifest.

## Buenas prácticas para usuarios

- Descarga el bundle solo desde las releases oficiales del repositorio.
- No expongas el proxy a redes no confiables sin autenticación ni restricciones de acceso.
- No guardes secretos en `manifest.donly` versionado.
