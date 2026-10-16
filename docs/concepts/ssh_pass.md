# `ssh_pass`

Acción de [`route`](route.md) que **ejecuta la petición en otra máquina** por `ssh`. Es la forma
anidada de [`command_pass ssh`](command_pass.md): la directiva nombra el host y el
`command_pass` hijo nombra qué comando corre allí.

```
route http{s}?://api.internal/* {
  ssh_pass {
    host "myserver"
    port 2222
    user deploy
    identity_file "./keys/id_ed25519"
    option "StrictHostKeyChecking=accept-new"
    command_pass curl "--max-time" "5"
  }
}
```

## Idea

Sirve para que el tráfico salga desde un host remoto (un bastión, un servidor con otra IP…). Toda
la conexión se declara con subdirectivas. El **host** puede ser un nombre de `~/.ssh/config`, un
DNS, una IP o `usuario@host`, de modo que se aplica la configuración de `ssh` (usuario, puerto,
llave, `ProxyJump`…). También sigue valiendo darlo como primer argumento
(`ssh_pass myserver { … }`); entonces los argumentos que siguen son opciones adicionales de `ssh`.

## Piezas

| Pieza | Equivale a | Valor |
| --- | --- | --- |
| `host <destino>` | el destino de `ssh` | texto no vacío |
| `port <n>` | `-p <n>` | entero entre 1 y 65535 |
| `user <nombre>` | `-l <nombre>` | texto no vacío |
| `identity_file <ruta>` | `-i <ruta>` | texto no vacío; relativa a la carpeta del manifest |
| `option <opción>` | `-o <opción>` | texto no vacío; se puede repetir |
| `extra_args <arg…>` | opciones de `ssh` tal cual | cualquier opción |
| `pass <contraseña>` | autenticación por contraseña | texto no vacío |
| `idle_time <segundos>` | mantiene el `ssh` abierto tras la última petición | número ≥ 0 (admite decimales), por defecto `10`; `0` lo desactiva |
| `command_pass` hijo | `engine` | obligatorio: `curl`, `wget` o `node` |

## Conexión reutilizada

La primera petición abre `ssh <host> sh -s`; las siguientes llegan como stdin a ese mismo proceso,
así que no repiten el handshake ni la autenticación. Tras `idle_time` segundos sin uso (10 por
defecto) el `ssh` se cierra, y la siguiente petición abre uno nuevo. Una petición usa un `ssh` a la
vez: con peticiones simultáneas se abren varios (hasta el `concurrency` de la ruta). En el
`log_file` hay un solo `command_start` y un solo `command_end` por `ssh`, y un `command_stdin` por
petición ([`log-format.md`](../log-format.md)). El protocolo con el `sh` remoto está en
[`tunnel/ssh-session.md`](../tunnel/ssh-session.md). `command_pass ssh` no reutiliza la conexión.

## Autenticación

Sin `pass`, `ssh` corre con `BatchMode=yes`: solo llaves o agente. Con `pass`, la contraseña se
entrega por `SSH_ASKPASS` (OpenSSH 8.4+) con un programa temporal legible solo por el dueño, así
que **no aparece** en la línea de comandos ni en el `command` del `log_file`. Aun así queda en
claro en el manifest: restringe sus permisos y prefiere llaves o el agente.

## Reglas

- Sin destino (ni `host` ni primer argumento) falla con `ssh_pass requiere el destino`; sin `command_pass` hijo, con
  `ssh_pass requiere un command_pass hijo`.
- Un `route` no puede combinar `ssh_pass` con otra acción.
- Ningún dato de la petición pasa por el shell remoto (ver [`command_pass`](command_pass.md)).
- Si `ssh` falla, el cliente recibe `502 bad gateway: ssh <motor> exited with …`.

Referencia completa: [`tunnel/command-pass.md`](../tunnel/command-pass.md#ssh_pass).
