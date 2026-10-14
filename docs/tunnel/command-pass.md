# `command_pass`

Pasa la petición a un comando externo, que la ejecuta contra su URL original. Comandos
soportados: [`curl`](command-pass-curl.md), [`node`](command-pass-node.md), [`ssh`](command-pass-ssh.md) y [`kubectl`](command-pass-kubectl.md). Las formas
anidadas [`ssh_pass`](command-pass-ssh.md#ssh_pass) y [`kubectl_pass`](command-pass-kubectl.md#kubectl_pass)
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
hijas opcionales: [`concurrency`](#concurrencia), [`extra_args`](#argumentos-extra), [`insecure`](command-pass-curl.md#certificados-inseguros-insecure), [`no_warnings`](command-pass-node.md#sin-avisos-no_warnings) (solo `node`), [`max_time`](command-pass-curl.md#tiempo-máximo-max_time) y [`retry`](command-pass-curl.md#reintentos-retry) (solo `curl`) y, con `ssh` / `kubectl`, [`engine`](command-pass-ssh.md#engine).

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
[`max_time`](command-pass-curl.md#tiempo-máximo-max_time) con `curl`, o las opciones del comando).

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

## Motores

Cada motor tiene su propio documento:

| Motor | Documento |
| --- | --- |
| `curl` | [`command-pass-curl.md`](command-pass-curl.md): flags fijos, `insecure`, `max_time`, `retry`. |
| `node` | [`command-pass-node.md`](command-pass-node.md): script, protocolo JSON, `no_warnings`. |
| `ssh` / `ssh_pass` | [`command-pass-ssh.md`](command-pass-ssh.md): opciones de `ssh`, `engine`, autenticación y `pass`. |
| `kubectl` / `kubectl_pass` | [`command-pass-kubectl.md`](command-pass-kubectl.md): `kubectl exec`, `context` / `namespace`. Con `node`: [`command-pass-kubectl-node.md`](command-pass-kubectl-node.md). |
| `wget` (solo remoto) | [`command-pass-wget.md`](command-pass-wget.md): GET y POST con `wget` en el destino. |

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
  que se declaren), [`no_warnings`](command-pass-node.md#sin-avisos-no_warnings), [`insecure`](command-pass-curl.md#certificados-inseguros-insecure),
  [`max_time`](command-pass-curl.md#tiempo-máximo-max_time) y al final [`retry`](command-pass-curl.md#reintentos-retry).
- Vale para todos los comandos (`curl`, `node`, `ssh`, `kubectl`) y para el `command_pass` hijo
  de `kubectl_pass`.

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

