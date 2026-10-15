# Plan: Logger con transacciones anidadas

> Estado: **propuesta** (solo plan, sin cambios de código). Base: `develop` en `v0.0.12`.

## 1. Situación actual

No existe un `Logger`. El log es un cierre `log` dentro de `createProxyServer` (`src/proxy/server.ts:425`) que añade `timestamp` y `performance_timestamp` y escribe una línea en el `.ndjson`. Hay tres piezas mezcladas:

- `handle` crea un objeto `transaction` (`transaction_id`, `http_version`, `method`, `url`) y lo esparce en cada línea (`request`, líneas de comando, `response`).
- `commandPass` (`server.ts:337`) traduce los callbacks de los túneles (`onCommand`, `onScript`, `onConsole`, `onExit`) en líneas `command`, `script`, `command_exit` y `script_exit` (nombres actuales).
- Los túneles (`src/proxy/tunnel/**`, `run.ts`) solo llaman callbacks; no saben nada del log.

Consecuencias que motivan el cambio:

- El orden y la relación padre/hijo (`kubectl exec` → `node` → script) solo se deduce por posición en el archivo. Con `kubectl` se emiten **dos** `command_exit` idénticos (mismo `exit_code` y `console_log`).
- `console_log` no lleva `timestamp` por entrada (`ConsoleEntry` en `tunnel/types.ts` es `{ type, message }`).
- No hay forma de adjuntar datos propios a una transacción (anotaciones).
- La UI (`src/ui/index.html`) pinta cada línea plana, sin jerarquía.

## 2. API propuesta

Módulo nuevo `src/proxy/logger/`; la función se llama `createLogger_experimental` mientras no esté conectada al servidor. El sistema crea el logger sobre un `WritableStream<Uint8Array>` que recibe las líneas `.ndjson` (un JSON por línea, utf8): `const Logger = createLogger_experimental(writable)`. Se mantiene la sintaxis pedida:

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
  readonly proxyPass: { openTransaction(info: { method: string; target: string; headers: Record<string, string>; body: Buffer }): ProxyPassTransaction };
  response(reply: { status: number; headers: …; body: Buffer; command?: string[] }): void;
}

/** La petición que el proxy envía al destino de un `proxy_pass` y lo que este responde. */
export interface ProxyPassTransaction {
  readonly spanId: string;
  end(reply: { status: number; headers: Record<string, string | string[]>; body: Buffer }): void;
}

export interface CommandTransaction extends Transaction {
  readonly script: { openTransaction(info: { script: string }): void };
}

export interface Logger {
  readonly request: { openTransaction(request: RequestInfo): RequestTransaction };
  listening(host: string, port: number): void;
}

