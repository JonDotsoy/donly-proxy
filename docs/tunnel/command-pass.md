# `command_pass`

Pasa la petición a un comando externo, que la ejecuta contra su URL original. Comandos
soportados: [`curl`](#curl), [`node`](#node), [`ssh`](#ssh) y [`kubectl`](#kubectl).

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
siguientes, opcionales, son **opciones adicionales del comando**, una por cadena. Directivas
hijas opcionales: [`concurrency`](#concurrencia), [`max_time`](#tiempo-máximo-con-curl) (solo `curl`) y, con `ssh` / `kubectl`, [`engine`](#engine).

En ambos casos el comando se lanza **sin shell** (los argumentos van como lista), se busca en el
`PATH`, y si falla, no está instalado o no devuelve una respuesta válida el proxy contesta
`502 bad gateway: <comando> exited with <código>: <salida>`. Las cabeceras de conexión, `host`,
`content-length` y `content-encoding` no se devuelven al cliente.

## Registro del comando

Si hay [`log_file`](../manifest.md#log_file), la línea `response` de cada transacción con
`command_pass` incluye `command`: la lista con el programa y todos sus argumentos tal como se
ejecutó (`curl …`, `node …`, `ssh …` o `kubectl …`). Se registra también cuando el comando falla
y la respuesta es un `502`. El cuerpo de la petición (stdin) no forma parte de `command`.

```json
{"type":"response","status":200,"command":["curl","--silent","--compressed","--proto","=http,https","…","--url","http://example.com/"],"headers":{…},"payload":"…"}
```

## Tiempo máximo con curl

`max_time <segundos>` es una directiva hija de `command_pass curl` equivalente a pasar
`"--max-time" "<segundos>"`:

```
route https?://example.com/ {
  command_pass curl {
    max_time 5
  }
}
```

- El valor debe ser un **número positivo** (admite decimales, p. ej. `2.5`); con otro (`0`,
  negativo, texto o una cadena entre comillas) el arranque falla con
  `max_time debe ser un número positivo`.
- Solo aplica a `curl`; con otro comando el arranque falla con
  `max_time solo aplica a command_pass curl`.
- Va después de los argumentos de la propia línea (`command_pass curl "--insecure" { … }`) y
  también se puede usar en el `command_pass curl` hijo de `kubectl_pass`.

## Concurrencia

Por defecto, cada `command_pass` ejecuta **un solo proceso a la vez**: si llegan más peticiones a
la misma ruta mientras hay un proceso en curso, esperan en una cola y se atienden en **orden de
llegada**. Para permitir varios procesos en paralelo, usa la directiva hija `concurrency`:

```
route https?://example.com/ {
  command_pass curl {
    concurrency 4
  }
}
```

- El valor debe ser un **entero positivo**; con otro (`0`, negativo, decimal, texto) el arranque
  falla con `concurrency debe ser un entero positivo`.
- El límite es **por ruta**: cada `route` con `command_pass` tiene su propia cola y su propio
  límite (rutas distintas no se bloquean entre sí). Vale para todos los comandos (`curl`, `node`,
  `ssh`, `kubectl`).
- No hay límite de espera: las peticiones en cola esperan hasta que se libera un lugar.
- Un proceso que falla (o responde `502`) libera su lugar igual que uno que termina bien.
- `proxy_pass` y `respond` no se ven afectados.

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

`src/proxy/tunnel/curl/curl.test.ts` coloca un `curl` falso (un script `.sh`) al inicio del `PATH` y comprueba que
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

Ejecuta `node <argumentos del manifiesto> src/proxy/tunnel/node/node-request.mjs`. Los argumentos del manifiesto
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

`src/proxy/tunnel/node/node.test.ts` pone un `node` que registra sus argumentos y ejecuta el node real al inicio
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

Directiva hija de `command_pass` (válida con `ssh` y [`kubectl`](#kubectl)) que elige qué
ejecuta el host remoto:

| `engine` | En el host remoto se ejecuta | Requiere en el remoto |
| --- | --- | --- |
| `curl` (por defecto) | `curl` con la petición | `curl`, `base64`, `mktemp`, `sh` |
| `node` | `node` con el mismo script que [`command_pass node`](#node) (`http.request` / `https.request`) | `node` |
| `wget` | `wget -q -S -O -` (el estado y las cabeceras salen por stderr) | `wget` (BusyBox o GNU), `mktemp`, `cat`, `sh` |

`engine` solo se admite con `ssh` y `kubectl`; con un valor distinto de `curl` / `node` / `wget`, o con
otro comando, el arranque falla.

`engine wget` solo puede hacer **GET y POST** (un cuerpo implica POST; el cuerpo se pasa a
`--post-file` por un archivo temporal): cualquier otro método responde `502 bad gateway`. `wget`
no descomprime ni entrega el cuerpo de las respuestas `4xx` / `5xx`; el proxy devuelve igualmente
su estado y cabeceras, con el cuerpo vacío.

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

`src/proxy/tunnel/ssh/ssh.test.ts` pone un `ssh` falso al inicio del `PATH` que registra sus argumentos y ejecuta
localmente el comando remoto con `sh -c`, tal como lo haría el shell del host remoto. Comprueba
ambos motores, el motor por defecto, la forma de la línea de comandos de ssh, que ningún dato de
la petición (incluidas comillas y `$(…)` maliciosos) llega al shell, los errores `502` y la
validación del manifiesto.

## kubectl

Ejecuta la petición **dentro de un pod de Kubernetes** con `kubectl exec`, usando `curl` o `node`
como motor. Sirve para que la petición salga desde dentro del clúster (por ejemplo, para llegar
a un servicio interno).

```
route https?://api.internal/ {
  command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
    engine curl
  }
}
```

### Argumentos

Los argumentos después de `kubectl` son **opciones de `kubectl exec` seguidas del destino**, que
debe ser el **último**: un pod (`api-0`) o `tipo/nombre` (`deploy/api`, `pod/api-0`). Sin
destino el arranque falla. Opciones útiles: `-n <namespace>`, `--context <ctx>`,
`-c <contenedor>`, `--kubeconfig <ruta>`.

El proxy ejecuta:

```
kubectl exec -i -q <opciones> <destino> -- <comando>
```

sin shell local ni terminal (`-i` para pasar stdin, `-q` para suprimir los avisos de
kubectl). El `<comando>` es `sh -c '<línea fija>'` con `engine curl`, y
`node --input-type=module -` con `engine node`.

### `engine`

Igual que en [`ssh`](#engine): `curl` (por defecto), `node` o `wget`. Lo que debe existir **dentro del
contenedor**:

| `engine` | Requiere en el contenedor |
| --- | --- |
| `curl` | `sh`, `curl`, `base64` y `mktemp` |
| `node` | `node` |
| `wget` | `sh`, `wget`, `mktemp` y `cat` |

### Seguridad

Aplican las mismas garantías que con `ssh`: ningún dato de la petición (URL, cabeceras, cuerpo)
se escribe en la línea de comandos; la configuración viaja en base64 y el cuerpo por stdin.

### Respuesta y errores

Se interpreta igual que con `ssh`. Si `kubectl` falla (pod inexistente, sin permisos, sin
conexión al clúster, motor no instalado en la imagen…) el cliente recibe
`502 bad gateway: kubectl curl exited with <código>: <salida>` (o `kubectl node …`).

### Pruebas

`src/proxy/tunnel/kubectl/kubectl.test.ts` pone un `kubectl` falso al inicio del `PATH` que registra sus argumentos y
ejecuta localmente lo que va después de `--`. Comprueba ambos motores, el motor por defecto, la
forma exacta de `kubectl exec`, que ningún dato de la petición llega al shell, los errores `502`
y la validación del manifiesto.

Ver también: [`proxy_pass`](proxy-pass.md), [referencia del manifiesto](../manifest.md).

## kubectl_pass

Forma anidada de [`command_pass kubectl`](#kubectl): la directiva nombra el pod y el
`command_pass` hijo nombra **qué comando se ejecuta dentro** (`curl`, `wget` o `node`), con sus
opciones.

```
route https?://api.internal/ {
  kubectl_pass "-n" "prod" "--context" "dev" "deploy/api" {
    command_pass curl "--max-time" "5"
  }
}
```

- Los argumentos de `kubectl_pass` son los de `command_pass kubectl`: opciones de
  `kubectl exec` seguidas del destino (último). Sin destino, el arranque falla.
- Debe tener un `command_pass` hijo con `curl`, `wget` o `node` (equivale a `engine`); con otro
  comando, o sin hijo, el arranque falla. Sus argumentos son **opciones adicionales del comando
  remoto** (`curl`: tras los flags fijos; `wget`: antes de la URL; `node`: antes del script, sin
  espacios). Siguen las mismas reglas de `engine` (`wget` solo GET y POST).
- [`concurrency`](#concurrencia) va dentro del `command_pass` hijo.
- Un `route` no puede combinar `kubectl_pass` con otra acción.
- El `log_file` registra el `kubectl exec …` completo, igual que con `command_pass kubectl`.
