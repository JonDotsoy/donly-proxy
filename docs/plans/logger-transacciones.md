# Plan: Logger con transacciones anidadas

> Estado: **propuesta** (solo plan, sin cambios de código). Base: `develop` en `v0.0.12`.

## 1. Situación actual

No existe un `Logger`. El log es un cierre `log` dentro de `createProxyServer` (`src/proxy/server.ts:425`) que añade `timestamp` y `performance_timestamp` y escribe una línea en el `.ndjson`. Hay tres piezas mezcladas:

- `handle` crea un objeto `transaction` (`transaction_id`, `http_version`, `method`, `url`) y lo esparce en cada línea (`request`, líneas de comando, `response`).
- `commandPass` (`server.ts:337`) traduce los callbacks de los túneles (`onCommand`, `onScript`, `onConsole`, `onExit`) en líneas `command`, `script`, `command_exit` y `script_exit`.
- Los túneles (`src/proxy/tunnel/**`, `run.ts`) solo llaman callbacks; no saben nada del log.

Consecuencias que motivan el cambio:

- El orden y la relación padre/hijo (`kubectl exec` → `node` → script) solo se deduce por posición en el archivo. Con `kubectl` se emiten **dos** `command_exit` idénticos (mismo `exit_code` y `console_log`).
- `console_log` no lleva `timestamp` por entrada (`ConsoleEntry` en `tunnel/types.ts` es `{ type, message }`).
- No hay forma de adjuntar datos propios a una transacción (anotaciones).
- La UI (`src/ui/index.html`) pinta cada línea plana, sin jerarquía.

## 2. API propuesta

Módulo nuevo `src/proxy/logger/` (`logger.ts`, `types.ts`, `index.ts`). Se mantiene la sintaxis pedida:

```ts
const logger = Logger.request.openTransaction(request);

logger.annotation({ foo: "tar" });

const kubectlLogger = logger.command.openTransaction({ program: "kubectl", args: ["exec", "..."] });
const nodeLogger = kubectlLogger.command.openTransaction({ program: "node", args: ["--input-type=module", "-"] });
nodeLogger.script.openTransaction({ script: "…" });
nodeLogger.end(0, logs);
kubectlLogger.end(0, logs);
```

### Tipos

```ts
export interface ConsoleLogEntry {
  type: "stdout" | "stderr" | "stdin";
  timestamp: string;          // ISO 8601, nuevo (hoy no existe)
  message: string;
}

export interface RequestInfo {          // lo que ya sale en `request`
  method: string;
  url: string;
  httpVersion: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface CommandInfo { program: string; args: string[] }

/** Una transacción abierta: emite líneas con sus ids y puede abrir hijas. */
export interface Transaction {
  readonly transactionId: string;       // raíz, compartido por todo el árbol
  readonly spanId: string;              // propio de esta transacción
  annotation(data: Record<string, unknown>): void;
  readonly command: { openTransaction(info: CommandInfo): CommandTransaction };
  end(exitCode: number | null, logs: ConsoleLogEntry[]): void;
}

export interface RequestTransaction extends Omit<Transaction, "end"> {
  response(reply: { status: number; headers: …; body: Buffer; command?: string[] }): void;
}

export interface CommandTransaction extends Transaction {
  readonly script: { openTransaction(info: { script: string }): void };
}

export interface Logger {
  readonly request: { openTransaction(request: RequestInfo): RequestTransaction };
  listening(host: string, port: number): void;
}

export const createLogger = (logFile?: string): Logger;
```

Notas de diseño:

- `Logger.request` y `end` aceptan `null` como código (señal), igual que hoy.
- `script.openTransaction` no devuelve una transacción: un script no tiene hijos ni final propio; su cierre es el `end` del comando `node` que lo ejecutó (igual que en el ejemplo pedido).
- Sin `log_file`, `createLogger()` devuelve un logger no-op con la misma forma; el servidor no necesita `if (logFile)`.
- `end` es idempotente (segunda llamada se ignora) y `Logger` guarda las transacciones abiertas sin cerrar para poder cerrarlas al terminar la petición (ver §6).

