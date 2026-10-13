# Manifiesto (`manifest.donly`)

El proxy se configura con un archivo en formato [DON](https://don.jon.soy/). Por defecto se lee
`manifest.donly` en la raíz del proyecto; se puede indicar otro como primer argumento:
`bun src/server.ts ruta/al/manifest.donly`.

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
| `host` | string | `"127.0.0.1"` | Dirección en la que escucha. |
| `port` | número | `8080` | Puerto. `0` asigna uno libre. |
| `ssl` | bloque | ver abajo | Certificado usado para terminar el TLS de los túneles `CONNECT`. |
| `log_file` | string | sin log | Archivo `.ndjson` donde se registran las transacciones. |
| `route` | bloque | sin rutas | Regla por petición. Se pueden declarar varias. |

### `ssl`

```
ssl {
  cert "./certs/cert.pem"
  key "./certs/key.pem"
}
```

Por defecto `./certs/cert.pem` y `./certs/key.pem`. Si alguno de los dos archivos no existe, el
proxy genera un par autofirmado con `openssl` (CN `donly-proxy`, 365 días) y lo guarda en esas
rutas, creando las carpetas necesarias. Si ya existen, no los toca.

### `log_file`

Solo se admite la extensión `.ndjson`; con otra, el arranque falla. Se crean las carpetas que
falten y cada evento se agrega como una línea JSON al final del archivo.

Cada petición genera **dos líneas**, una `request` y una `response`, que comparten el
`transaction_id` (un UUID):

```json
{"timestamp":"2026-10-13T01:59:02.381Z","transaction_id":"61e52431-d104-4f8c-b703-e65680da0eac","http_version":"HTTP/1.1","method":"POST","url":"http://example.com/","type":"request","headers":{"host":"example.com","content-length":"2"},"payload":"hi"}
{"timestamp":"2026-10-13T01:59:02.381Z","transaction_id":"61e52431-d104-4f8c-b703-e65680da0eac","http_version":"HTTP/1.1","method":"POST","url":"http://example.com/","type":"response","status":200,"headers":{"content-type":"text/plain"},"payload":"good"}
```

| Campo | Descripción |
| --- | --- |
| `timestamp` | Fecha y hora ISO 8601 (UTC) del evento. |
| `transaction_id` | UUID compartido por la `request` y su `response`. |
| `http_version` | Versión HTTP de la petición, p. ej. `HTTP/1.1`. |
| `method` | Método de la petición. |
| `url` | URL completa, p. ej. `https://example.com/ruta?q=1` (sin `:443`). |
| `type` | `request` o `response`. |
| `status` | Solo en `response`: código de estado devuelto al cliente. |
| `command` | Solo en `response` de rutas `command_pass`: la línea de comandos ejecutada, como lista (programa y argumentos). |
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

## Errores de arranque

| Causa | Mensaje |
| --- | --- |
| `log_file` sin extensión `.ndjson` | `log_file …: solo se soporta la extensión .ndjson` |
| `route` sin acción o con varias | `route …: se requiere exactamente uno de respond, proxy_pass, command_pass o kubectl_pass` |
| `command_pass` con un comando distinto de `curl`, `node`, `ssh` o `kubectl` | `route …: command_pass solo soporta "curl", "node", "ssh" y "kubectl"` |
| `command_pass ssh` / `kubectl` sin destino | `route …: command_pass ssh requiere el destino (usuario@host)` / `… kubectl requiere el destino (pod o tipo/nombre)` |
| `concurrency` que no es un entero positivo | `route …: concurrency debe ser un entero positivo, no "…"` |
| `engine` distinto de `curl` / `node` / `wget`, o usado fuera de `ssh` y `kubectl` | `route …: engine solo soporta …` / `engine solo aplica a command_pass ssh y kubectl` |
| Patrón de `route` que no es una regex válida | Error de `RegExp` |
| `proxy_pass` con una URL inválida | Error de `URL` |
