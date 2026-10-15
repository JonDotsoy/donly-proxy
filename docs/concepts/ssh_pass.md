# `ssh_pass`

Acción de [`route`](route.md) que **ejecuta la petición en otra máquina** por `ssh`. Es la forma
anidada de [`command_pass ssh`](command_pass.md): la directiva nombra el host y el
`command_pass` hijo nombra qué comando corre allí.

```
route http{s}?://api.internal/* {
  ssh_pass myserver {
    port 2222
    user deploy
    command_pass curl "--max-time" "5"
  }
}
```

## Idea

Sirve para que el tráfico salga desde un host remoto (un bastión, un servidor con otra IP…). El
primer argumento es el **host**: un nombre de `~/.ssh/config`, un DNS, una IP o `usuario@host`, de
modo que se aplica la configuración de `ssh` (usuario, puerto, llave, `ProxyJump`…). Los
argumentos siguientes son opciones adicionales de `ssh`.

## Piezas

| Pieza | Equivale a | Valor |
| --- | --- | --- |
| `port <n>` | `-p <n>` | entero entre 1 y 65535 |
| `user <nombre>` | `-l <nombre>` | texto no vacío |
| `pass <contraseña>` | autenticación por contraseña | texto no vacío |
| `command_pass` hijo | `engine` | obligatorio: `curl`, `wget` o `node` |

## Autenticación

Sin `pass`, `ssh` corre con `BatchMode=yes`: solo llaves o agente. Con `pass`, la contraseña se
entrega por `SSH_ASKPASS` (OpenSSH 8.4+) con un programa temporal legible solo por el dueño, así
que **no aparece** en la línea de comandos ni en el `command` del `log_file`. Aun así queda en
claro en el manifest: restringe sus permisos y prefiere llaves o el agente.

## Reglas

- Sin host falla con `ssh_pass requiere el destino`; sin `command_pass` hijo, con
  `ssh_pass requiere un command_pass hijo`.
- Un `route` no puede combinar `ssh_pass` con otra acción.
- Ningún dato de la petición pasa por el shell remoto (ver [`command_pass`](command_pass.md)).
- Si `ssh` falla, el cliente recibe `502 bad gateway: ssh <motor> exited with …`.

Referencia completa: [`tunnel/command-pass.md`](../tunnel/command-pass.md#ssh_pass).
