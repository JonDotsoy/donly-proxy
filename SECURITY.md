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
| `log_file` | Registra cada petición y respuesta en `.ndjson` | Puede guardar cabeceras, cookies y tokens (también en la línea `script` del motor `node` remoto) |
| `manifest.donly` | Define rutas y comandos | Quien lo controla decide qué se ejecuta |

## `globalThis.__donlyRequest`

Con el motor `node` **remoto** (`command_pass ssh` / `kubectl` con `engine node`, `ssh_pass` y
`kubectl_pass` con `command_pass node`) el proxy no puede pasar la petición como archivo ni como
argumento, así que la entrega dentro del propio programa que envía por stdin
(`node --input-type=module -`). La primera línea de ese programa es:

```js
globalThis.__donlyRequest = JSON.parse(Buffer.from("<base64>", "base64").toString());
```

`node-request.mjs` (el resto del programa) usa esa variable en lugar de leer stdin. Con el `node`
local no existe: la petición llega como JSON por stdin.

| Aspecto | Detalle |
| --- | --- |
| Dónde se define | Solo en el proceso `node` remoto, al inicio del programa de stdin (`src/proxy/tunnel/node/remote.ts`). |
| Qué contiene | La petición completa: `method`, `url`, `headers` (incluidos `authorization`, cookies y tokens) y `body` en base64. Es la misma información que el cliente envió al proxy. |
| Quién puede leerla | Todo el código que corra en ese proceso `node`: `node-request.mjs` y cualquier módulo que cargue, incluidos los que se precarguen con opciones de node (`--import`, `--require`) declaradas en el manifest. Es una variable global, sin aislamiento. |
| Cuánto vive | Lo que dura el proceso, que es una sola petición. Solo está en memoria: no se escribe en disco. `node-request.mjs` no la borra al leerla. Un volcado de memoria, un reporte de diagnóstico o un `core dump` del proceso la incluirían. |
| Qué no es | No es una forma de cifrar la petición: el base64 solo evita que los datos se interpreten como código. |

Implicaciones:

