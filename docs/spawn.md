# Módulo `spawn`

`src/spawn/` ejecuta procesos con un patrón request/response. Lo usa `run()` de `src/proxy/tunnel/run.ts`,
por lo que `curl`, `wget`, `node`, `ssh` y `kubectl` (`command_pass`, `ssh_pass`, `kubectl_pass`) ejecutan a través de él.
Si el proceso muere por una señal, `exitCode` es `128 + señal` (antes era `null`).

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

- `ShellRequest` recibe `commands` (programa y argumentos, nunca una cadena de shell), `env`, `cwd`, `signal`, `stdin` y `tty`.
  `new ShellRequest(request, extra)` copia una petición y comparte su `stdin` salvo que `extra.stdin` lo reemplace.
  Sin `stdin` el request no tiene `stdin` ni tty (`tty: false`) y el proceso recibe el fin de entrada de inmediato.
  Con `stdin` en las opciones el request tiene `request.stdin` (lo escrito también va a ese stream) y por defecto equivale a `tty: true`;
  con `tty: false` el `stdin` es una tubería: sin eco ni terminal, y cerrarlo termina la entrada (así lo usa `run()`).
- `signal` (un `AbortSignal`): al abortarlo se termina el proceso con la señal de `controller.abort(new SignalError("SIGHUP"))` (también acepta el número de señal o un código de salida: `new SignalError(129)`); sin ella, `SIGHUP` en tty y `SIGTERM` si no. No aplica a procesos anidados.
- Con `stdin` (solo Bun) el proceso queda en un pseudo terminal: stdout y stderr llegan mezclados por `stdout`
  y cerrar el stdin envía `SIGHUP` al proceso (un terminal no tiene fin de entrada).
- `SystemSpawn.defaultChildProcess` ejecuta como hijo de este proceso.
- `SystemSpawn.fromResponse(response)` ejecuta dentro de un shell ya iniciado (p. ej. `bash`) que lee comandos
  por stdin. Toma posesión de `response.stdout`, ejecuta de a un proceso por vez, mezcla stderr en stdout y
  les da `/dev/null` como stdin. Los argumentos se citan, no se interpolan.
