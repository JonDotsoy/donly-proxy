# Pruebas empíricas (`empirical/`)

Las pruebas empíricas ejecutan los programas **reales** (`kubectl`, `ssh`, `curl`, `wget`, `node`) y guardan lo que pasó, para construir y validar con datos reales los CLI falsos (`docs/fake-cli.md`). La pieza central es `Scenario`.

## Scenario

```ts
const scenario = await Scenario.run({
  name: "node-public-ip",     // nombre del escenario (su carpeta en disco)
  wrap: ["node", "curl"],     // programas que se graban
  env: { LANG: "C" },         // variables extra para el bash (un PATH aquí reemplaza al heredado)
  script: `node --version; curl --version`,
});
scenario.sessions[0].program;  // "node"
scenario.sessions[0].entries;  // SessionEntry[]
```

`Scenario.run` abre `bash -c <script>` con el `PATH` cambiado: un *wrapper* por cada programa de `wrap` va primero. Cada vez que el script (o un programa que este lance) ejecuta uno de ellos, el wrapper (`empirical/recorder.ts`) corre el programa real con el módulo `spawn`, deja pasar stdin, stdout y stderr sin tocarlos y escribe una **sesión** propia. `Scenario.load(name)` lee un escenario ya grabado.

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
- Un programa fuera de `wrap`, o una ruta absoluta, no se graba.

## Cómo se prueba

- `empirical/scenario.test.ts` corre con `bun test` (y en CI) con programas falsos, sin red: una llamada, orden, paralelo, anidado, códigos de salida, grabar una sola vez, tiempo agotado, y un escenario con el propio proxy (`command_pass curl`) cuyo `curl` queda grabado junto al del script.
- `bun run empirical` ejecuta `empirical/scenarios.empirical.ts`: graba una sola vez los escenarios reales (`--version`, clúster inalcanzable, `command_pass` con `curl` y `node` pidiendo `api.ipify.org` por el proxy…). Se salta lo que no existe en la máquina; los de `ssh_pass` y `kubectl_pass` piden `DONLY_E2E_SSH=usuario@host` (y `DONLY_E2E_SSH_ARGS`) o `DONLY_E2E_KUBECTL_POD=pod/nombre` (y `DONLY_E2E_KUBECTL_ARGS`).
- Los escenarios `manifest-*` traen la IP pública de quien los grabó y están en `.gitignore`; los de `--version` sí se versionan.