- **Sin inyección de código.** La petición se incrusta como un literal de texto en base64 (`JSON.stringify`
  de un string) y se decodifica con `JSON.parse`: nunca se evalúa. Una URL, cabecera o cuerpo con
  comillas o `$(…)` no puede salirse de ese literal. Este es el mismo principio de
  [`command_pass`](docs/tunnel/command-pass.md#ciclo-de-vida-setup-ejecución-y-stdin): ningún dato de la petición llega a una línea de comandos.
- **No aparece en la línea de comandos** de `ssh`, de `kubectl` ni del proceso remoto (`ps`,
  `/proc/<pid>/cmdline`), ni en el entorno. Sí está en el stdin del proceso, y por eso:
- **El host o contenedor remoto ve la petición en claro**, incluidas las credenciales de las cabeceras. Solo
  úsalo contra destinos en los que confíes. En tránsito va cifrado por `ssh` o por la conexión de
  `kubectl` con el API server.
- **El `log_file` la guarda.** La línea `script` registra el programa completo, base64 incluido, que
  se decodifica trivialmente. Esto no añade exposición (la línea `request` ya guarda las cabeceras y
  el cuerpo), pero protege o rota el archivo igual: ver las buenas prácticas de abajo.
- **El manifest decide qué código corre.** Las opciones de node (`"--import"`, `extra_args`) van
  antes del programa; un módulo precargado puede leer o reemplazar `__donlyRequest`. Un cliente no
  puede influir en eso, pero un manifest no confiable sí (ya está en la superficie de
  `manifest.donly` de arriba).

### ¿Escribe algo en disco o deja datos en memoria?

Resumen verificado en el código (`src/proxy/server.ts`, `certs.ts`, `tunnel/`):

**En disco, en la máquina que corre el proxy**

| Qué | Cuándo | Contenido | Vida |
| --- | --- | --- | --- |
| `log_file` | Solo si el manifest lo define | Cada `request` y `response` con cabeceras y cuerpo, las líneas `command` y, con `node` remoto, la línea `script` (la petición completa en base64) | Permanente: el proxy nunca lo borra ni lo rota |
| `cert.pem` y `key.pem` | Al arrancar, solo si no existen | Certificado autofirmado y su llave privada, sin cifrar | Permanente |
| Programa `askpass` en un directorio temporal (`donly-proxy-askpass-*`) | La primera vez que se usa `ssh_pass` con `pass` | Un script de dos líneas que imprime `$DONLY_SSH_PASSWORD`. **No contiene la contraseña.** Permisos `0700` | Se reutiliza hasta que termina el proxy y **no se borra** |

**En disco, en el host o contenedor remoto** (`ssh` / `kubectl` con motor `curl` o `wget`)

| Motor | Archivo temporal | Contenido | Vida |
| --- | --- | --- | --- |
| `curl` | `mktemp -d` → `c` | Configuración de curl: URL, método y **cabeceras** (con credenciales) | Hasta que termina el comando (`trap … EXIT` borra el directorio) |
| `wget` | `mktemp -d` → `b` | El **cuerpo** de la petición (para `--post-file`) | Igual |

`trap EXIT` no se ejecuta si el proceso remoto muere por `SIGKILL` o se corta la conexión de forma
abrupta: en ese caso el directorio puede quedar en el `/tmp` remoto con los datos.

**Qué NO se escribe en disco**

- El motor `node` (local o remoto) no crea archivos: la petición viaja por stdin y vive solo en la memoria
  del proceso (`globalThis.__donlyRequest`). Tampoco se escribe ningún archivo para el script.
- `curl` local recibe el cuerpo por stdin: no usa archivos.
- Las respuestas de los comandos (stdout / stderr) se leen en memoria y no se guardan, salvo en el
  `log_file`.
- La contraseña de `ssh_pass` no se escribe en disco ni en la línea de comandos: viaja en la variable de
  entorno `DONLY_SSH_PASSWORD` del proceso `ssh`. Sí está en claro en el `manifest.donly`.
- No hay caché de peticiones ni de respuestas.

**En memoria**

- **Proceso del proxy.** El cuerpo de cada petición y de cada respuesta se mantiene completo en
  memoria (`Buffer`) mientras dura la petición; con `node` remoto también el texto del programa (con la
  petición en base64). No hay una copia guardada: al responder quedan sin referencias y las libera el
  recolector de basura, pero **no se sobrescriben** (puede tardar y pueden aparecer en un volcado de
  memoria). Contraseñas y rutas del manifest viven todo el tiempo de ejecución, porque el manifest se
  lee una vez al arrancar.
- **Proceso hijo.** Cada petición lanza un proceso nuevo (`curl`, `node`, `ssh`, `kubectl`) que muere al
  terminar: lo que tenía en memoria, incluida `__donlyRequest`, desaparece con él. No hay procesos ni
  sesiones persistentes que conserven datos entre peticiones.
- **Fuera de este proyecto.** `ssh`, `kubectl`, `curl` o `node` pueden escribir sus propios archivos
  (`known_hosts`, cachés de `kubectl`, historial, registros del host remoto…); eso depende de su
  configuración y `donly-proxy` no lo controla.

## Buenas prácticas para usuarios

- Descarga el bundle solo desde las releases oficiales del repositorio.
- Mantén `host` en `127.0.0.1`. No expongas el proxy a redes no confiables sin autenticación ni restricciones de acceso.
- Usa solo manifests en los que confíes: pueden ejecutar comandos.
- No guardes secretos en `manifest.donly` versionado.
- Protege o rota los archivos de `log_file`, y no los subas al repositorio.
- No instales el certificado autofirmado como CA del sistema ni desactives la verificación TLS fuera de pruebas locales.
