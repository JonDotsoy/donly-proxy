# `kubectl_pass`

Acción de [`route`](route.md) que **ejecuta la petición dentro de un pod de Kubernetes**. Es la
forma anidada de [`command_pass kubectl`](command_pass.md): la directiva nombra el pod y el
`command_pass` hijo nombra qué comando corre dentro.

```
route https?://api.internal/ {
  kubectl_pass "deploy/api" {
    context dev
    namespace prod
    command_pass curl "--max-time" "5"
  }
}
```

## Idea

Sirve para que la petición **salga desde dentro del clúster**, por ejemplo para llegar a un
Service `ClusterIP` que no está expuesto. El proxy ejecuta
`kubectl exec -i -q <opciones> <destino> -- <comando>`, sin shell local ni terminal.

## Piezas

| Pieza | Descripción |
| --- | --- |
| Argumentos | Opciones de `kubectl exec` seguidas del destino (último): un pod o `tipo/nombre`. Sin destino falla el arranque. |
| `context <nombre>` | Equivale a `--context`; selecciona el cluster. |
| `namespace <nombre>` | Equivale a `--namespace`; selecciona el namespace. |
| `command_pass` hijo | Obligatorio. `curl`, `wget` o `node` (equivale a `engine`); sus argumentos son opciones del comando remoto. |

El `command_pass` hijo admite `concurrency`, `extra_args` y, según el comando, `max_time`,
`insecure`, `retry` o `no_warnings`. El contenedor debe tener lo que el motor necesita
(`sh`, `curl`, `base64`, `mktemp` / `node` / `wget`).

## Reglas

- Un `route` no puede combinar `kubectl_pass` con otra acción.
- Si `kubectl` falla, el cliente recibe `502 bad gateway: kubectl <motor> exited with …`.
- El `log_file` registra el `kubectl exec …` completo en `command`.
- Cada ejecución cierra con **dos** líneas `command_exit` (la del comando remoto y la de `kubectl`)
  que llevan el mismo `exit_code` y `console_log`: la lista ordenada de lo que pasó por la consola
  del `kubectl` local, `[]` si no hubo nada:

  ```json
  {"type":"command_exit","program":"kubectl","exit_code":0,"console_log":[
    {"type":"stdin","message":"<cuerpo o configuración enviada al pod>"},
    {"type":"stdout","message":"<cuerpo de la respuesta>"},
    {"type":"stderr","message":"<cabeceras / avisos de kubectl>"}
  ]}
  ```

  `type` es `stdin`, `stdout` o `stderr`; `message` es el texto de cada trozo. No altera la
  respuesta al cliente.

Ejemplo con dos pods (`conn-pod` entra al clúster y `echo-pod` solo es accesible desde dentro) y
la referencia completa: [`tunnel/command-pass.md`](../tunnel/command-pass.md#kubectl_pass).
