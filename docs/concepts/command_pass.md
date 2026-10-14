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
| `curl` | Local, con el `curl` del `PATH`. | [curl](../tunnel/command-pass-curl.md) |
| `node` | Local, con un proceso `node` (`http.request` / `https.request`). | [node](../tunnel/command-pass-node.md) |
| `ssh` | Un host remoto, con `curl`, `node` o `wget` allí. | [ssh](../tunnel/command-pass-ssh.md) · forma anidada: [`ssh_pass`](ssh_pass.md) |
| `kubectl` | Un pod, vía `kubectl exec`. | [kubectl](../tunnel/command-pass-kubectl.md) · forma anidada: [`kubectl_pass`](kubectl_pass.md) |

El primer argumento es el comando; los siguientes son **opciones adicionales** de ese comando
(una por cadena). Cualquier otro comando hace fallar el arranque.

## Garantías

- El comando se lanza **sin shell**: los argumentos van como lista.
- Con `ssh` y `kubectl`, ningún dato de la petición (URL, cabeceras, cuerpo) se escribe en la
  línea de comandos remota; la configuración viaja en base64 y el cuerpo por stdin.
- Si el comando falla o no devuelve una respuesta válida, el cliente recibe
  `502 bad gateway: <comando> exited with <código>: <salida>`.
- Con [`log_file`](../manifest.md#log_file), la línea `response` incluye `command` con lo que se
  ejecutó, incluso si falló.

## Directivas hijas

| Directiva | Aplica a | Efecto |
| --- | --- | --- |
| `concurrency <n>` | todos | Procesos en paralelo por ruta (por defecto 1, en cola). |
| `extra_args <valor…>` | todos | Opciones adicionales como valores sueltos. |
| `engine curl\|node\|wget` | `ssh`, `kubectl` | Qué se ejecuta en el destino remoto. |
| `insecure`, `max_time <s>`, `retry <n>` | `curl` | Equivalen a `--insecure`, `--max-time`, `--retry`. |
| `no_warnings` | `node` | Equivale a `--no-warnings`. |

Referencia completa: [`tunnel/command-pass.md`](../tunnel/command-pass.md).
