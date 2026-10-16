# Módulo `spawn` (aún no conectado)

`src/spawn/` ejecuta procesos con un patrón request/response. Todavía no lo usa el proxy ni el manifest.

```ts
import { ShellRequest, SystemSpawn, spawn } from "./src/spawn";

const request = new ShellRequest({ commands: ["cat"], env: { A: "1" }, cwd: "/tmp", stdin: new WritableStream() });
const response = await spawn(request, { system: SystemSpawn.defaultChildProcess });
response.pid;        // number
response.stdout;     // ReadableStream<Uint8Array>
response.stderr;     // ReadableStream<Uint8Array>
await response.exitCode;
await request.stdin.getWriter().close(); // cierra el stdin del proceso
```

- `ShellRequest` recibe `commands` (programa y argumentos, nunca una cadena de shell), `env`, `cwd`, `signal` y `stdin`.
  `new ShellRequest(request, extra)` copia una petición y comparte su `stdin` salvo que `extra.stdin` lo reemplace.
  Sin `stdin` el request no tiene `stdin` ni tty (`tty: false`) y el proceso recibe el fin de entrada de inmediato.
  Con `stdin` en las opciones el request tiene `request.stdin` (lo escrito también va a ese stream) y equivale a `tty: true`.
- `signal` (un `AbortSignal`): al abortarlo se termina el proceso (`SIGHUP` en tty, `SIGTERM` si no). No aplica a procesos anidados.
- Con `stdin` (solo Bun) el proceso queda en un pseudo terminal: stdout y stderr llegan mezclados por `stdout`
  y cerrar el stdin envía `SIGHUP` al proceso (un terminal no tiene fin de entrada).
- `SystemSpawn.defaultChildProcess` ejecuta como hijo de este proceso.
- `SystemSpawn.fromResponse(response)` ejecuta dentro de un shell ya iniciado (p. ej. `bash`) que lee comandos
  por stdin. Toma posesión de `response.stdout`, ejecuta de a un proceso por vez, mezcla stderr en stdout y
  les da `/dev/null` como stdin. Los argumentos se citan, no se interpolan.
