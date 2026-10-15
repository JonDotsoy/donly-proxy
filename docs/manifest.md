# Manifiesto (`manifest.donly`)

El proxy se configura con un archivo en formato [DON](https://don.jon.soy/). Por defecto se lee
`manifest.donly` en la raíz del proyecto; se puede indicar otro como primer argumento:
`bun src/cli/main.ts ruta/al/manifest.donly`.

Todo va dentro de un único bloque `proxy`:

```
proxy {
  host "127.0.0.1"
  port 8080
  log_file "./logs/proxy.ndjson"
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route https?://example.com/ {
    respond 200 "good"
  }
}
```

Las rutas de archivo (`log_file`, `ssl.cert`, `ssl.key`) son **relativas a la carpeta del
manifiesto**, no al directorio desde el que se ejecuta el proceso.

## Directivas

| Directiva | Valor | Por defecto | Descripción |
| --- | --- | --- | --- |
| `listen` | `[http\|https] [host] [puerto] [{ ssl { … } }]` | `http 127.0.0.1 0` | Protocolo, dirección y puerto del listener (ver [`listen`](#listen)). |
| `host` | string | `"127.0.0.1"` | Dirección en la que escucha (IPv4 o IPv6: `"::1"`, `"::"`, `"0:0:0:0:0:0:0:1"`, `"[::1]"`, `"::ffff:127.0.0.1"`). Si se omite, solo escucha en loopback. Un `host` dentro de `listen` tiene prioridad. |
| `port` | `[http\|https] puerto [{ ssl { … } }]` | `0` | Alias de `listen` sin host: `port 8080` equivale a `listen http 8080`. |
| `ssl` | bloque | ver abajo | **Deprecado.** Certificado usado para terminar el TLS de los túneles `CONNECT`. No sirve para que el proxy escuche por HTTPS: usa `listen https`. |
| `log_file` | string | sin log | Archivo `.ndjson` donde se registran las transacciones. |
| `route` | bloque | sin rutas | Regla por petición. Se pueden declarar varias. |

### `ssl`

```
ssl {
  cert "./certs/cert.pem"
  key "./certs/key.pem"
}
```

Por defecto | Descripción |
| --- | --- | --- | --- |
| `cert` | string | `"./certs/cert.pem"` | Certificado. |
| `key` | string | `"./certs/key.pem"` | Clave privada. |
| `listen` | `true`/`false` | `false` | Si es `true`, el listener del proxy habla TLS: el cliente se conecta con `https://` al proxy. |

Por defecto `./certs/cert.pem` y `./certs/key.pem`. Si alguno de los dos archivos no existe, el
proxy genera un par autofirmado con `openssl` (CN `donly-proxy`, 365 días) y lo guarda en esas
rutas, creando las carpetas necesarias. Si ya existen, no los toca.

### `listen`

```
listen [http|https] [host] puerto [{ ssl { cert "…" key "…" } }]
```

El protocolo (`http` por defecto), el `host` (por defecto el de la directiva `host`) y el
`puerto` (`0` = lo asigna el sistema, también si se omite) son posicionales y todos opcionales.

| Sintaxis | Qué hace |
| --- | --- |
| `listen` | Sin argumentos: HTTP en `127.0.0.1` con un puerto aleatorio (`0`). |
| `listen 0` | Proxy HTTP en el host por defecto. |
| `listen http 0` | Igual que la anterior. |
| `listen https 0` | Proxy HTTPS con certificado autofirmado generado localmente. |
| `listen http 127.0.0.1 0` | Proxy HTTP en ese host. |
| `listen https 127.0.0.1 0` | Proxy HTTPS en ese host, certificado autofirmado. |
| `listen https 127.0.0.1 0 { ssl { cert "…" key "…" } }` | Proxy HTTPS con tus certificados. |

```
proxy {
  listen https 127.0.0.1 0 {
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
  }
}
```

Con `https` la conexión del cliente **hacia el proxy** va cifrada. Sin bloque `ssl`, o si faltan
los archivos, se usan `./certs/cert.pem` y `./certs/key.pem` y se genera un par autofirmado como
se describe arriba. `CONNECT`, `proxy_pass` y `command_pass` funcionan igual.

`port` sigue soportado como alias de `listen` sin host: `port 8080` = `listen http 8080` y
`port https 0 { ssl { … } }` = `listen https 0 { ssl { … } }`. No se pueden declarar `listen` y
`port` a la vez. El bloque `ssl` de nivel superior se mantiene por compatibilidad (sigue
terminando el TLS de los túneles `CONNECT`) pero está deprecado y no afecta al listener.

```sh
curl --proxy https://127.0.0.1:8080 --proxy-cacert certs/cert.pem https://example.com/
# con el certificado autofirmado, sin verificar: --proxy-insecure -k
```

### `log_file`

Solo se admite la extensión `.ndjson`; con otra, el arranque falla. Se crean las carpetas que
falten y cada evento se agrega como una línea JSON al final del archivo.

El formato completo de todas las líneas (incluidos `exit_code` y `console_log`) está en [`log-format.md`](log-format.md).

Con `donly-proxy --ui` el archivo se puede seguir en el navegador (ver [`--ui`](overview.md#--ui-logs-en-vivo)).

Al empezar a escuchar, el proxy escribe una línea `listening` con el `host` y el `port` reales
(el que asignó el sistema si `port` es `0`):

```json
{"timestamp":"2026-10-13T01:59:00.120Z","type":"listening","host":"127.0.0.1","port":8080}
```

Cada petición genera **dos líneas**, una `request` y una `response`, que comparten el
`transaction_id` (un UUID):

```json
{"timestamp":"2026-10-13T01:59:02.381Z","transaction_id":"61e52431-d104-4f8c-b703-e65680da0eac","http_version":"HTTP/1.1","method":"POST","url":"http://example.com/","type":"request","headers":{"host":"example.com","content-length":"2"},"payload":"hi"}
{"timestamp":"2026-10-13T01:59:02.381Z","transaction_id":"61e52431-d104-4f8c-b703-e65680da0eac","http_version":"HTTP/1.1","method":"POST","url":"http://example.com/","type":"response","status":200,"headers":{"content-type":"text/plain"},"payload":"good"}
```

| Campo | Descripción |
| --- | --- |
| `timestamp` | Fecha y hora ISO 8601 (UTC) del evento. |
| `transaction_id` | UUID compartido por todas las líneas de una petición (`request`, comandos, `proxy_pass` y `response`). |
| `span_id` / `parent_span_id` | `span_id` identifica cada transacción (la petición, cada proceso, el par del `proxy_pass`); `parent_span_id` es el `span_id` de la que la abrió. Ver [formato del log](log-format.md). |
| `http_version` | Versión HTTP de la petición, p. ej. `HTTP/1.1`. |
| `method` | Método de la petición. |
| `url` | URL completa, p. ej. `https://example.com/ruta?q=1` (sin `:443`). |
| `type` | `request`, `response`, `listening` (arranque), `request_annotation`, `annotation`, `command_start`, `command_end`, `proxy_pass_request`, `proxy_pass_response`, `script_start` o `script_end`. |
| `status` | Solo en `response`: código de estado devuelto al cliente. |
| `command` | Solo en `response` de rutas `command_pass`: la línea de comandos ejecutada, como lista (programa y argumentos). |
| `script` | Solo en líneas `type: "script_start"`: el script completo que el motor `node` envía por stdin (local, o al `node` remoto con `kubectl_pass` / `ssh_pass`), justo después de las líneas `command_start`. |
| `script_end` | Solo en líneas `type: "script_end"`: cierra un `script_start` (motor `node`) con el `exit_code` y el `console_log` del proceso que lo ejecutó, justo después de su `command_end`. |
| `exit_code` | Siempre presente en líneas `type: "command_end"`: código de salida del programa (`null` si lo mató una señal). Todo proceso ejecutado termina su log con `command_end`. |
| `console_log` | En **toda** línea `type: "command_end"` (`curl`, `wget`, `node`, `ssh`, `kubectl`; con `kubectl` ambas líneas, la de `kubectl` y la del motor, llevan la misma lista): lista ordenada `{ "type": "stdout" \| "stderr" \| "stdin", "timestamp": string, "message": string }[]` con lo que se escribió por stdin y lo que el programa imprimió por stdout y stderr. Es `[]` si no hubo salida. No altera la respuesta al cliente. |
| `headers` | Cabeceras de la petición o de la respuesta. |
| `payload` | Cuerpo como texto UTF-8. Si no es UTF-8 válido se guarda en base64 y la línea incluye `"payload_encoding":"base64"`. |

Se registran todas las transacciones: rutas `respond`, `proxy_pass`, `command_pass`, las
respuestas `ok` por defecto y los `502`. Las rutas `command_pass` añaden además el campo `command` con lo que se ejecutó, incluso si el comando falla (por ejemplo `["curl","--silent",…,"--url","http://example.com/"]`); con `ssh` y `kubectl` incluye el comando remoto, que lleva la petición codificada en base64. Las demás rutas no tienen `command`. En `proxy_pass` y `command_pass` el `payload` de la
respuesta es el cuerpo ya descomprimido. El `CONNECT` en sí no se registra, solo las
peticiones descifradas que viajan por el túnel.

### `route`

```
route [MÉTODO] <patrón> {
  respond <estado> "<cuerpo>"
}

route {                      # sin argumentos: todas las peticiones
  respond 404 "not found"
}
```

- **Método** (opcional): `GET`, `POST`, etc. Sin método, la ruta aplica a cualquier método.
- **Patrón**: expresión regular (JavaScript) probada contra la **URL completa**, incluidos el
  esquema, el host, la ruta y el query: `https://example.com/a/b?x=1`. No está anclada: busca
  coincidencia en cualquier parte de la URL. Ancla con `^` y `$` si lo necesitas, y recuerda
  que `.` coincide con cualquier carácter.
- **Sin argumentos**: `route { … }` coincide con **todas** las peticiones (HTTP y HTTPS, cualquier
  método). Como gana la primera ruta que coincide, ponla **al final**: las rutas declaradas
  después de ella nunca se alcanzan.
- **Orden**: gana la **primera** ruta que coincida; pon las más específicas arriba.
- **Sin coincidencia**: el proxy responde `200 ok`.
- Cada `route` debe tener **exactamente una** de estas acciones; con ninguna o con más de una,
  el arranque falla:

| Acción | Qué hace |
| --- | --- |
| [`respond`](#respond) | Responde con un estado y cuerpo fijos. |
| [`proxy_pass`](tunnel/proxy-pass.md) | Reenvía la petición a otro servidor. |
| [`command_pass`](tunnel/command-pass.md) | Pasa la petición a `curl`, a un proceso `node`, a otra máquina por `ssh` o a un pod con `kubectl`. |
| [`kubectl_pass`](tunnel/command-pass.md#kubectl_pass) | Ejecuta la petición en un pod con el `command_pass` anidado (`curl`, `wget` o `node`). |
| [`ssh_pass`](tunnel/command-pass.md#ssh_pass) | Ejecuta la petición en un host remoto por `ssh` con el `command_pass` anidado (`curl`, `wget` o `node`). |

#### `respond`

```
respond <estado> "<cuerpo>"
```

Responde con el código `<estado>` y el cuerpo indicado (vacío si se omite), con
`content-type: text/plain`. Las cadenas deben ir entre comillas rectas (`"`).

```
route POST http://example.com/ {
  respond 201 "created"
}

route https?://example.com/ {
  respond 200 "good"
}
```

## Lint del manifiesto

Antes de cargar el manifiesto, `bun start` lo evalúa con las reglas de [`donly/lint`](https://don.jon.soy/)
(`src/proxy/lint.ts`) e imprime el informe por stderr (`línea:columna severidad mensaje`).

- Los **errores** abortan el arranque con código de salida `1`.
- Las **advertencias** se imprimen y el proxy arranca igual.

| Regla | Severidad |
| --- | --- |
| Falta el bloque `proxy` (o hay más de uno) | error |
| `host` no es un string | error |
| `port` no es un número entre 0 y 65535 | error |
| `log_file` no es un string que termine en `.ndjson` | error |
| `ssl.cert` / `ssl.key` no son strings | error |
| `route` sin exactamente una acción (`respond`, `proxy_pass`, `command_pass`, `kubectl_pass` o `ssh_pass`): cero o dos o más, p. ej. `kubectl_pass` junto a `proxy_pass` | error |
| `respond` con estado fuera de 100–599 o cuerpo que no es un string | error |
| `proxy_pass` que no es una URL `http(s)://` | error |
| `host` o `port` (deprecadas) | advertencia |
| Directiva desconocida dentro de `proxy`, `ssl` o `route` | advertencia |
| `respond` con argumentos de más | advertencia |
| `route` declarada después de una `route` sin argumentos (inalcanzable) | advertencia |

## Errores de arranque

| Causa | Mensaje |
| --- | --- |
| `--ui` (CLI) con un manifest sin `log_file` | `--ui requiere log_file en el manifiesto para poder mostrar los logs` |
| `--ui` (CLI) con el puerto ocupado | `no se pudo levantar la ui en 127.0.0.1:<puerto>: EADDRINUSE` |
| `log_file` sin extensión `.ndjson` | `log_file …: solo se soporta la extensión .ndjson` |
| `listen` y `port` a la vez | `listen y port no se pueden declarar a la vez: port es un alias de listen` |
| `listen` / `port` sin puerto numérico | `listen: el puerto debe ser un número, no "…"` |
| `listen` / `port` con argumentos de más | `listen: se esperaba [http\|https] [host] puerto` |
| `route` sin acción o con varias | `route …: se requiere exactamente uno de respond, proxy_pass, command_pass, kubectl_pass o ssh_pass` |
| `command_pass` con un comando distinto de `curl`, `node`, `ssh` o `kubectl` | `route …: command_pass solo soporta "curl", "node", "ssh" y "kubectl"` |
| `command_pass ssh` / `kubectl` sin destino | `route …: command_pass ssh requiere el destino (usuario@host)` / `… kubectl requiere el destino (pod o tipo/nombre)` |
| `concurrency` que no es un entero positivo | `route …: concurrency debe ser un entero positivo, no "…"` |
| `no_warnings` con un valor que no es `true` / `false`, o fuera de `command_pass node` | `route …: no_warnings debe ser true o false, no "…"` / `no_warnings solo aplica a command_pass node` |
| `insecure` con un valor que no es `true` / `false`, o fuera de `command_pass curl` | `route …: insecure debe ser true o false, no "…"` / `insecure solo aplica a command_pass curl` |
| `max_time` que no es un número positivo, o fuera de `command_pass curl` | `route …: max_time debe ser un número positivo, no "…"` / `max_time solo aplica a command_pass curl` |
| `kubectl_pass` / `command_pass kubectl` con `context` / `namespace` que no es un nombre | `route …: context debe ser un nombre, no "…"` / `namespace debe ser un nombre, no "…"` |
| `kubectl_pass` con `pod_name` vacío o que no es un nombre | `route …: pod_name debe ser un nombre, no "…"` |
| `kubectl_pass` sin destino ni `pod_name` | `route …: kubectl_pass requiere el destino (pod o tipo/nombre, o las subdirectivas pod_name / pod_match)` |
| `kubectl_pass` con `pod_match` vacío, o combinado con `pod_name` | `route …: pod_match debe ser un patrón, no "…"` / `pod_name y pod_match no se pueden combinar` |
| `ssh_pass` con `port` fuera de 1–65535, `user` o `pass` inválidos | `route …: port debe ser un puerto entre 1 y 65535, no "…"` / `user debe ser un nombre, no "…"` / `pass debe ser un texto no vacío` |
| `context` / `namespace` fuera de `kubectl_pass` y `command_pass kubectl` | `route …: namespace solo aplica a kubectl_pass y command_pass kubectl` |
| `retry` que no es un entero no negativo, o fuera de `command_pass curl` | `route …: retry debe ser un entero no negativo, no "…"` / `retry solo aplica a command_pass curl` |
| `engine` distinto de `curl` / `node` / `wget`, o usado fuera de `ssh` y `kubectl` | `route …: engine solo soporta …` / `engine solo aplica a command_pass ssh y kubectl` |
| Patrón de `route` que no es una regex válida | Error de `RegExp` |
| `proxy_pass` con una URL inválida | Error de `URL` |