// implementado como `createLogger_experimental(writable: WritableStream<Uint8Array>): Logger`
```

Notas de diseño:

- `Logger.request` y `end` aceptan `null` como código (señal), igual que hoy.
- `script.openTransaction` no devuelve una transacción: un script no tiene hijos ni final propio; su cierre es el `end` del comando `node` que lo ejecutó (igual que en el ejemplo pedido).
- El destino es el `writable`, no un archivo: el servidor lo arma una vez (con `log_file`: `Writable.toWeb(createWriteStream(logFile, { flags: "a" }))`, creando antes el directorio; sin `log_file`: un `WritableStream` que descarta) y no necesita `if (logFile)`. `Logger.flush()` espera a que el stream haya aceptado lo escrito; un stream que falla no tumba el proxy.
- `end` es idempotente (segunda llamada se ignora) y `Logger` guarda las transacciones abiertas sin cerrar para poder cerrarlas al terminar la petición (ver §6).

## 3. Líneas `.ndjson` por llamada

Campos comunes de siempre: `timestamp`, `performance_timestamp`, `type`. Campos de transacción (los ya existentes, más dos nuevos): `transaction_id`, `http_version`, `method`, `url`, **`span_id`** y **`parent_span_id`** (este último ausente en la raíz).

| Llamada | Línea generada |
| --- | --- |
| `Logger.request.openTransaction(req)` | `{ …comunes, type: "request", span_id, headers, payload, payload_encoding? }` (igual que hoy + `span_id`) |
| `.annotation(data)` | `{ …comunes, type: "request_annotation", span_id, annotation: data }` |
| `.command.openTransaction({program,args})` | `{ …comunes, type: "command_start", span_id, parent_span_id, program, args, command: [program, ...args] }` |
| `.script.openTransaction({script})` | `{ …comunes, type: "script", span_id, parent_span_id, program: "node", script }` (`parent_span_id` = span del comando `node`) |
| `.end(code, logs)` en un comando | `{ …comunes, type: "command_end", span_id, parent_span_id, program, exit_code, console_log }` |
| `.proxyPass.openTransaction({method,target,headers,body})` | `{ …comunes, type: "request_proxy_pass", span_id, parent_span_id, target, headers, payload, payload_encoding? }` (lo que se envía al destino) |
| `.end(reply)` en un `proxy_pass` | `{ …comunes, type: "response_proxy_pass", span_id, parent_span_id, target, status, headers, payload, payload_encoding? }` (mismo `span_id` que su `request_proxy_pass`) |
| `.response(reply)` | `{ …comunes, type: "response", span_id, status, headers, payload, command? }` (igual que hoy) |

- `annotation` en un comando lleva el mismo `type: "request_annotation"` en la raíz; en hijos se propone `type: "annotation"` con el mismo cuerpo. Ver duda D4.
- `command` se conserva (lista completa) además de `program` y `args`, para no romper `response.command`, tests ni la UI actuales.
- `script_exit`: si el comando tuvo `script`, `end` emite además `script_exit` justo después de `command_end` (compatibilidad, ver D3).

### Ejemplo (`kubectl_pass` con motor `node`)

```jsonc
{"type":"request","transaction_id":"T","span_id":"A", …}
{"type":"request_annotation","transaction_id":"T","span_id":"A","annotation":{"route":"^https://api"}}
{"type":"command_start","transaction_id":"T","span_id":"B","parent_span_id":"A","program":"kubectl","args":["exec","-i","deploy/api","--","node","--input-type=module","-"], …}
{"type":"command_start","transaction_id":"T","span_id":"C","parent_span_id":"B","program":"node","args":["--input-type=module","-"], …}
{"type":"script","transaction_id":"T","span_id":"D","parent_span_id":"C","program":"node","script":"…"}
{"type":"command_end","transaction_id":"T","span_id":"C","parent_span_id":"B","program":"node","exit_code":0,"console_log":[…]}
{"type":"script_exit","transaction_id":"T","span_id":"C","parent_span_id":"B","program":"node","exit_code":0,"console_log":[…]}
{"type":"command_end","transaction_id":"T","span_id":"B","parent_span_id":"A","program":"kubectl","exit_code":0,"console_log":[…]}
{"type":"response","transaction_id":"T","span_id":"A","status":200, …}
```

## 4. Relación padre/hijo

Hoy `transaction_id` es el UUID de la **petición** y lo comparten todas sus líneas; la UI y los tests dependen de eso. Se **conserva** con ese significado y se añade el árbol aparte:

- `transaction_id`: raíz (la petición). Sin cambios.
- `span_id`: UUID de cada transacción abierta (`request`, cada `command`). El `script` usa un id propio (es una línea más) y apunta al comando.
- `parent_span_id`: `span_id` de quien la abrió. La raíz no lo lleva.
- `end` reutiliza el `span_id` de su comando, así `command_start` y `command_end` se emparejan sin adivinar por posición.

Orden garantizado por el logger: un hijo siempre se cierra antes que su padre (`end` de un padre con hijos abiertos los cierra primero con `exit_code: null` y `console_log: []`, para no dejar árboles abiertos si el proceso muere).

## 5. Migración de los usos actuales

Los túneles **no** cambian de interfaz: `run.ts` y los motores siguen exponiendo callbacks (`onCommand`, `onScript`, `onConsole`, `onExit`), que son el borde de E/S. Solo cambia quién los traduce:

| Hoy | Después |
| --- | --- |
| `log({ ...transaction, type: "request", … })` en `handle` | `const logger = Logger.request.openTransaction(...)` |
| `emit` pasado a `answer`/`commandPass` | se pasa `logger` (o su `Transaction`) |
| `onCommand` emite `command` y, con `kubectl`, un segundo `command` del motor (un solo callback para dos procesos) | `onCommand` abre `logger.command.openTransaction(...)`; con `kubectl` abre el hijo con `kubectlLogger.command.openTransaction(...)` |
| `onScript` guarda el script y `onCommand` emite `script` | `onScript` llama `nodeLogger.script.openTransaction(...)` (en la transacción del `node`) |
| `onConsole` acumula `consoleLog` | igual, pero `run.ts` añade `timestamp` a cada `ConsoleEntry` |
| `onExit` emite `command_exit` (×2 en kubectl) y `script_exit` | `onExit` llama `end(code, consoleLog)` en el hijo y luego en el padre |
| `fetch` de `forward()` sin registro | `proxyPass.openTransaction(...)` antes del `fetch` y `end(reply)` al recibir la respuesta (o el 502) |
| `log({ type: "response", … })` | `logger.response(reply)` |
| `log({ type: "listening", … })` | `logger.listening(host, port)` |

Casos por motor:

- **curl / wget**: `request` → `command_start(curl)` → `command_end`.
- **node local**: `command_start(node)` + `script` → `command_end`.
- **ssh**: `command_start(ssh …)` (el comando remoto va dentro de `args`, como hoy). Sin hijo, salvo que se decida modelar el motor remoto (D2).
- **kubectl**: padre `kubectl exec`, hijo con el motor (`curl`/`node`); el hijo lleva el `script` si es `node`.
- **proxy_pass**: `request` → `request_proxy_pass` → `response_proxy_pass` → `response`. `forward()` abre la transacción con la petición que arma (método, URL destino con las reglas de ruta y query, cabeceras sin las hop-by-hop) y la cierra con lo que responde el destino; si el destino falla (502), se cierra con ese 502. El `response` al cliente se escribe después.
- **respond**: solo `request` (+ anotaciones) y `response`.

Anotaciones iniciales sugeridas (opcionales, no se emiten hoy): ruta que coincidió (`route`, patrón) y espera por el semáforo de `concurrency` (`queued_ms`). Se incluyen solo si se acepta D5.

## 6. Compatibilidad

- **Campos existentes**: se conservan todos (`transaction_id`, `command`, `payload`, `exit_code`, `console_log`, `script_exit`) salvo los tipos `command` y `command_exit`, que se renombran (ver D9). Lo demás es aditivo: `span_id`, `parent_span_id`, `program`/`args` separados, `timestamp` por entrada de `console_log` y `request_annotation`.
- **Cambio de comportamiento (único)**: con `kubectl` ya no hay dos `command_exit` idénticos: cada proceso emite su `command_start` y su `command_end`, y cada uno cierra con su propio `console_log` (el del padre trae el tráfico de `kubectl`, el del hijo el del motor). Hoy ambos traen lo mismo. Recomendación en D1.
- **Archivos antiguos**: un `.ndjson` sin `span_id` sigue siendo válido; la UI debe tratarlo como lista plana.
- **`docs/log-format.md`**: documentar `span_id`, `parent_span_id`, `request_annotation`, el `timestamp` de `console_log` y el nuevo orden de cierre.

### UI (`--ui`)

`src/ui/server.ts` solo reenvía líneas; no cambia. En `index.html`:

1. Tipos nuevos: `request_annotation` con su color y `annotation` en el detalle.
2. Sangría por profundidad usando `span_id`/`parent_span_id` (profundidad = pasos hasta la raíz; sin ids, 0).
3. `command_end` muestra `program` y `exit_code` en la columna de estado.
4. Las líneas `script`/`command` hoy muestran `method url`; pasar a `program args`; `command_start`/`command_end` comparten color.

La agrupación por `transaction_id` plegable queda fuera de este plan.

## 7. Estrategia de tests

Cada comportamiento nuevo entra con `testFeature(payload, paths, "should …", fn)`, sin prefijos `[id]` y con puertos dinámicos. Rutas de feature nuevas: `/proxy/log_file/transactions` y `/proxy/log_file/annotation`.

1. **Unit de `createLogger_experimental`** (hecho; stream en memoria, sin servidor): `request.openTransaction` escribe `request` con `span_id`; `annotation` genera `request_annotation`; `command.openTransaction` anida `parent_span_id`; `script` cuelga del comando; `end` es idempotente; cerrar un padre cierra los hijos abiertos; un stream que falla no lanza.
2. **Servidor** (extender `log-command.test.ts`, `log-script.test.ts`): líneas con `span_id`/`parent_span_id` correctos para curl, node, ssh y kubectl falso (script al inicio del `PATH`); un `command_start` y un `command_end` por proceso; `console_log` con `timestamp`.
   Ya está declarado el caso de `proxy_pass` en `src/proxy/log-proxy-pass-transactions.test.ts` (request → request proxy_pass → response proxy_pass → response), también con snapshot y `testFeature.skip`.
   Ya está declarado el caso de punta a punta en `src/proxy/log-transactions.test.ts` (request → kubectl → node → end node → end kubectl → response) con snapshot de todas las líneas, hoy con `testFeature.skip`: el paso 2 de implementación lo activa.
3. **No regresión**: los tests y snapshots actuales (`log-*.test.ts`, `console-log.test.ts`, `kubectl.test.ts`, `two-pods`) pasan sin tocar, salvo los que buscan los tipos `command`/`command_exit` o cuentan los dos `command_exit` de kubectl (ahora `command_end`).
4. **UI**: test de que el HTML contiene el manejo de `request_annotation`; sin Playwright.
5. **Seguridad** (`SECURITY.md`): test `no-shell-injection` no se ve afectado; añadir uno de que `annotation` no recibe cabeceras ni la contraseña de `ssh_pass`.

Antes de abrir el PR de implementación: `bun test` y `bun run features` (regenera `docs/system/features.md`), y `bun run features:check`.

## 8. Pasos de implementación (en orden)

1. Tests unitarios del logger en rojo (`src/proxy/logger/logger.test.ts`).
2. **Hecho en este PR:** módulo `src/proxy/logger/` con `createLogger_experimental(writable)` (mismas llamadas del §2) y sus tests unitarios. Aún no está conectado al servidor; al conectarlo se renombra a `createLogger`.
3. `run.ts` y `ConsoleEntry`: añadir `timestamp`; ajustar los tests que comparan `console_log` exacto.
4. Reemplazar `log` en `createProxyServer` por `createLogger(writable)` (el `writable` descrito en §2, renombrando desde `createLogger_experimental`): `request`, `response` y `listening` (sin cambio de salida salvo `span_id`).
5. Migrar `commandPass` a transacciones (curl/wget/node primero, luego ssh y kubectl con hijo). Quitar `script_exit` duplicado solo si D3 lo decide.
6. Anotaciones iniciales (D5), si se aprueban.
7. UI: sangría, `request_annotation`, columnas de comando.
8. Docs: `log-format.md`, `manifest.md` si cambia algo observable, `concepts/command_pass.md`, `kubectl_pass.md`.
9. `bun run features`, `bun test`, `bun run features:check`; PR con título `feat: logger con transacciones anidadas`.

## 9. Dudas abiertas

| # | Duda | Recomendación |
| --- | --- | --- |
| D1 | Con `kubectl`, ¿un `command_end` por proceso (cada uno con su `console_log`) o mantener los dos idénticos de hoy? | **Uno por proceso.** Cada child_process emite un `command_start` al iniciar y un `command_end` al terminar; el árbol ya expresa la relación y el duplicado solo existía porque no había ids. Se avisa en `log-format.md`. |
| D2 | ¿Modelar el motor remoto de `ssh` como transacción hija (como `kubectl`)? | **No por ahora**: el remoto va dentro de `args` y no hay segundo proceso local. Se puede añadir sin romper nada. |
| D3 | ¿Conservar `script_exit` además de `command_end`? | **Sí en esta entrega**, marcado como obsoleto en docs; retirarlo en el siguiente minor. |
| D4 | `annotation` en una transacción hija: ¿`type: "annotation"` o siempre `request_annotation`? | **`request_annotation` solo en la raíz y `annotation` en hijos**, así el nombre no miente. |
| D5 | ¿Emitir anotaciones automáticas (ruta que coincidió, espera de `concurrency`)? | **Sí, solo `route`** (patrón y método). La espera se deja para otra iteración. |
| D6 | `Logger` ¿estático global (`Logger.request…`) o creado por el sistema? | **Creado por el sistema** con `createLogger_experimental(writable)`, una instancia por servidor. Varios servidores con distinto `log_file` conviven en el mismo proceso (los tests lo hacen); un global los mezclaría. |
| D7 | `transaction_id`: ¿se queda como id de la petición o pasa a ser el de cada transacción? | **Se queda como id de la petición** (compatibilidad con UI y tests); el id propio es `span_id`. |
| D8 | `end(exitCode, logs)` ¿recibe los logs o el logger los acumula? | **Recibe los logs, como en tu ejemplo.** Quien ejecuta el proceso (`commandPass`) ya los acumula con `onConsole`. |
| D9 | Los tipos `command` y `command_exit` pasan a `command_start` y `command_end`: ¿se emiten también con los nombres viejos durante una versión? | **No: renombrar sin alias.** El `.ndjson` es de consumo interno (UI y tests); se actualizan ambos y se documenta. `response.command` se mantiene. Si hay consumidores externos, alias por un minor. |
