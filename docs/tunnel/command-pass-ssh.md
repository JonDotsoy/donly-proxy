# `command_pass ssh` y `ssh_pass`

Ejecutan la petición **en otra máquina** por `ssh`, con `curl`, `node` o `wget` como motor remoto.
Son parte de [`command_pass`](command-pass.md) (ver su
[ciclo de vida](command-pass.md#ciclo-de-vida-setup-ejecución-y-stdin)). Hay dos formas
equivalentes: [`command_pass ssh`](#command_pass-ssh) y [`ssh_pass`](#ssh_pass).

## `command_pass ssh`

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

Detalle del motor en [`command-pass-wget.md`](command-pass-wget.md). `engine wget` solo puede hacer **GET y POST** (un cuerpo implica POST; el cuerpo se pasa a
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

La respuesta se interpreta igual que con el motor local (ver [curl](command-pass-curl.md) y [node](command-pass-node.md)). Si
ssh falla (conexión rechazada, autenticación, motor no instalado en el remoto…) el cliente
recibe `502 bad gateway: ssh curl exited with <código>: <salida>` (o `ssh node …` / `ssh wget …`).

### Pruebas

`src/proxy/tunnel/ssh/ssh.test.ts` pone un `ssh` falso al inicio del `PATH` que registra sus argumentos y ejecuta
localmente el comando remoto con `sh -c`, tal como lo haría el shell del host remoto. Comprueba
ambos motores, el motor por defecto, la forma de la línea de comandos de ssh, que ningún dato de
la petición (incluidas comillas y `$(…)` maliciosos) llega al shell, los errores `502` y la
validación del manifiesto.

## `ssh_pass`

Forma anidada de [`command_pass ssh`](#command_pass-ssh), igual que [`kubectl_pass`](command-pass-kubectl.md#kubectl_pass): la
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
