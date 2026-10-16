# `ssh_pass`: el handshake de la conexión reutilizada

Con [`idle_time`](../concepts/ssh_pass.md#conexión-reutilizada) mayor que 0, `ssh_pass` no lanza un
`ssh` por petición. Mantiene un proceso `ssh <host> sh -s` abierto y le habla por stdin. Esta página
describe ese "handshake" entre el proxy y el `sh` remoto. Es un detalle interno: no hay nada que
configurar, salvo `idle_time`.

Implementación: `SshSessions` en `src/proxy/tunnel/ssh/ssh.ts`.

## Ciclo de vida

1. **Apertura.** La primera petición (o cualquiera sin sesión libre para el mismo host, opciones y
   contraseña) lanza `ssh <opciones> -T -q -o BatchMode=yes <host> sh -s`. Con `pass` usa
   `NumberOfPasswordPrompts=1` y `SSH_ASKPASS` en lugar de `BatchMode`. El `log_file` registra un
   `command_start`.
2. **Peticiones.** Cada petición escribe un script en el stdin de ese proceso (ver abajo) y espera
   su línea de respuesta. Una sesión atiende una petición a la vez; si llegan varias a la vez, se
   abren más sesiones. Cada envío deja una línea `command_stdin` en el log.
3. **Inactividad.** Al terminar una petición arranca un temporizador de `idle_time` segundos. Una
   petición nueva lo cancela.
4. **Cierre.** Vencido el temporizador, o al cerrar el proxy, el proxy cierra el stdin del
   proceso: `sh` ve fin de entrada, sale y `ssh` termina. El `log_file` registra el `command_end`
   con el código de salida y lo que `ssh` escribió por stderr (avisos de conexión, errores). Si
   el proceso muere antes, la petición en curso recibe `502` con `ssh exited with <código>: …`, y
   la siguiente abre una sesión nueva.

## Qué se envía por petición

El motor (`curl`, `wget` o `node`) arma, igual que sin sesión, su línea de comandos remota y su
stdin (el cuerpo de la petición, o el script de `node`). El proxy los envuelve en un script de
`sh`, con un `id` aleatorio de 24 hex por petición:

```sh
e=$(mktemp) && o=$(mktemp) && {
base64 -d <<'DONLY_<id>' | ( <comando del motor> ) > "$o" 2> "$e"
<stdin del motor en base64, en líneas de 76 columnas>
DONLY_<id>
c=$?; printf '%s %s ' '@@<id>' "$c"; base64 < "$o" | tr -d '\n'; printf ' '; base64 < "$e" | tr -d '\n'; printf '\n'; rm -f "$o" "$e"
}
```

- El stdin va en base64 dentro de un *here-document* con delimitador entrecomillado: ningún dato de
  la petición pasa por el shell, igual que en el modo de un `ssh` por petición. Funciona con
  cuerpos binarios.
- El comando corre en un subshell `( … )`: sus `trap` (la limpieza de `mktemp` de `curl` y `wget`)
  se ejecutan al terminar y no afectan al `sh` de la sesión.
- La salida y el error del motor se guardan en dos archivos temporales, para devolverlos
  por separado.

## Respuesta enmarcada

El `sh` remoto contesta con **una sola línea** por stdout:

```
@@<id> <código> <stdout en base64> <stderr en base64>
```

| Campo | Contenido |
| --- | --- |
| `@@<id>` | Marca de la petición. El proxy ignora todo lo que llegue antes de ella. |
| `<código>` | Código de salida del motor (`$?` del subshell). |
| `<stdout en base64>` | El cuerpo de la respuesta del motor; vacío si no hubo. |
| `<stderr en base64>` | La metadata del motor (estado y cabeceras de `curl`, bloque `-S` de `wget`); vacío si no hubo. |

Los campos van separados por un espacio, y base64 nunca lo contiene. Al recibir la línea completa
el proxy interpreta `código`, `stdout` y `stderr` igual que cuando el proceso es local, y el motor
produce la respuesta o un `502`.

## Requisitos del host remoto

`sh` (POSIX), `mktemp`, `base64` (con `-d`) y `tr`, además del motor (`curl`, `wget` o `node`).
`curl` y `wget` ya necesitaban `mktemp` y `base64`.

## Qué no cambia

- `command_pass ssh` (la forma plana) sigue usando un `ssh` por petición.
- Con `idle_time 0`, `ssh_pass` también.
- Los argumentos de `ssh` siguen siendo una lista, nunca una cadena de shell.
