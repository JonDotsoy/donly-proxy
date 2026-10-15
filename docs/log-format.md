# Formato del `.ndjson`

El [`log_file`](manifest.md#log_file) es un archivo [NDJSON](https://github.com/ndjson/ndjson-spec): una línea JSON por evento, en orden de ocurrencia. Solo se admite la extensión `.ndjson`.

## Campos comunes

Todas las líneas incluyen:

| Campo | Descripción |
| --- | --- |
| `timestamp` | Fecha y hora ISO 8601 (UTC). |
| `performance_timestamp` | Instante exacto (ms, con decimales) de la Performance API. |
| `type` | Tipo de línea (ver abajo). |

Las líneas de una transacción añaden `transaction_id` (UUID compartido por todas sus líneas), `http_version`, `method` y `url` (completa, sin `:443`).

## Tipos de línea

| `type` | Cuándo | Campos propios |
| --- | --- | --- |
| `listening` | Al arrancar. | `host`, `port` (el real si `port` es `0`). |
| `request` | Petición recibida. | `headers`, `payload`, y `payload_encoding: "base64"` si no es UTF-8. |
| `command` | Antes de ejecutar un programa de una ruta `command_pass`, `kubectl_pass` o `ssh_pass`. | `program`, `command` (programa y argumentos). Con `kubectl` hay dos: `kubectl exec …` y el del motor remoto. |
| `script` | Motor `node` (local o remoto), justo después de `command`. | `program: "node"`, `script` (lo que se envía por stdin). |
| `script_exit` | Al terminar un script (motor `node`), justo después de su `command_exit`. | `program: "node"`, `exit_code`, `console_log` (los del proceso que lo ejecutó). |
| `command_exit` | **Siempre** al terminar cada comando o script ejecutado. | `program`, `exit_code`, `console_log`. |
| `response` | Respuesta enviada al cliente. | `status`, `headers`, `payload`, `payload_encoding`, y `command` en rutas con comando. |

Orden de una transacción con comando: `request` → `command` (→ `script`) → `command_exit` (→ `script_exit`) → `response`.

## `command_exit`: `exit_code` y `console_log`

- `exit_code`: código de salida del programa, o `null` si lo mató una señal.
- `console_log`: lista ordenada de `{ "type": "stdout" | "stderr" | "stdin", "message": string }`. `stdin` es lo que el proxy escribió al proceso (petición codificada o script de `node`), `stdout` y `stderr` lo que imprimió, en orden de llegada. Es `[]` si no hubo nada.
- Con `kubectl` hay dos líneas `command_exit` (la de `kubectl` y la del motor), ambas con el mismo `exit_code` y la misma `console_log`.
- `console_log` solo se registra en el log; **no cambia la respuesta al cliente**.
- Puede contener datos de la petición (cabeceras, cuerpo) y credenciales presentes en la salida: protege el archivo.

```json
{"timestamp":"2026-10-15T13:00:00.200Z","transaction_id":"61e52431-…","type":"command_exit","program":"kubectl","exit_code":0,"console_log":[{"type":"stdin","message":"…"},{"type":"stdout","message":"{\"status\":200,…}"},{"type":"stderr","message":"Defaulted container \"app\"\n"}]}
```
