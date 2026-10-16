# `command_pass`

Acción de [`route`](route.md) que **pasa la petición a un comando externo**, el cual la ejecuta
contra su URL original. A diferencia de [`proxy_pass`](proxy_pass.md), la conexión la hace ese
comando, no el proceso del proxy.

```
route https://example.com/ {
  command_pass curl "--max-time" "5"
}
```

## Comandos

| Comando | Dónde sale la petición | Detalle |
| --- | --- | --- |
| `curl` | Local, con el `curl` del `PATH`. | [curl](../tunnel/command-pass.md#curl) |
| `node` | Local, con un proceso `node` (`http.request` / `https.request`). | [node](../tunnel/command-pass.md#node) |
| `ssh` | Un host remoto, con `curl`, `node` o `wget` allí. | [ssh](../tunnel/command-pass.md#ssh) · forma anidada: [`ssh_pass`](ssh_pass.md) |
| `kubectl` | Un pod, vía `kubectl exec`. | [kubectl](../tunnel/command-pass.md#kubectl) · forma anidada: [`kubectl_pass`](kubectl_pass.md) |

El primer argumento es el comando; los siguientes son **opciones adicionales** de ese comando
(una por cadena). Cualquier otro comando hace fallar el arranque con
`command_pass solo soporta "curl", "node", "ssh" y "kubectl", no "…"`. `wget` no es un comando
de `command_pass`: solo existe como `engine` de `ssh` y `kubectl`.

## Dos ejes: cliente HTTP y transporte

`command_pass` mezcla dos decisiones distintas:

- **Cliente HTTP**: quién hace la petición (`curl`, `node` o, solo en remoto, `wget`).
- **Transporte**: dónde se ejecuta ese cliente. Aquí mismo (`curl`, `node`), en un host por `ssh` o
  en un pod por `kubectl`.

Con `curl` y `node` ambas cosas coinciden. Con `ssh` y `kubectl` el comando es el transporte y el
cliente se elige con `engine` (por defecto `curl`).

## Qué forma usar

| Quiero… | Forma | Ejemplo |
| --- | --- | --- |
| Salir desde el propio proceso del proxy con `curl` o `node`. | `command_pass curl` / `command_pass node` | `command_pass curl "--max-time" "5"` |
| Salir desde un host remoto, con el destino como argumento. | `command_pass ssh <opciones…> <destino>` + `engine` | `command_pass ssh "user@gw" { engine node }` |
| Lo mismo, declarando host, puerto, usuario y llave como subdirectivas. | [`ssh_pass`](ssh_pass.md) | `ssh_pass { host "gw" … command_pass curl }` |
| Salir desde un pod, con el destino como argumento. | `command_pass kubectl <opciones…> <destino>` + `engine` | `command_pass kubectl "-n" "prod" "deploy/api" { engine curl }` |
| Lo mismo, eligiendo el pod por nombre o patrón. | [`kubectl_pass`](kubectl_pass.md) | `kubectl_pass { pod_match api-* command_pass curl }` |

`ssh_pass` y `kubectl_pass` son la forma anidada: el motor remoto se escribe como un
`command_pass` hijo (`curl`, `wget` o `node`) en vez de `engine`. Las dos formas ejecutan lo mismo.

> **Ojo:** el `command_pass` hijo solo vale dentro de `ssh_pass` y `kubectl_pass`. Dentro de
> `command_pass ssh` o `command_pass kubectl` hoy **se acepta pero se ignora** (el motor sigue
> siendo `curl`): usa `engine`.

## Orden de los argumentos

El comando recibe, de izquierda a derecha:

1. Los argumentos de la línea `command_pass`.
2. `extra_args`, `no_warnings`, `insecure`, `max_time` y `retry`, en ese orden.
3. Con `kubectl`, los selectores `context` y `namespace` (como `--context` y `--namespace`).
4. Con `ssh` y `kubectl`, el **destino siempre al final**.

Las cabeceras de conexión, `host`, `content-length` y `content-encoding` no viajan.

## Ejemplos

```
# curl local con tiempo máximo y reintentos
route https://api.example.com/* {
  command_pass curl {
    max_time 10
    retry 2
  }
}

# node local, sin avisos
route https://example.com/* {
  command_pass node {
    no_warnings
  }
}

# curl desde un bastión por ssh
route http://internal.example.com/* {
  command_pass ssh "-p" "2222" "user@gateway.example.com" {
    engine curl
  }
}

# node dentro de un pod
route http://api.svc/* {
  command_pass kubectl "-n" "prod" "deploy/api" {
    engine node
    context staging
  }
}
```

## Garantías

- El comando se lanza **sin shell**: los argumentos van como lista.
- Con `ssh` y `kubectl`, ningún dato de la petición (URL, cabeceras, cuerpo) se escribe en la
  línea de comandos remota; la configuración viaja en base64 y el cuerpo por stdin.
- Si el comando falla o no devuelve una respuesta válida, el cliente recibe
  `502 bad gateway: <comando> exited with <código>: <salida>`.
- Con [`log_file`](../manifest.md#log_file), la línea `response` incluye `command` con lo que se
  ejecutó, incluso si falló.
- Con `log_file`, cada programa ejecutado abre con una línea `command_start` (`program`, `args`) y cierra con una línea `command_end` que lleva `exit_code` y
  `console_log`: la lista ordenada de lo que pasó por su consola
  (`{"type":"stdin"|"stdout"|"stderr","timestamp":"…","message":"…"}`; `[]` si no hubo nada). Con `node`, `stdin` es
  el script, `stdout` el JSON del resultado y `stderr` sus avisos. No altera la respuesta al cliente.

## Directivas hijas

| Directiva | Aplica a | Efecto |
| --- | --- | --- |
| `concurrency <n>` | todos | Procesos en paralelo por ruta (por defecto 1, en cola). |
| `extra_args <valor…>` | todos | Opciones adicionales como valores sueltos. |
| `engine curl\|node\|wget` | `ssh`, `kubectl` | Qué se ejecuta en el destino remoto. |
| `insecure`, `max_time <s>`, `retry <n>` | `curl` | Equivalen a `--insecure`, `--max-time`, `--retry`. |
| `no_warnings` | `node` | Equivale a `--no-warnings`. |

Referencia completa: [`tunnel/command-pass.md`](../tunnel/command-pass.md).

## Errores de arranque

| Causa | Mensaje |
| --- | --- |
| Comando que no es `curl`, `node`, `ssh` ni `kubectl`. | `command_pass solo soporta "curl", "node", "ssh" y "kubectl", no "…"` |
| `ssh` o `kubectl` sin destino. | `command_pass ssh requiere el destino (usuario@host)` / `command_pass kubectl requiere el destino (pod o tipo/nombre)` |
| `engine` fuera de `ssh` y `kubectl`. | `engine solo aplica a command_pass ssh y kubectl` |
| `engine` que no es `curl`, `node` ni `wget`. | `engine solo soporta "curl", "node" y "wget", no "…"` |
| `concurrency` que no es un entero positivo. | `concurrency debe ser un entero positivo, no "…"` |
| `insecure`, `max_time` o `retry` fuera de `curl`. | `… solo aplica a command_pass curl` |
| `no_warnings` fuera de `node`. | `no_warnings solo aplica a command_pass node` |

La tabla completa de errores está en [`manifest.md`](../manifest.md#errores-de-arranque).

## Plugins

Cada `command_pass <nombre>` lo atiende un **plugin**: un objeto `CommandPass` con dos métodos.

```ts
new CommandPass({
  start(options) { /* una vez, al montar la ruta: argumentos, motor, selectores */ },
  request(request, context) { /* por petición: Request -> Response */ },
})
```

- `start` recibe lo que dice el manifest (`args`, `engine`, `engineArgs`, `podMatch`, `password`).
- `request` recibe la petición como un `Request` y devuelve un `Response`. `context` trae los
  callbacks que alimentan el `log_file` (`command_start`, `script_start`, `console_log`…).
- Como en un `ReadableStream`, el estado no vive en un `this`: vive en la clausura de la fábrica
  que construye el plugin. **Cada ruta crea su propia instancia**, así que dos rutas no comparten
  estado.

Los plugins se registran en un único objeto, `src/proxy/command-pass/plugins.ts`:

| Plugin | Atiende | Alias |
| --- | --- | --- |
| `curl` | `command_pass curl` | |
| `node` | `command_pass node` | |
| `ssh` | `command_pass ssh` | [`ssh_pass`](ssh_pass.md) |
| `kubectl` | `command_pass kubectl` | [`kubectl_pass`](kubectl_pass.md) |
| `proxy` | un `fetch` directo desde el proceso del proxy | [`proxy_pass`](proxy_pass.md) |

Los alias son otra forma de escribir el mismo plugin: `ssh_pass` y `command_pass ssh` ejecutan
exactamente lo mismo. La sintaxis del manifest no cambia.

`command_pass proxy` **todavía no se acepta** en el manifest: el plugin `proxy` solo se alcanza
con `proxy_pass`.