## 3. Líneas `.ndjson` por llamada

Campos comunes de siempre: `timestamp`, `performance_timestamp`, `type`. Campos de transacción (los ya existentes, más dos nuevos): `transaction_id`, `http_version`, `method`, `url`, **`span_id`** y **`parent_span_id`** (este último ausente en la raíz).

| Llamada | Línea generada |
| --- | --- |
| `Logger.request.openTransaction(req)` | `{ …comunes, type: "request", span_id, headers, payload, payload_encoding? }` (igual que hoy + `span_id`) |
| `.annotation(data)` | `{ …comunes, type: "request_annotation", span_id, annotation: data }` |
| `.command.openTransaction({program,args})` | `{ …comunes, type: "command", span_id, parent_span_id, program, args, command: [program, ...args] }` |
| `.script.openTransaction({script})` | `{ …comunes, type: "script", span_id, parent_span_id, program: "node", script }` (`parent_span_id` = span del comando `node`) |
| `.end(code, logs)` en un comando | `{ …comunes, type: "command_exit", span_id, parent_span_id, program, exit_code, console_log }` |
| `.response(reply)` | `{ …comunes, type: "response", span_id, status, headers, payload, command? }` (igual que hoy) |

- `annotation` en un comando lleva el mismo `type: "request_annotation"` en la raíz; en hijos se propone `type: "annotation"` con el mismo cuerpo. Ver duda D4.
- `command` se conserva (lista completa) además de `program` y `args`, para no romper `response.command`, tests ni la UI actuales.
- `script_exit`: si el comando tuvo `script`, `end` emite además `script_exit` justo después de `command_exit` (compatibilidad, ver D3).

### Ejemplo (`kubectl_pass` con motor `node`)

```jsonc
{"type":"request","transaction_id":"T","span_id":"A", …}
{"type":"request_annotation","transaction_id":"T","span_id":"A","annotation":{"route":"^https://api"}}
{"type":"command","transaction_id":"T","span_id":"B","parent_span_id":"A","program":"kubectl","args":["exec","-i","deploy/api","--","node","--input-type=module","-"], …}
{"type":"command","transaction_id":"T","span_id":"C","parent_span_id":"B","program":"node","args":["--input-type=module","-"], …}
{"type":"script","transaction_id":"T","span_id":"D","parent_span_id":"C","program":"node","script":"…"}
{"type":"command_exit","transaction_id":"T","span_id":"C","parent_span_id":"B","program":"node","exit_code":0,"console_log":[…]}
{"type":"script_exit","transaction_id":"T","span_id":"C","parent_span_id":"B","program":"node","exit_code":0,"console_log":[…]}
{"type":"command_exit","transaction_id":"T","span_id":"B","parent_span_id":"A","program":"kubectl","exit_code":0,"console_log":[…]}
{"type":"response","transaction_id":"T","span_id":"A","status":200, …}
```

## 4. Relación padre/hijo

Hoy `transaction_id` es el UUID de la **petición** y lo comparten todas sus líneas; la UI y los tests dependen de eso. Se **conserva** con ese significado y se añade el árbol aparte:

- `transaction_id`: raíz (la petición). Sin cambios.
- `span_id`: UUID de cada transacción abierta (`request`, cada `command`). El `script` usa un id propio (es una línea más) y apunta al comando.
- `parent_span_id`: `span_id` de quien la abrió. La raíz no lo lleva.
- `end` reutiliza el `span_id` de su comando, así `command` y `command_exit` se emparejan sin adivinar por posición.

Orden garantizado por el logger: un hijo siempre se cierra antes que su padre (`end` de un padre con hijos abiertos los cierra primero con `exit_code: null` y `console_log: []`, para no dejar árboles abiertos si el proceso muere).

## 5. Migración de los usos actuales

Los túneles **no** cambian de interfaz: `run.ts` y los motores siguen exponiendo callbacks (`onCommand`, `onScript`, `onConsole`, `onExit`), que son el borde de E/S. Solo cambia quién los traduce:

