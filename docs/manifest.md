# Manifiesto (`manifest.donly`)

El proxy se configura con un archivo en formato [DON](https://don.jon.soy/). Sin argumentos se lee
el primero que exista en el directorio actual entre `proxy.donly`, `.proxy.donly`, `manifest.donly` y `.manifest.donly` (si ninguno existe, termina con un error que indica los archivos y la ruta buscados);
se puede indicar otro como primer argumento: `bun src/cli/main.ts ruta/al/manifest.donly`.

Todo va dentro de un bloque `proxy` (se puede declarar más de uno, ver [Varios bloques `proxy`](#varios-bloques-proxy)):

```
proxy {
  host "127.0.0.1"
  port 8080
  log_file "./logs/proxy.ndjson"
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  route http{s}?://example.com/* {
    respond 200 "good"
  }
}
```

Las rutas de archivo (`log_file`, `ssl.cert`, `ssl.key`) son **relativas a la carpeta del
manifiesto**, no al directorio desde el que se ejecuta el proceso.

## Directivas

| Directiva | Valor | Por defecto | Descripción |
| --- | --- | --- | --- |
| `listen` | `[http\|https\|socks4\|socks5] [host] [puerto] [{ ssl { … } }]` | `http 127.0.0.1 0` | Protocolo, dirección y puerto del listener (ver [`listen`](#listen)). |
| `host` | string | `"127.0.0.1"` | Dirección en la que escucha (IPv4 o IPv6: `"::1"`, `"::"`, `"0:0:0:0:0:0:0:1"`, `"[::1]"`, `"::ffff:127.0.0.1"`). Si se omite, solo escucha en loopback. Un `host` dentro de `listen` tiene prioridad. |
| `port` | `[http\|https] puerto [{ ssl { … } }]` | `0` | Alias de `listen` sin host: `port 8080` equivale a `listen http 8080`. |
| `ssl` | bloque | ver abajo | **Deprecado.** Certificado usado para terminar el TLS de los túneles `CONNECT`. No sirve para que el proxy escuche por HTTPS: usa `listen https`. |
| `log_file` | string | sin log | Archivo `.ndjson` donde se registran las transacciones. |
| `auth` | `basic { username "…" password "…" }` | sin autenticación | Exige usuario y contraseña a los clientes (ver [`auth`](#auth)). Se puede repetir, una vez por usuario. |
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
listen [http|https|socks4|socks5] [host] puerto [{ ssl { cert "…" key "…" } }]
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
| `listen socks4 0` | Proxy SOCKS4 / SOCKS4a (ver [SOCKS](#socks4-y-socks5)). |
| `listen socks5 127.0.0.1 0` | Proxy SOCKS5 en ese host (ver [SOCKS](#socks4-y-socks5)). |

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

#### Varios bloques `proxy`

Un manifest puede tener varios bloques `proxy`. Cada uno es un proxy independiente, con su propio
`listen`, `route`, `ssl` y `log_file`:

```
proxy {
  listen http 8090
  route {
    respond 200 "ok http"
  }
}
proxy {
  listen https 8091
  route {
    respond 200 "ok https"
  }
}
```

`curl --proxy http://127.0.0.1:8090 …` responde `ok http` y `curl --proxy https://127.0.0.1:8091 …`
responde `ok https`. Dos bloques no pueden usar el mismo host y puerto fijo (mismo error que dos
`listen` repetidos). La opción `--ui` muestra el log del primer bloque que declare `log_file`.

#### Varios `listen`

Se puede declarar `listen` más de una vez: el proxy abre un listener por cada uno, cada cual con su
protocolo, host, puerto y certificados. Todos comparten las mismas `route` y el mismo `log_file`.

```
proxy {
  listen http 9080
  listen https 9081
}
```

Al arrancar se imprime una línea `proxy listening on <host>:<puerto> (http|https|socks4|socks5)` por listener y
el log escribe un evento `listening` por cada uno. Dos `listen` con el mismo host y un puerto fijo
(distinto de `0`) hacen fallar el arranque. `port` también se puede repetir.

`port` sigue soportado como alias de `listen` sin host: `port 8080` = `listen http 8080` y
`port https 0 { ssl { … } }` = `listen https 0 { ssl { … } }`. No se pueden declarar `listen` y
`port` a la vez. El bloque `ssl` de nivel superior se mantiene por compatibilidad (sigue
terminando el TLS de los túneles `CONNECT`) pero está deprecado y no afecta al listener.

```sh
curl --proxy https://127.0.0.1:8080 --proxy-cacert certs/cert.pem https://example.com/
# con el certificado autofirmado, sin verificar: --proxy-insecure -k
```

#### `socks4` y `socks5`

```
listen socks5 127.0.0.1 1080
```

El listener habla SOCKS en lugar de HTTP: `socks4` acepta SOCKS4 y SOCKS4a, `socks5` acepta
SOCKS5 (un cliente de otra versión es desconectado). Sin [`auth`](#auth) (SOCKS5 método «sin
autenticación»; si el cliente no lo ofrece, responde `0xFF` y cierra), solo el comando `CONNECT`
(`BIND` y `UDP ASSOCIATE` se rechazan) y destinos IPv4, IPv6 y nombre de dominio (en SOCKS4, el
nombre solo con SOCKS4a).

Un túnel SOCKS se comporta como un túnel `CONNECT`: el proxy **no abre conexión al destino**,
sino que termina el túnel y aplica las [`route`](concepts/route.md) a las peticiones que lleva
dentro. Si el cliente empieza con un `ClientHello` TLS, se termina con el certificado del
proxy (el cliente debe aceptarlo: `curl -k`) y las rutas ven `https://host/ruta` (sin `:443`;
otros puertos se conservan, IPv6 entre corchetes); si no, es HTTP en claro y ven
`http://host/ruta`. Sin ruta que coincida responde `200 ok`. Cada petición del túnel se
registra en el `log_file` como cualquier otra (`request` / `response`, con la URL completa):
no hay tipos de línea propios.

Para que una ruta coincida por nombre de dominio con un destino HTTPS, el cliente debe enviar el
nombre al proxy (`curl --socks4a`, `--socks5-hostname`). Con `--socks4` y `--socks5` curl
resuelve el DNS él mismo y el proxy solo ve la IP (en HTTP en claro la cabecera `Host` conserva
el nombre).

```sh
curl --socks5-hostname 127.0.0.1:1080 -k https://example.com/
curl --socks4a 127.0.0.1:1080 http://example.com/
```

### `auth`

```
proxy {
  listen http 8080
  listen socks5 1080
  auth basic {
    username "alice"
    password "secreto"
  }
  auth basic {
    username "bob"
    password "otra"
  }
}
```

Con `auth` el proxy exige credenciales en **todos** sus `listen`. Cada `auth basic` declara un
usuario (`username` y `password`, ambos textos obligatorios); se repite la directiva para varios
usuarios. `username` no puede contener `:` ni repetirse. Sin `auth` el proxy sigue siendo abierto.
Solo existe el esquema `basic`.

| Listener | Cómo se autentica el cliente | Si falla |
| --- | --- | --- |
| `http` / `https` | Cabecera `Proxy-Authorization: Basic …` (`curl --proxy-user alice:secreto`). En `CONNECT` se comprueba antes de abrir el túnel; las peticiones de ese túnel no la repiten. | `407 Proxy Authentication Required` con `Proxy-Authenticate: Basic realm="donly-proxy", charset="UTF-8"`. Es idéntico si falta la cabecera, el usuario no existe o la contraseña es errónea. |
| `socks5` | Usuario/contraseña de SOCKS5 (RFC 1929; `curl --socks5 alice:secreto@host:1080` o `--proxy-user`). El servidor solo acepta ese método: un cliente que ofrezca solo «sin autenticación» recibe `0xFF`. | Estado `1` en la subnegociación y se cierra la conexión. |
| `socks4` | No soportado (SOCKS4 solo envía un `userid`, sin contraseña): con `auth` el arranque falla. | n/a |

```sh
curl --proxy http://127.0.0.1:8080 --proxy-user alice:secreto http://example.com/
curl -k --proxy http://127.0.0.1:8080 --proxy-user alice:secreto https://example.com/
curl -k --socks5-hostname alice:secreto@127.0.0.1:1080 https://example.com/
```

- La autenticación ocurre **antes** de evaluar las `route`. `Proxy-Authorization` se quita de la
  petición: nunca llega a `proxy_pass`, `command_pass` ni a sus comandos.
- El log no guarda credenciales: la cabecera `proxy-authorization` se registra como
  `"[redacted]"`, la línea `request` lleva `proxy_user` con el usuario y cada intento fallido
  escribe un evento `auth_failed` (ver [`log-format.md`](log-format.md)).
- Basic envía la contraseña en claro: usa `listen https` (o un túnel cifrado) si el proxy no está
  en loopback. La contraseña está en el manifiesto; no lo subas al repositorio.
- Los servidores internos que atienden los túneles escuchan en `127.0.0.1` con puerto aleatorio y no
  piden credenciales: confían en que el cliente ya se autenticó al abrir el túnel.

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

- **Argumentos**: `route` recibe **uno o dos**. Con uno (`route <patrón>`) solo se valida la URL;
  con dos (`route <MÉTODO> <patrón>`) se validan el método y la URL. Más de dos es un error.
- **Método** (opcional): uno de `ACL`, `BIND`, `CHECKOUT`, `COPY`, `DELETE`, `GET`, `HEAD`, `LINK`, `LOCK`, `M-SEARCH`, `MERGE`, `MKACTIVITY`, `MKCALENDAR`, `MKCOL`, `MOVE`, `NOTIFY`, `OPTIONS`, `PATCH`, `POST`, `PROPFIND`, `PROPPATCH`, `PURGE`, `PUT`, `QUERY`, `REBIND`, `REPORT`, `SEARCH`, `SOURCE`, `SUBSCRIBE`, `TRACE`, `UNBIND`, `UNLINK`, `UNLOCK`, `UNSUBSCRIBE` (sin distinguir mayúsculas). `CONNECT` no se puede enrutar. Sin método, la ruta aplica a cualquier método.
- **Patrón**: un [`URLPattern`](https://developer.mozilla.org/docs/Web/API/URLPattern) (estándar
  WHATWG, nativo en Bun) probado contra la **URL completa**, incluidos el esquema, el host, la ruta y
  el query: `https://example.com/a/b?x=1`. Sin esquema es un atajo por host (`example.com`
  equivale a `*://example.com/*`). La ruta debe coincidir completa: usa `*` para prefijos
  (`/api/*`). Ver [detalle](concepts/route.md#patrón).
- **Sin argumentos**: `route { … }` coincide con **todas** las peticiones (HTTP y HTTPS, cualquier
  método). Como gana la primera ruta que coincide, ponla **al final**: las rutas declaradas
  después de ella nunca se alcanzan.
- **Orden**: gana la **primera** ruta que coincida; pon las más específicas arriba.
- **Sin coincidencia**: el proxy responde `200 ok`.
- **Sin ningún `route`**: el proxy reenvía cada petición, sin modificarla, a su propia URL (como si no hubiera proxy).
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

route http{s}?://example.com/* {
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
| `route` con más de dos argumentos, un método que no está en la lista (`GET`, `POST`, `PUT`… cualquiera de `http.METHODS` salvo `CONNECT`) o un patrón que no es texto | error |
| `route` con un patrón vacío o que no es un `URLPattern` válido | error |
| `route` sin exactamente una acción (`respond`, `proxy_pass`, `command_pass`, `kubectl_pass` o `ssh_pass`): cero o dos o más, p. ej. `kubectl_pass` junto a `proxy_pass` | error |
| `respond` con estado fuera de 100–599 o cuerpo que no es un string | error |
| `proxy_pass` que no es una URL `http(s)://` | error |
| `host` o `port` (deprecadas; usa `listen`) | advertencia |
| Directiva desconocida dentro de `proxy`, `ssl` o `route` | advertencia |
| `respond` con argumentos de más | advertencia |
| `route` declarada después de una `route` sin argumentos (inalcanzable) | advertencia |

## Recarga en caliente

El proxy vuelve a leer el manifiesto cuando el archivo cambia (se desactiva con `--no-reload` o
`--no-hot`). Si el nuevo no es válido, sigue con el anterior y muestra
`no se pudo recargar <ruta>: <causa>; se conserva la configuración anterior`. Detalles en
[overview](overview.md#recarga-en-caliente).

## Errores de arranque

| Causa | Mensaje |
| --- | --- |
| `--ui` (CLI) con un manifest sin `log_file` | `--ui requiere log_file en el manifiesto para poder mostrar los logs` |
| `--ui` (CLI) con el puerto ocupado | `no se pudo levantar la ui en 127.0.0.1:<puerto>: EADDRINUSE` |
| `log_file` sin extensión `.ndjson` | `log_file …: solo se soporta la extensión .ndjson` |
| `listen` y `port` a la vez | `listen y port no se pueden declarar a la vez: port es un alias de listen` |
| Dos `listen` con el mismo host y puerto fijo | `listen: <host>:<puerto> está declarado más de una vez` |
| `listen` / `port` sin puerto numérico | `listen: el puerto debe ser un número, no "…"` |
| `listen` / `port` con argumentos de más | `listen: se esperaba [http\|https\|socks4\|socks5] [host] puerto` |
| `route` con más de dos argumentos | `route …: route recibe un patrón o un método y un patrón, hay N argumentos` |
| `route` con un método fuera de la lista | `route …: el método debe ser uno de ACL, BIND, …, no "…"` |
| `route` con un patrón vacío o que no es un `URLPattern` válido | `route …: patrón inválido (…)` |
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
| `ssh_pass` con `host`, `port`, `user`, `identity_file`, `option` o `pass` inválidos | `route …: host debe ser un destino (…), no "…"` / `port debe ser un puerto entre 1 y 65535, no "…"` / `user debe ser un nombre, no "…"` / `identity_file debe ser una ruta, no "…"` / `option debe ser un texto no vacío, …` / `pass debe ser un texto no vacío` |
| `context` / `namespace` fuera de `kubectl_pass` y `command_pass kubectl` | `route …: namespace solo aplica a kubectl_pass y command_pass kubectl` |
| `retry` que no es un entero no negativo, o fuera de `command_pass curl` | `route …: retry debe ser un entero no negativo, no "…"` / `retry solo aplica a command_pass curl` |
| `engine` distinto de `curl` / `node` / `wget`, o usado fuera de `ssh` y `kubectl` | `route …: engine solo soporta …` / `engine solo aplica a command_pass ssh y kubectl` |
| `proxy_pass` con una URL inválida | Error de `URL` |
| `auth` con un esquema distinto de `basic` | `auth: solo se soporta basic (auth basic { username … password … })` |
| `auth basic` sin `username` o `password` | `auth basic: username y password son obligatorios y deben ser textos` |
| `auth basic` con `username` con `:` o repetido | `auth basic: username no puede contener ':' ("…")` / `auth basic: el usuario "…" está declarado más de una vez` |
| `auth` junto a un `listen socks4` | `auth: socks4 no soporta autenticación; usa listen socks5` |
