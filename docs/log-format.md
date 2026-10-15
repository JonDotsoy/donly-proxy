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

## Transacciones anidadas

Cada petición es una **transacción** y todo lo que hace por debajo (cada proceso que ejecuta, la petición que envía al destino de un `proxy_pass`) es una transacción **hija**. Se enlazan con dos campos:

| Campo | Descripción |
| --- | --- |
| `span_id` | UUID propio de la transacción. Las líneas que la abren y la cierran lo comparten (`command_start` y `command_end`, `request_proxy_pass` y `response_proxy_pass`; `request` y `response`). |
| `parent_span_id` | `span_id` de la transacción que la abrió. Ausente en `request`. |

`transaction_id` sigue siendo el de la petición y lo comparte todo el árbol. Un hijo siempre se cierra antes que su padre.

## Tipos de línea

| `type` | Cuándo | Campos propios |
| --- | --- | --- |
| `listening` | Al arrancar. | `host`, `port` (el real si `port` es `0`). |
| `request` | Petición recibida. | `span_id`, `headers`, `payload`, y `payload_encoding: "base64"` si no es UTF-8. |
| `request_annotation` | Datos propios que se adjuntan a la petición. | `span_id`, `annotation`. |
| `request_proxy_pass` | Antes de enviar la petición al destino de una ruta `proxy_pass`. | `span_id`, `parent_span_id`, `target` (URL del destino), `headers`, `payload`. |
| `response_proxy_pass` | Cuando el destino responde (o falla: `502`). | `span_id`, `parent_span_id`, `target`, `status`, `headers`, `payload`. |
| `command_start` | Cuando arranca un proceso de una ruta `command_pass`, `kubectl_pass` o `ssh_pass`. | `span_id`, `parent_span_id`, `program`, `args`, `command` (programa y argumentos). Con `kubectl` hay dos: `kubectl exec …` y, hijo suyo, el del motor remoto. |
| `annotation` | Datos propios que se adjuntan a un proceso. | `span_id`, `parent_span_id`, `annotation`. |
| `script` | Motor `node` (local o remoto), justo después de `command_start`. | `parent_span_id` (el proceso `node`), `program: "node"`, `script` (lo que se envía por stdin). |
| `command_end` | **Siempre** al terminar cada proceso. | `span_id`, `parent_span_id`, `program`, `exit_code`, `console_log`. |
| `script_exit` | Al terminar un script (motor `node`), justo después de su `command_end`. | `program: "node"`, `exit_code`, `console_log`. |
| `response` | Respuesta enviada al cliente. | `span_id`, `status`, `headers`, `payload`, `payload_encoding`, y `command` en rutas con comando. |

Orden de una transacción con `proxy_pass`: `request` → `request_proxy_pass` → `response_proxy_pass` → `response`.

Orden de una transacción con comando: `request` → `command_start` (→ `command_start` hijo → `script`) → `command_end` del hijo (→ `script_exit`) → `command_end` del padre → `response`.

## `command_end`: `exit_code` y `console_log`

- `exit_code`: código de salida del programa, o `null` si lo mató una señal (también si la petición terminó antes de que el proceso lo hiciera).
- `console_log`: lista ordenada de `{ "type": "stdout" | "stderr" | "stdin", "timestamp": string, "message": string }`. `stdin` es lo que el proxy escribió al proceso (petición codificada o script de `node`), `stdout` y `stderr` lo que imprimió, en orden de llegada, cada uno con su `timestamp` ISO 8601. Es `[]` si no hubo nada.
- Con `kubectl` hay dos líneas `command_end` (la de `kubectl` y la del motor), ambas con el mismo `exit_code` y la misma `console_log`: un único proceso local las produjo.
- `console_log` solo se registra en el log; **no cambia la respuesta al cliente**.
- Puede contener datos de la petición (cabeceras, cuerpo) y credenciales presentes en la salida: protege el archivo.

```json
{"timestamp":"2026-10-15T13:00:00.200Z","transaction_id":"61e52431-…","span_id":"…","parent_span_id":"…","type":"command_end","program":"kubectl","exit_code":0,"console_log":[{"type":"stdin","timestamp":"2026-10-15T13:00:00.010Z","message":"…"},{"type":"stdout","timestamp":"2026-10-15T13:00:00.190Z","message":"{\"status\":200,…}"},{"type":"stderr","timestamp":"2026-10-15T13:00:00.195Z","message":"Defaulted container \"app\"\n"}]}
```
