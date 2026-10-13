# `command_pass`

Pasa la petición a un comando externo, que la ejecuta contra su URL original. Comandos
soportados: [`curl`](#curl), [`node`](#node) y [`ssh`](#ssh).

```
route http://example.com/ {
  command_pass curl "--max-time" "5"
}

route https://example.com/ {
  command_pass node "--no-warnings"
}

route https://example.com/ {
  command_pass ssh "-p" "2222" "user@gateway.example.com" {
    engine node
  }
}
```

El primer argumento es el comando (cualquier otro hace fallar el arranque). Los argumentos
siguientes, opcionales, son **opciones adicionales del comando**, una por cadena.

En ambos casos el comando se lanza **sin shell** (los argumentos van como lista), se busca en el
`PATH`, y si falla, no está instalado o no devuelve una respuesta válida el proxy contesta
`502 bad gateway: <comando> exited with <código>: <salida>`. Las cabeceras de conexión, `host`,
`content-length` y `content-encoding` no se devuelven al cliente.

## curl

### Qué hace el proxy

Ejecuta `curl` (el que se encuentre en el `PATH`) sin shell, pasando los argumentos como lista:

```
curl --silent --compressed --proto =http,https \
     --write-out '%{stderr}%{response_code}\n%{header_json}' \
     --header 'Expect:' \
     --request <MÉTODO> --output - [--data-binary @-] \
     --header '<nombre>: <valor>' ...   # cabeceras de la petición
     <argumentos del manifiesto> \
     --url <URL completa>
```

- El **método**, las **cabeceras** y el **cuerpo** de la petición se pasan a `curl`. El cuerpo
  viaja por stdin (`--data-binary @-`) y solo si no está vacío. Para `HEAD` se usa `--head`.
- No se reenvían las cabeceras de conexión (`connection`, `keep-alive`, `proxy-connection`,
  `transfer-encoding`, `upgrade`, `te`, `trailer`), `host`, `content-length` ni
  `accept-encoding`: `curl` negocia la codificación con `--compressed`.
- La URL se entrega con `--url`, y `--proto =http,https` restringe los protocolos.
- Las opciones del manifiesto se colocan **antes** de `--url`, por lo que pueden complementar
  la llamada (`--insecure`, `--max-time`, `--connect-to`, `--proxy`, etc.).
- Las redirecciones no se siguen (a menos que agregues `-L`).

### Qué se devuelve al cliente

`curl` entrega el resultado por dos canales, para no mezclar el cuerpo con los metadatos:

| Canal | Contenido |
| --- | --- |
| stdout | Cuerpo de la respuesta (ya descomprimido). |
| stderr | `<código de estado>\n<cabeceras en JSON>` (`%{response_code}` y `%{header_json}`). |

El cliente recibe ese estado, esas cabeceras (sin las de conexión ni `content-encoding`) y ese
cuerpo. Si `curl` termina con error, no está instalado o no produjo un estado, el proxy
responde `502` con `bad gateway: curl exited with <código>: <salida>`.

### Ejemplos

Enviar una URL a otro destino sin cambiar el host de la petición, con `--connect-to`:

```
route http://example.com/ {
  command_pass curl "--connect-to" "example.com:80:127.0.0.1:3000"
}
```

Ignorar certificados inválidos del servidor real:

```
route https://internal.example.com/ {
  command_pass curl "--insecure"
}
```

### Pruebas

`src/curl.test.ts` coloca un `curl` falso (un script `.sh`) al inicio del `PATH` y comprueba que
la petición pasa por él: que recibe la URL, el método, las cabeceras, los argumentos del
manifiesto y el cuerpo, y que su respuesta llega al cliente. Si cambias el contrato con `curl`
(los flags de arriba), ajusta también ese script.

## node

Levanta un proceso `node` que ejecuta la petición con el módulo `http.request` (URL `http://`)
o `https.request` (URL `https://`).

```
route https?://example.com/ {
  command_pass node "--no-warnings"
}
```

### Qué hace el proxy

Ejecuta `node <argumentos del manifiesto> src/node-request.mjs`. Los argumentos del manifiesto
son **opciones de node** y van antes del script (`--no-warnings`, `--use-openssl-ca`, etc.).

El proxy se comunica con el script mediante JSON:

| Canal | Contenido |
| --- | --- |
| stdin | `{ "method", "url", "headers", "body" }`, con el cuerpo en base64. |
| stdout | `{ "status", "headers", "body" }`, con el cuerpo en base64. |
| stderr / código de salida | Si el script falla (conexión rechazada, protocolo no soportado…) escribe el motivo y sale con código `1`. |

- El método, la URL completa, las cabeceras y el cuerpo de la petición se pasan tal cual. Se
  omiten las cabeceras de conexión, `host`, `content-length` y `accept-encoding`; node calcula
  `host` y `content-length` para el destino.
- Si el destino responde comprimido (`gzip`, `deflate` o `br`), el script lo descomprime y
  quita `content-encoding`.
- Las redirecciones no se siguen.
- La verificación TLS la hace node con sus certificados habituales. Para un certificado propio
  puedes usar las variables de entorno de node (`NODE_EXTRA_CA_CERTS`) en el entorno del proxy,
  o la opción `--use-openssl-ca`.

### Pruebas

`src/node.test.ts` pone un `node` que registra sus argumentos y ejecuta el node real al inicio
del `PATH`, y comprueba que el proxy lanza `node --no-warnings …/node-request.mjs`, que la
petición llega a un servidor HTTP y a uno HTTPS con método, cabeceras, ruta, query y cuerpo
correctos, y que un destino caído produce un `502`.

## ssh

Ejecuta la petición **en otra máquina** a través de `ssh`, usando `curl` o `node` allí como
motor. Sirve para que el tráfico salga desde un host remoto (un bastión, un servidor con otra
IP, etc.).

```
route https?://example.com/ {
  command_pass ssh "-p" "2222" "-i" "~/.ssh/id_proxy" "user@gateway.example.com" {
    engine curl
  }
}
```

### Argumentos

Los argumentos después de `ssh` son **opciones de ssh seguidas del destino**, que debe ser el
**último** (`[opciones…] usuario@host`). Sin destino el arranque falla.

El proxy agrega `-T -q -o BatchMode=yes`: sin terminal, sin mensajes de ssh y sin pedir
contraseñas (hay que autenticar con llave o agente). Las opciones que pongas en el manifiesto
van antes y, para `-o`, ssh respeta la primera que recibe, por lo que pueden sobrescribir esos
valores.

### `engine`

Directiva hija de `command_pass` que elige qué ejecuta el host remoto:

| `engine` | En el host remoto se ejecuta | Requiere en el remoto |
| --- | --- | --- |
| `curl` (por defecto) | `curl` con la petición | `curl`, `base64`, `mktemp`, `sh` |
| `node` | `node` con el mismo script que [`command_pass node`](#node) (`http.request` / `https.request`) | `node` |

`engine` solo se admite con `ssh`; con otro valor distinto de `curl` / `node`, o con otro
comando, el arranque falla.

### Seguridad: los datos de la petición no pasan por el shell remoto

ssh entrega el comando remoto a un shell, así que la URL, las cabeceras y el cuerpo (que
controla el cliente) **nunca** se escriben en esa línea de comandos:

- `engine curl`: el comando remoto es fijo salvo un literal en base64; contiene la
  configuración de curl (`url`, `request`, `header`, escapada para `curl -K`). Se escribe a un
  archivo temporal que se borra al terminar, y el cuerpo viaja por stdin.
- `engine node`: el comando remoto es `node --input-type=module -`. Por stdin llega el script
  precedido de una línea que carga la petición desde un literal en base64.

Cabeceras con caracteres de control se rechazan (`502`).

### Respuesta y errores

La respuesta se interpreta igual que con el motor local (ver [curl](#curl) y [node](#node)). Si
ssh falla (conexión rechazada, autenticación, motor no instalado en el remoto…) el cliente
recibe `502 bad gateway: ssh curl exited with <código>: <salida>` (o `ssh node …`).

### Pruebas

`src/ssh.test.ts` pone un `ssh` falso al inicio del `PATH` que registra sus argumentos y ejecuta
localmente el comando remoto con `sh -c`, tal como lo haría el shell del host remoto. Comprueba
ambos motores, el motor por defecto, la forma de la línea de comandos de ssh, que ningún dato de
la petición (incluidas comillas y `$(…)` maliciosos) llega al shell, los errores `502` y la
validación del manifiesto.

Ver también: [`proxy_pass`](proxy-pass.md), [referencia del manifiesto](../manifest.md).