| Hoy | Después |
| --- | --- |
| `log({ ...transaction, type: "request", … })` en `handle` | `const logger = Logger.request.openTransaction(...)` |
| `emit` pasado a `answer`/`commandPass` | se pasa `logger` (o su `Transaction`) |
| `onCommand` emite `command` y, con `kubectl`, un segundo `command` del motor | `onCommand` abre `logger.command.openTransaction(...)`; con `kubectl` abre el hijo con `kubectlLogger.command.openTransaction(...)` |
| `onScript` guarda el script y `onCommand` emite `script` | `onScript` llama `nodeLogger.script.openTransaction(...)` (en la transacción del `node`) |
| `onConsole` acumula `consoleLog` | igual, pero `run.ts` añade `timestamp` a cada `ConsoleEntry` |
| `onExit` emite `command_exit` (×2 en kubectl) y `script_exit` | `onExit` llama `end(code, consoleLog)` en el hijo y luego en el padre |
| `log({ type: "response", … })` | `logger.response(reply)` |
| `log({ type: "listening", … })` | `logger.listening(host, port)` |

Casos por motor:

- **curl / wget**: `request` → `command(curl)` → `end`.
- **node local**: `command(node)` + `script` → `end`.
- **ssh**: `command(ssh …)` (el comando remoto va dentro de `args`, como hoy). Sin hijo, salvo que se decida modelar el motor remoto (D2).
- **kubectl**: padre `kubectl exec`, hijo con el motor (`curl`/`node`); el hijo lleva el `script` si es `node`.
- **proxy_pass / respond**: solo `request` (+ anotaciones) y `response`.

Anotaciones iniciales sugeridas (opcionales, no se emiten hoy): ruta que coincidió (`route`, patrón) y espera por el semáforo de `concurrency` (`queued_ms`). Se incluyen solo si se acepta D5.

## 6. Compatibilidad

- **Campos existentes**: se conservan todos (`transaction_id`, `command`, `payload`, `exit_code`, `console_log`, `script_exit`). Lo nuevo es aditivo: `span_id`, `parent_span_id`, `program`/`args` separados, `timestamp` por entrada de `console_log` y `request_annotation`.
- **Cambio de comportamiento (único)**: con `kubectl` ya no hay dos `command_exit` idénticos; cada transacción cierra con su propio `console_log` (el del padre trae el tráfico de `kubectl`, el del hijo el del motor). Hoy ambos traen lo mismo. Recomendación en D1.
- **Archivos antiguos**: un `.ndjson` sin `span_id` sigue siendo válido; la UI debe tratarlo como lista plana.
- **`docs/log-format.md`**: documentar `span_id`, `parent_span_id`, `request_annotation`, el `timestamp` de `console_log` y el nuevo orden de cierre.

### UI (`--ui`)

`src/ui/server.ts` solo reenvía líneas; no cambia. En `index.html`:

1. Tipos nuevos: `request_annotation` con su color y `annotation` en el detalle.
2. Sangría por profundidad usando `span_id`/`parent_span_id` (profundidad = pasos hasta la raíz; sin ids, 0).
3. `command_exit` muestra `program` y `exit_code` en la columna de estado.
4. Las líneas `script`/`command` hoy muestran `method url`; pasar a `program args`.

La agrupación por `transaction_id` plegable queda fuera de este plan.

## 7. Estrategia de tests

Cada comportamiento nuevo entra con `testFeature(payload, paths, "should …", fn)`, sin prefijos `[id]` y con puertos dinámicos. Rutas de feature nuevas: `/proxy/log_file/transactions` y `/proxy/log_file/annotation`.

