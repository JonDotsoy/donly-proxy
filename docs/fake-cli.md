# CLI falsos de `kubectl` y `ssh`

Los tests de `kubectl_pass`, `ssh_pass` y `command_pass kubectl|ssh` no necesitan un clúster ni
una red: `createFakeCli` (`src/utils/test_utils/fake-cli/fake-cli.ts`) escribe binarios `kubectl` y
`ssh` de mentira y los pone al inicio del `PATH`. Lo que el programa real ejecutaría en remoto
(`kubectl exec … -- cmd`, `ssh … cmd`) se ejecuta en local.

```ts
const fake = createFakeCli(dir);
beforeAll(() => fake.install());   // PATH con los falsos + NO_PROXY vacío
afterAll(() => fake.uninstall());
beforeEach(() => fake.reset());    // olvida las llamadas registradas
```

- `fake.args("kubectl")` / `fake.args("kubectl", "get")` / `fake.args("ssh")`: argumentos de la última llamada.
- `fake.stdin(programa)`: lo que leyó por stdin la última llamada `exec` (o `ssh`) antes de ejecutar el comando remoto, que luego recibe ese mismo stdin. Sirve para comprobar el cuerpo que viaja hasta el `curl` anidado. Cada llamada guarda su entrada en un archivo propio, así que llamadas concurrentes con cuerpos distintos no se mezclan. `kubectl exec` solo lee stdin con `-i`, `--stdin` o un grupo de flags con `i` (`-it`); sin eso `stdin()` queda vacío. Si responde la cola o `FAKE_CLI_STDOUT`, el stdin se descarta y `stdin()` no cambia.
- `fake.count(programa, sub?)`: cuántas veces se llamó desde el último `reset`.
- `fake.next(programa, { stdout, stderr, exit }, sub?)` encola la respuesta de la **siguiente** llamada
  ("el próximo stdout debe ser X"). El estado se comparte en archivos entre el test y el binario falso
  (un directorio por respuesta, que el binario toma con un `mv` atómico), así que sirve también con
  llamadas concurrentes: una respuesta por llamada, en el orden en que se encolaron; con la cola
  vacía vuelve el comportamiento normal. `fake.pending(programa, sub?)` cuenta las que nadie consumió.
  `sub` es `"get"` para `kubectl get pods`.
- `withEnv({ ... }, fn)` fija variables que guionan la respuesta:

| Variable | Efecto |
| --- | --- |
| `FAKE_CLI_EXIT`, `FAKE_CLI_STDERR` | `kubectl exec` y `ssh` fallan con ese código y mensaje (`FAKE_CLI_STDERR` sin `FAKE_CLI_EXIT` se ignora). `kubectl get` no las lee: usa `FAKE_KUBECTL_GET_EXIT` y `FAKE_KUBECTL_PODS`. |
| `FAKE_CLI_STDOUT` | `kubectl exec` y `ssh` imprimen ese texto en lugar de ejecutar el comando remoto (`kubectl get` no la lee). |
| `FAKE_KUBECTL_PODS` | Lo que lista `kubectl get pods -o name` (por defecto tres pods). |
| `FAKE_KUBECTL_GET_EXIT` | Solo `kubectl get` falla. |

Como todo proceso pasa por `src/spawn/`, los tests también comprueban `command_start`/`command_end`
en el log `.ndjson`. La suite está en `src/proxy/tunnel/fake-cli.test.ts`.

`kubectl --version`/`version` y `ssh -V`/`--version` responden como los reales y no cuentan como llamadas ni pisan los argumentos registrados. `next("ssh", …, "get")` no compila: `get` solo existe en `kubectl`.
