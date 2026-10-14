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

Dentro del alcance: el proxy, su CLI y el procesamiento de `manifest.donly` (por ejemplo, enrutamiento inesperado, exposición de cabeceras o credenciales, inyección de argumentos en `command_pass`, `ssh_pass` o `kubectl_pass`, ejecución de comandos no prevista por el manifest).

Fuera del alcance: vulnerabilidades en dependencias de terceros (repórtalas a su proyecto; avísanos si nos afectan), y configuraciones inseguras elegidas por el usuario en su propio manifest.

## Superficie sensible

`donly-proxy` está pensado para uso **local o de desarrollo**, no para exponerlo a internet. Estas son las partes que tocan otros sistemas o procesos:

| Componente | Qué hace | Riesgo a considerar |
| --- | --- | --- |
| `command_pass` | Pasa la petición a `curl`, `node`, `ssh` o `kubectl` | Ejecuta procesos en la máquina que corre el proxy |
| `proxy_pass` | Reenvía la petición a otro servidor | SSRF: el proxy puede alcanzar hosts internos |
| `ssh_pass` | Conecta a otra máquina por SSH | Uso de las credenciales y llaves SSH del usuario |
| `kubectl_pass` | Entra a un pod de Kubernetes | Uso del contexto y permisos de `kubectl` del usuario |
| Terminación TLS | En HTTPS el proxy descifra el tráfico con un certificado autofirmado generado con `openssl` | Los clientes deben confiar en ese certificado o desactivar la verificación |
| `log_file` | Registra cada petición y respuesta en `.ndjson` | Puede guardar cabeceras, cookies y tokens |
| `manifest.donly` | Define rutas y comandos | Quien lo controla decide qué se ejecuta |

## Buenas prácticas para usuarios

- Descarga el bundle solo desde las releases oficiales del repositorio.
- Mantén `host` en `127.0.0.1`. No expongas el proxy a redes no confiables sin autenticación ni restricciones de acceso.
- Usa solo manifests en los que confíes: pueden ejecutar comandos.
- No guardes secretos en `manifest.donly` versionado.
- Protege o rota los archivos de `log_file`, y no los subas al repositorio.
- No instales el certificado autofirmado como CA del sistema ni desactives la verificación TLS fuera de pruebas locales.
