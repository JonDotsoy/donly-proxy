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
scenario.sessions[0].lines;    // líneas del registro de binrec (command, stdin/stdout/stderr, end)
```

`Scenario.run` abre `bash -c <script>` con el `PATH` cambiado: un *shim* de [`@jondotsoy/binrec`](https://www.npmjs.com/package/@jondotsoy/binrec) por cada programa de `wrap` va primero. Cada vez que el script (o un programa que este lance) ejecuta uno de ellos, binrec corre el programa real (el que hay en el `PATH` del escenario), deja pasar stdin, stdout y stderr sin tocarlos y escribe una **sesión** propia. `Scenario.load(name)` lee un escenario ya grabado.

### Archivos de entrada: `vfs`

```ts
import { vfs } from "../src/utils/test_utils/vfs/vfs";

const files = vfs.createTmp();                    // directorio temporal propio
files.writeFile(join(files.cwd(), "foo"), "hola"); // o files.writeFile("foo", "hola")
await Scenario.run({ name: "cat-foo", wrap: ["cat"], cwd: files, script: "cat foo" });
files.remove();                                   // también se borra al terminar el proceso
```

`writeFile` crea las carpetas que falten y acepta rutas absolutas o relativas a `cwd()`, siempre dentro del directorio (una ruta con `../` o ajena lanza un error); `readFile`, `exists` y `path(...)` completan la utilidad.

### En disco

```
empirical/__scenarios__/<nombre>/
  scenario.json                 # { id, timestamp, name, wrap, script, exit_code, sessions: [{ file, program, id, command, args, exit_code }] }
  records/<id>.ndjson           # una sesión por llamada (registro de binrec)
```

`sessions` va en el orden en que empezaron las llamadas. Cada línea de un `records/<id>.ndjson` es JSON, y `Scenario` exige que el registro sea válido (`validateSession`):

| `type` | Campos |
| --- | --- |
| `command` | `sessionId`, `command` (ruta del programa real), `args: string[]`, `pid`, `timestamp`, `performance` |
| `stdin`, `stdout`, `stderr` | `data` (texto) o `data: null` y `data_base64`, `size`, `timestamp`, `performance` |
| `signal` | `signal`, cuando binrec recibe `TERM`, `HUP`, `INT` o `QUIT` |
| `end` | `exitCode`, `total` |

`sessionText(lines, "stdin" | "stdout" | "stderr")` junta los trozos de un tipo y los decodifica una sola vez (un carácter puede quedar partido entre dos trozos).

- No hay vínculo entre una sesión y la que la lanzó: las sesiones de un escenario son las llamadas que hizo el script y los programas que este arrancó, ordenadas por inicio.
- **Una sola vez:** si la carpeta del escenario existe, `Scenario.run` devuelve lo grabado sin ejecutar nada; `force: true` lo graba de nuevo.
- Todo se graba en una carpeta temporal y se renombra al final tras validar cada sesión: si el escenario falla o supera `timeoutMs`, no queda nada. De la carpeta solo se conservan `scenario.json` y `records/` (sin los shims, la configuración ni los `*.stats.json` de binrec).
- Límites conocidos: si un timeout mata el bash, sus hijos (shims y programas) pueden seguir vivos unos segundos; un programa en segundo plano que sobreviva al script se pierde sin error; los shims usan la ruta de `bun`, que no puede tener espacios. `wget` solo corre como `command_pass` remoto (`ssh_pass`/`kubectl_pass`), así que no hay escenario local con él.
- Un programa fuera de `wrap`, o una ruta absoluta, no se graba. Un programa de `wrap` que no está en el `PATH` del escenario, o un `name` que no sea un nombre simple (letras, dígitos, `_`, `-`, `.`), hace fallar `Scenario.run` antes de ejecutar nada.
- Con `force`, el escenario anterior se conserva si la nueva grabación falla.
- Si binrec recibe una señal (`TERM`, `HUP`), se la pasa al programa real y cierra la sesión con su código de salida (por ejemplo 143). Si lo matan con `KILL`, queda una sesión sin `end` y `Scenario.run` falla.
- Límite de binrec 0.0.5: sale sin esperar a que se vacíe lo que escribió a un pipe, así que `prog | wc -c` puede recibir menos de lo que quedó grabado (se vio en ~2 de 30 ejecuciones con 3 MB). El registro sí queda completo.

## Cómo se prueba

- `empirical/scenario.test.ts` corre con `bun test` (y en CI) con programas falsos, sin red: una llamada, orden, paralelo, llamadas anidadas, códigos de salida, grabar una sola vez, tiempo agotado, y escenarios con el propio proxy (`command_pass curl`): un GET, un POST cuyo cuerpo queda grabado como `stdin` del `curl`, y una petición HTTPS por un túnel `CONNECT`. En todos, el `curl` del proxy queda grabado y el cliente es el `curl` real (por su ruta absoluta), que no se graba.
- `bun run empirical` ejecuta `empirical/scenarios.empirical.ts`: graba una sola vez los escenarios reales (`--version`, clúster inalcanzable, `command_pass` con `curl` y `node` pidiendo `api.ipify.org` por el proxy, un POST con cuerpo, HTTPS por `CONNECT` y un 404, contra `api.ipify.org` y `postman-echo.com`…). Se salta lo que no existe en la máquina; los de `ssh_pass` y `kubectl_pass` piden `DONLY_E2E_SSH=usuario@host` (y `DONLY_E2E_SSH_ARGS`) o `DONLY_E2E_KUBECTL_POD=pod/nombre` (y `DONLY_E2E_KUBECTL_ARGS`).
- Los escenarios `manifest-*`, `kubectl-*` y `ssh-*` traen la IP pública, rutas o hosts de quien los grabó y están en `.gitignore`; los de `--version` de `curl`, `wget` y `node` sí se versionan.
- El proxy de los escenarios escucha en `port 0` y el script lee el puerto real de su primera línea de log (`empirical/proxy-script.ts`), sin reservar puertos de antemano.