1. **Unit de `createLogger`** (archivo temporal, sin servidor): `request.openTransaction` escribe `request` con `span_id`; `annotation` genera `request_annotation`; `command.openTransaction` anida `parent_span_id`; `script` cuelga del comando; `end` es idempotente; cerrar un padre cierra los hijos abiertos; sin `log_file` es no-op.
2. **Servidor** (extender `log-command.test.ts`, `log-script.test.ts`): líneas con `span_id`/`parent_span_id` correctos para curl, node, ssh y kubectl falso (script al inicio del `PATH`); un solo `command_exit` por transacción; `console_log` con `timestamp`.
3. **No regresión**: los tests y snapshots actuales (`log-*.test.ts`, `console-log.test.ts`, `kubectl.test.ts`, `two-pods`) pasan sin tocar, salvo los que cuentan los dos `command_exit` de kubectl.
4. **UI**: test de que el HTML contiene el manejo de `request_annotation`; sin Playwright.
5. **Seguridad** (`SECURITY.md`): test `no-shell-injection` no se ve afectado; añadir uno de que `annotation` no recibe cabeceras ni la contraseña de `ssh_pass`.

Antes de abrir el PR de implementación: `bun test` y `bun run features` (regenera `docs/system/features.md`), y `bun run features:check`.

## 8. Pasos de implementación (en orden)

1. Tests unitarios del logger en rojo (`src/proxy/logger/logger.test.ts`).
2. Crear `src/proxy/logger/` con `createLogger`, tipos y el logger no-op; pasa el punto 1.
3. `run.ts` y `ConsoleEntry`: añadir `timestamp`; ajustar los tests que comparan `console_log` exacto.
4. Reemplazar `log` en `createProxyServer` por `createLogger(logFile)`: `request`, `response` y `listening` (sin cambio de salida salvo `span_id`).
5. Migrar `commandPass` a transacciones (curl/wget/node primero, luego ssh y kubectl con hijo). Quitar `script_exit` duplicado solo si D3 lo decide.
6. Anotaciones iniciales (D5), si se aprueban.
7. UI: sangría, `request_annotation`, columnas de comando.
8. Docs: `log-format.md`, `manifest.md` si cambia algo observable, `concepts/command_pass.md`, `kubectl_pass.md`.
9. `bun run features`, `bun test`, `bun run features:check`; PR con título `feat: logger con transacciones anidadas`.

## 9. Dudas abiertas

| # | Duda | Recomendación |
| --- | --- | --- |
| D1 | Con `kubectl`, ¿un `command_exit` por transacción (cada uno con su `console_log`) o mantener los dos idénticos de hoy? | **Uno por transacción.** El árbol ya expresa la relación; el duplicado solo existe porque no había ids. Se avisa en `log-format.md`. |
| D2 | ¿Modelar el motor remoto de `ssh` como transacción hija (como `kubectl`)? | **No por ahora**: el remoto va dentro de `args` y no hay segundo proceso local. Se puede añadir sin romper nada. |
| D3 | ¿Conservar `script_exit` además de `command_exit`? | **Sí en esta entrega**, marcado como obsoleto en docs; retirarlo en el siguiente minor. |
| D4 | `annotation` en una transacción hija: ¿`type: "annotation"` o siempre `request_annotation`? | **`request_annotation` solo en la raíz y `annotation` en hijos**, así el nombre no miente. |
| D5 | ¿Emitir anotaciones automáticas (ruta que coincidió, espera de `concurrency`)? | **Sí, solo `route`** (patrón y método). La espera se deja para otra iteración. |
| D6 | `Logger` ¿estático global (`Logger.request…`) o instancia por servidor? | **Instancia por servidor** (`createLogger(logFile)`) con la misma forma `logger.request.openTransaction`. Varios servidores con distinto `log_file` conviven en el mismo proceso (los tests lo hacen); un global los mezclaría. Si prefieres `Logger.request…` literal, se exporta `Logger` como el logger por defecto configurado en `main.ts`. |
| D7 | `transaction_id`: ¿se queda como id de la petición o pasa a ser el de cada transacción? | **Se queda como id de la petición** (compatibilidad con UI y tests); el id propio es `span_id`. |
| D8 | `end(exitCode, logs)` ¿recibe los logs o el logger los acumula? | **Recibe los logs, como en tu ejemplo.** Quien ejecuta el proceso (`commandPass`) ya los acumula con `onConsole`. |
