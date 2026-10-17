# Pruebas empíricas (`empirical/`)

Las pruebas empíricas ejecutan los programas **reales** (`kubectl`, `ssh`, `curl`, `wget`, `node`) y guardan lo que pasó, para construir y validar con datos reales los CLI falsos (`docs/fake-cli.md`). La pieza central es `Scenario`.

## Scenario

```ts
const scenario = await Scenario.run({
  name: "node-public-ip",     // nombre del escenario (su carpeta en disco)
  wrap: ["node", "curl"],     // programas que se graban
  cwd: files,                 // carpeta donde arranca el bash: una ruta o un vfs
  env: { LANG: "C" },         // variables extra para el bash (un PATH aquí reemplaza al heredado)
  script: `node --version; curl --version`,
});
scenario.sessions[0].program;  // "node"
scenario.sessions[0].entries;  // SessionEntry[]
```

`Scenario.run` abre `bash -c <script>` con el `PATH` cambiado: un *wrapper* por cada programa de `wrap` va primero. Cada vez que el script (o un programa que este lance) ejecuta uno de ellos, el wrapper (`empirical/recorder.ts`) corre el programa real con el módulo `spawn`, deja pasar stdin, stdout y stderr sin tocarlos y escribe una **sesión** propia. `Scenario.load(name)` lee un escenario ya grabado.

### Archivos de entrada: `vfs`

```ts
import { vfs } from "../src/utils/test_utils/vfs/vfs";

const files = vfs.createTmp();                    // directorio temporal propio
files.writeFile(join(files.cwd(), "foo"), "hola"); // o files.writeFile("foo", "hola")
await Scenario.run({ name: "cat-foo", wrap: ["cat"], cwd: files, script: "cat foo" });
files.remove();                                   // también se borra al terminar el proceso
```

`writeFile` crea las carpetas que falten y acepta rutas absolutas o relativas a `cwd()`, siempre dentro del directorio (una ruta con `../` o ajena lanza un error); `readFile`, `exists` y `path(...)` completan la utilidad.

### Cómo se vinculan las sesiones

El vínculo viaja por variables de entorno, que heredan el bash y todos sus hijos:

| Variable | Para qué |
| --- | --- |
| `DONLY_SCENARIO_ID`, `DONLY_SCENARIO_NAME` | A qué escenario pertenece cada sesión. |
| `DONLY_SCENARIO_DIR` | Dónde escribir las sesiones. |
| `DONLY_SCENARIO_T0` | Origen común (ms epoch) de `elapse_nanosecond`: las sesiones se pueden ordenar entre sí. |
| `DONLY_SCENARIO_BIN` | Carpeta de wrappers, que se salta al buscar el programa real. |
| `DONLY_PARENT_SESSION` | Sesión del programa envuelto que lanzó este; cada wrapper lo fija para su hijo. |

El número de cada sesión (`NNNN`) se reserva con una creación exclusiva de archivo, así que las llamadas en paralelo nunca comparten nombre.

### En disco

```
empirical/__scenarios__/<nombre>/
  scenario.json            # { id, timestamp, name, wrap, script, exit_code, sessions: [{ file, program, id, parent_session_id, exit_code }] }
  0001-node.session.json   # una sesión por llamada, en el orden en que empezaron
  0002-curl.session.json
```

Cada `*.session.json` es un arreglo de `{ elapse_nanosecond, type, ... }`, donde `elapse_nanosecond` son los nanosegundos desde que empezó el escenario (API `performance`) y `type` es `session` (abre el archivo: `id`, `timestamp` ISO, `name` del escenario, `scenario_id` y `parent_session_id`, que es `null` si lo lanzó el script), `command` (`command` y `args: string[]`), `stdin`, `stdout` o `stderr` (con `chunk`) y `end` (con `exit_code`).

- `parent_session_id` apunta al programa **envuelto** más cercano: un `curl` que lanza un `node` envuelto cuelga de él; uno lanzado por un proceso sin wrapper (el proxy, por ejemplo) cuelga de quien lo lanzó antes, o de `null`.
- **Una sola vez:** si la carpeta del escenario existe, `Scenario.run` devuelve lo grabado sin ejecutar nada; `force: true` lo graba de nuevo.
- Todo se graba en una carpeta temporal y se renombra al final tras validar cada sesión: si el escenario falla o supera `timeoutMs`, no queda nada.
- Límites conocidos: si un timeout mata el bash, sus hijos (wrappers y programas) pueden seguir vivos unos segundos; un wrapper en segundo plano que sobreviva al script se pierde sin error; el shebang de los wrappers usa la ruta de `bun`, que no puede tener espacios. `wget` solo corre como `command_pass` remoto (`ssh_pass`/`kubectl_pass`), así que no hay escenario local con él.
- Un programa fuera de `wrap`, o una ruta absoluta, no se graba. Un programa de `wrap` que no está en el `PATH` del escenario, o un `name` que no sea un nombre simple (letras, dígitos, `_`, `-`, `.`), hace fallar `Scenario.run` antes de ejecutar nada.
- Con `force`, el escenario anterior se conserva si la nueva grabación falla.
- Si el wrapper recibe una señal (`TERM`, `INT`, `HUP`), se la pasa al programa real y cierra la sesión con su código de salida (por ejemplo 143). Si lo matan con `KILL`, queda una sesión sin `end` y `Scenario.run` falla.
- Cada trozo se entrega por stdout/stderr antes de salir, así que un pipe recibe la salida completa.

## Cómo se prueba

- `empirical/scenario.test.ts` corre con `bun test` (y en CI) con programas falsos, sin red: una llamada, orden, paralelo, anidado, códigos de salida, grabar una sola vez, tiempo agotado, y escenarios con el propio proxy (`command_pass curl`): un GET, un POST cuyo cuerpo queda grabado como `stdin` del `curl`, y una petición HTTPS por un túnel `CONNECT`. En todos, el `curl` del proxy queda grabado y el cliente es el `curl` real (por su ruta absoluta), que no se graba.
- `bun run empirical` ejecuta `empirical/scenarios.empirical.ts`: graba una sola vez los escenarios reales (`--version`, clúster inalcanzable, `command_pass` con `curl` y `node` pidiendo `api.ipify.org` por el proxy, un POST con cuerpo, HTTPS por `CONNECT` y un 404, contra `api.ipify.org` y `postman-echo.com`…). Se salta lo que no existe en la máquina; los de `ssh_pass` y `kubectl_pass` piden `DONLY_E2E_SSH=usuario@host` (y `DONLY_E2E_SSH_ARGS`) o `DONLY_E2E_KUBECTL_POD=pod/nombre` (y `DONLY_E2E_KUBECTL_ARGS`).
- Los escenarios `manifest-*`, `kubectl-*` y `ssh-*` traen la IP pública, rutas o hosts de quien los grabó y están en `.gitignore`; los de `--version` de `curl`, `wget` y `node` sí se versionan.
- El proxy de los escenarios escucha en `port 0` y el script lee el puerto real de su primera línea de log (`empirical/proxy-script.ts`), sin reservar puertos de antemano.
