# `command_pass`

Pasa la petición a un comando externo, que la ejecuta contra su URL original. Comandos
soportados: [`curl`](#curl), [`node`](command-pass-node.md), [`ssh`](#ssh) y [`kubectl`](command-pass-kubectl.md). Las formas
anidadas [`ssh_pass`](#ssh_pass) y [`kubectl_pass`](command-pass-kubectl.md#kubectl_pass)
también aceptan `wget` como comando remoto.

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
hijas opcionales: [`concurrency`](#concurrencia), [`extra_args`](#argumentos-extra), [`insecure`](#certificados-inseguros-con-curl), [`no_warnings`](command-pass-node.md#sin-avisos-no_warnings) (solo `node`), [`max_time`](#tiempo-máximo-con-curl) y [`retry`](#reintentos-con-curl) (solo `curl`) y, con `ssh` / `kubectl`, [`engine`](#engine).

En todos los casos el comando se lanza **sin shell** (los argumentos van como lista), se busca en el
`PATH`, y si falla, no está instalado o no devuelve una respuesta válida el proxy contesta
`502 bad gateway: <comando> exited with <código>: <salida>`. Las cabeceras de conexión, `host`,
`content-length` y `content-encoding` no se devuelven al cliente. Con `curl` y `node` el cuerpo de la
petición va por stdin.

## Ciclo de vida: setup, ejecución y stdin

`command_pass` **no mantiene ningún proceso vivo ni abre una sesión**: no hay una fase de setup
previa ni se "envían comandos" a un proceso en marcha. Cada petición lanza un proceso nuevo,
le entrega todos los datos de una vez y espera a que termine.

### Setup (al arrancar)

Al leer el manifiesto (`loadConfig`) el proxy valida cada ruta y **precalcula la lista de
argumentos** del comando. No lanza nada ni comprueba que el programa exista. Esa lista se arma en
este orden:

1. Los argumentos de la línea `command_pass` (o de `kubectl_pass` / `ssh_pass`).
2. `extra_args`, `no_warnings`, `insecure`, `max_time` y `retry`.
3. Solo en `kubectl` / `ssh`: `context` / `namespace` (o `port` / `user` de `ssh_pass`) y, al final,
   el **destino**, que siempre queda último.

También se crea la cola de [`concurrency`](#concurrencia) de la ruta (un semáforo con ese límite).

### Por cada petición

1. El proxy lee el cuerpo completo en memoria y busca la ruta.
2. Espera un lugar en la cola de la ruta (en orden de llegada).
3. Construye el comando final con los datos de la petición (ver la tabla de abajo) y lo lanza
   **sin shell** (`spawn` con `argv` como lista y stdin, stdout y stderr por pipes). Antes de
   lanzarlo escribe la línea `command` en el [`log_file`](../manifest.md#log_file).
4. Escribe **todo el stdin de una vez y lo cierra**: el proceso lo lee hasta el final y ya no
   recibe nada más. Mientras tanto acumula stdout y stderr completos.
5. Cuando el proceso termina (evento `close`) registra `command_exit` con su código de salida,
   interpreta stdout y stderr según el motor y libera el lugar de la cola, haya salido bien o no.
6. Si el proceso no se pudo lanzar (no está instalado), terminó con un código distinto de `0` o su
   salida no es una respuesta válida, el cliente recibe `502 bad gateway: <comando> exited with
   <código>: <salida>`.

No hay tiempo máximo propio: si el comando no termina, la petición queda esperando (usa
[`max_time`](#tiempo-máximo-con-curl) con `curl`, o las opciones del comando).

### Qué va por stdin, stdout y stderr

| Motor | Línea de comandos | stdin | stdout | stderr |
| --- | --- | --- | --- | --- |
| `curl` (local) | `curl <flags fijos> --request <M> --header … <argumentos> --url <URL>` | el cuerpo, solo si no está vacío (`--data-binary @-`) | el cuerpo de la respuesta | `<estado>\n<cabeceras en JSON>` |
| `node` (local) | `node <argumentos> …/node-request.mjs` | JSON `{ method, url, headers, body }` (cuerpo en base64) | JSON `{ status, headers, body }` (cuerpo en base64) | el motivo del fallo (con código `1`) |
| `ssh` + `curl` | `ssh <opciones> -T -q -o BatchMode=yes <host> '<comando remoto>'` | el cuerpo | el cuerpo | `<estado>\n<cabeceras en JSON>` |
| `ssh` + `node` | `ssh … <host> 'node [opciones] --input-type=module -'` | el script de node con la petición incrustada | JSON `{ status, headers, body }` | el motivo del fallo |
| `ssh` + `wget` | `ssh … <host> '<comando remoto>'` | el cuerpo | el cuerpo | estado y cabeceras (`wget -S`) |
| `kubectl` | `kubectl exec -i -q <opciones> <destino> -- <comando>` | igual que `ssh`, según el motor | igual que `ssh` | igual que `ssh` |

### Cómo llega la petición al comando remoto

Con `ssh` y `kubectl` el comando remoto es **texto fijo**; la URL, las cabeceras y el cuerpo
nunca se escriben en él:

- **`curl`**: la línea es `d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && printf %s '<base64>' | base64 -d > "$d/c" && curl -K "$d/c" <flags fijos>`. El base64 es un archivo de configuración de curl con `url`, `request` y una línea `header` por cabecera. Se escribe en un directorio temporal que se borra al terminar, y el **cuerpo viaja por stdin** (`--data-binary @-`).
- **`wget`**: `d=$(mktemp -d) && trap … && cat > "$d/b" && wget -q -S -O - <cabeceras y opciones citadas> [--post-file "$d/b"] '<URL>'`. El cuerpo de stdin se guarda en un archivo temporal porque `--post-file` necesita un archivo; las cabeceras, opciones y la URL se citan como una sola palabra de shell.
- **`node`**: el comando es `node [opciones] --input-type=module -` y node lee su programa de **stdin**: una primera línea que asigna a `globalThis.__donlyRequest` la petición (JSON en base64) seguida del código de `node-request.mjs`. Detalle en [`command-pass-node.md`](command-pass-node.md#node-remoto-con-ssh-y-kubectl).

Con `ssh_pass` y `pass`, la contraseña no va por stdin ni por `argv`: se pasa en la variable de
entorno `DONLY_SSH_PASSWORD` y `ssh` la obtiene de un programa `SSH_ASKPASS` temporal.

## Registro del comando

Si hay [`log_file`](../manifest.md#log_file), la línea `response` de cada transacción con
`command_pass` incluye `command`: la lista con el programa y todos sus argumentos tal como se
ejecutó (`curl …`, `node …`, `ssh …` o `kubectl …`). Se registra también cuando el comando falla
y la respuesta es un `502`. El cuerpo de la petición (stdin) no forma parte de `command`.

```json
{"type":"response","status":200,"command":["curl","--silent","--compressed","--proto","=http,https","…","--url","http://example.com/"],"headers":{…},"payload":"…"}
```

## Motor `node`

El detalle de `command_pass node` (script, protocolo JSON por stdin/stdout, `no_warnings`, uso remoto y
pruebas) está en su propio documento: [`command-pass-node.md`](command-pass-node.md).

## Motor `kubectl`

`command_pass kubectl` y `kubectl_pass` ejecutan la petición dentro de un pod con `kubectl exec`.
Su detalle (argumentos, `context` / `namespace`, motores, stdin/stdout, errores y pruebas con un
clúster `kind`) está en [`command-pass-kubectl.md`](command-pass-kubectl.md).

## Argumentos extra

`extra_args <valor…>` es una directiva hija que añade opciones al comando, igual que los
argumentos de la línea `command_pass`, pero escritos como valores sueltos:

```
route https?://example.com/ {
  command_pass curl {
    extra_args --foo tar --biz lol
  }
}
```

Curl recibe `--foo tar --biz lol` como cuatro argumentos separados. Los números se pasan como
texto y un valor con espacios o caracteres de shell (`"x-a: b; c"`, `"$(…)"`) sigue siendo **un
solo argumento**: el comando se lanza sin shell.

- `ssh` y `kubectl`: las opciones se insertan **antes del destino** (el último argumento de la
  línea), que sigue siendo el último.
- Orden: primero los argumentos de la línea `command_pass`, luego `extra_args` (en el orden en
  que se declaren), [`no_warnings`](command-pass-node.md#sin-avisos-no_warnings), [`insecure`](#certificados-inseguros-con-curl),
  [`max_time`](#tiempo-máximo-con-curl) y al final [`retry`](#reintentos-con-curl).
- Vale para todos los comandos (`curl`, `node`, `ssh`, `kubectl`) y para el `command_pass` hijo
  de `kubectl_pass`.

## Certificados inseguros con curl

`insecure` es una directiva hija de `command_pass curl` equivalente a pasar `"--insecure"`
(curl no valida el certificado TLS del destino):

```
route https?://example.com/ {
  command_pass curl {
    insecure
  }
}
```

- Sin valor (o `insecure true`) añade `--insecure`; `insecure false` no añade nada.
- Con otro valor el arranque falla con `insecure debe ser true o false`.
- Solo aplica a `curl`; con otro comando falla con `insecure solo aplica a command_pass curl`.
- También se puede usar en el `command_pass curl` hijo de `kubectl_pass`.

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

## Reintentos con curl

`retry <n>` es una directiva hija de `command_pass curl` equivalente a pasar
`"--retry" "<n>"` (curl reintenta hasta `n` veces ante errores transitorios):

```
route https?://example.com/ {
  command_pass curl {
    retry 5
  }
}
```

- El valor debe ser un **entero no negativo** (`0` desactiva los reintentos); con otro (negativo,
  decimal, texto o una cadena entre comillas) el arranque falla con
  `retry debe ser un entero no negativo`.
- Solo aplica a `curl`; con otro comando falla con `retry solo aplica a command_pass curl`.
- También se puede usar en el `command_pass curl` hijo de `kubectl_pass`.

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
- Con `HEAD` no hay cuerpo: se usa `--head --output /dev/null` y no se pasa `--request`.

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

## ssh

Ejecuta la petición **en otra máquina** a través de `ssh`, usando `curl`, `node` o `wget` allí como
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
contraseñas (hay que autenticar con llave o agente). Con [`ssh_pass`](#ssh_pass) y `pass` cambia
`BatchMode=yes` por `NumberOfPasswordPrompts=1`. Las opciones que pongas en el manifiesto
van antes y, para `-o`, ssh respeta la primera que recibe, por lo que pueden sobrescribir esos
valores.

### `engine`

Directiva hija de `command_pass` (válida con `ssh` y [`kubectl`](command-pass-kubectl.md)) que elige qué
ejecuta el host remoto:

| `engine` | En el host remoto se ejecuta | Requiere en el remoto |
| --- | --- | --- |
| `curl` (por defecto) | `curl` con la petición | `curl`, `base64`, `mktemp`, `sh` |
| `node` | `node` con el mismo script que [`command_pass node`](command-pass-node.md) (`http.request` / `https.request`) | `node` |
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

La respuesta se interpreta igual que con el motor local (ver [curl](#curl) y [node](command-pass-node.md)). Si
ssh falla (conexión rechazada, autenticación, motor no instalado en el remoto…) el cliente
recibe `502 bad gateway: ssh curl exited with <código>: <salida>` (o `ssh node …` / `ssh wget …`).

### Pruebas

`src/proxy/tunnel/ssh/ssh.test.ts` pone un `ssh` falso al inicio del `PATH` que registra sus argumentos y ejecuta
localmente el comando remoto con `sh -c`, tal como lo haría el shell del host remoto. Comprueba
ambos motores, el motor por defecto, la forma de la línea de comandos de ssh, que ningún dato de
la petición (incluidas comillas y `$(…)` maliciosos) llega al shell, los errores `502` y la
validación del manifiesto.

## ssh_pass

Forma anidada de [`command_pass ssh`](#ssh), igual que [`kubectl_pass`](command-pass-kubectl.md#kubectl_pass): la
directiva nombra el host y el `command_pass` hijo nombra **qué comando se ejecuta en el host
remoto** (`curl`, `wget` o `node`), con sus opciones.

```
route https?://api.internal/ {
  ssh_pass myserver {
    port 2222
    user deploy
    command_pass curl "--max-time" "5"
  }
}
```

- El **primer argumento es el host**: un nombre de `~/.ssh/config` (`myserver`), un nombre DNS, una
  IP o `usuario@host`. Al ser el que recibe `ssh`, la configuración de `~/.ssh/config` (usuario,
  puerto, llave, `ProxyJump`…) se aplica. Los argumentos que siguen al host son opciones
  adicionales de `ssh` (`ssh_pass myserver "-v" { … }`). La forma anterior, con las opciones
  primero y el destino al final (`ssh_pass "-p" "2222" "user@host" { … }`), sigue funcionando
  cuando el primer argumento empieza por `-`.
- Subdirectivas de conexión (todas opcionales):

  | Subdirectiva | Equivale a | Valor |
  | --- | --- | --- |
  | `port <n>` | `-p <n>` | entero entre 1 y 65535 |
  | `user <nombre>` | `-l <nombre>` | texto no vacío |
  | `pass <contraseña>` | autenticación por contraseña | texto no vacío (o número) |

  Con otro valor el arranque falla con `port debe ser un puerto entre 1 y 65535`,
  `user debe ser un nombre` o `pass debe ser un texto no vacío`.
- **`pass`**: sin él `ssh` corre con `BatchMode=yes` (solo llaves o agente). Con él, la
  contraseña se entrega a `ssh` mediante `SSH_ASKPASS` (`SSH_ASKPASS_REQUIRE=force`, requiere
  OpenSSH 8.4 o superior) con un programa temporal que solo puede usar el dueño y que la lee de
  una variable de entorno: **no aparece en la línea de comandos** ni en el `command` del
  `log_file`. Aun así queda en claro en el manifest: restringe sus permisos y prefiere llaves o
  el agente cuando puedas.
- Debe tener un `command_pass` hijo con `curl`, `wget` o `node` (equivale a `engine`); con otro
  comando, o sin hijo, el arranque falla con `ssh_pass requiere un command_pass hijo`. Sus
  argumentos y subdirectivas (`concurrency`, `extra_args`, `max_time`, `insecure`, `retry`)
  siguen las mismas reglas que en `kubectl_pass`. Sin host, falla con `ssh_pass requiere el destino`.
- Un `route` no puede combinar `ssh_pass` con otra acción.
- El `log_file` registra el `ssh …` completo, igual que con `command_pass ssh`.
