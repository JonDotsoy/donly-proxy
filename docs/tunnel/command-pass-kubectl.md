# `command_pass kubectl` y `kubectl_pass`

Ejecutan la petición **dentro de un pod de Kubernetes** con `kubectl exec`. Son parte de
[`command_pass`](command-pass.md); aquí está el detalle del motor `kubectl`. Hay dos formas
equivalentes:

- [`command_pass kubectl`](#command_pass-kubectl): `kubectl` es el comando y `engine` elige qué se
  ejecuta dentro (`curl`, `node` o `wget`).
- [`kubectl_pass`](#kubectl_pass): acción de la ruta con el `command_pass` hijo como motor.

## Cómo funciona por dentro

- **Setup (al arrancar):** el manifiesto se valida y se precalculan los argumentos de `kubectl exec`:
  las opciones de la línea, `extra_args`, las opciones del motor y los selectores
  `context` / `namespace`, con el destino **siempre al final**. No se lanza nada ni se comprueba
  que `kubectl` exista.
- **Por cada petición:** se espera turno en la cola de [`concurrency`](command-pass.md#concurrencia)
  de la ruta y se lanza **un `kubectl` nuevo** (sin shell, argumentos como lista). No hay sesión ni
  pod persistente: cada petición es un `kubectl exec` independiente.
- **Línea ejecutada:** `kubectl exec -i -q <opciones> <destino> -- <comando remoto>`. El
  `<comando remoto>` se pasa como palabras sueltas tras `--`: `sh -c '<línea fija>'` con los motores
  `curl` y `wget`, y `node [opciones] --input-type=module -` con `node`.
- **stdin:** el proxy escribe todo el stdin de una vez y lo cierra (`-i` lo reenvía al proceso del
  contenedor). Con `curl` y `wget` es el **cuerpo** de la petición; con `node` es el **script** con la
  petición incrustada (ver [`command-pass-node.md`](command-pass-node.md#node-remoto-con-ssh-y-kubectl)).
- **stdout y stderr:** el motor devuelve el resultado como con `ssh`: `curl` deja el cuerpo en
  stdout y `<estado>\n<cabeceras en JSON>` en stderr; `node` devuelve un JSON por stdout; `wget` deja
  el cuerpo en stdout y estado y cabeceras (`-S`) en stderr. `-q` evita que `kubectl` añada avisos.
- **Código de salida:** `kubectl exec` devuelve el código del comando del contenedor. Si es distinto de
  `0` (o `kubectl` falla antes: pod inexistente, sin permisos, sin acceso al clúster) el cliente recibe
  `502 bad gateway`.
- **Log:** además de la `request` y la `response`, el [`log_file`](../manifest.md#log_file) tiene dos
  líneas `command` (primero el `kubectl exec …` completo y luego el comando que corre tras `--`) y dos
  `command_exit` con el mismo código; con `node` también la línea `script`. La `response` incluye
  `command` con el `kubectl exec …`.

## `command_pass kubectl`

Ejecuta la petición **dentro de un pod de Kubernetes** con `kubectl exec`, usando `curl`, `node` o
`wget` como motor. Sirve para que la petición salga desde dentro del clúster (por ejemplo, para llegar
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
kubectl). El `<comando>` es `sh -c '<línea fija>'` con `engine curl` y `engine wget`, y
`node --input-type=module -` con `engine node`.

### `engine`

Igual que en [`ssh`](command-pass-ssh.md#engine): `curl` (por defecto), `node` o `wget`. Lo que debe existir **dentro del
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
`502 bad gateway: kubectl curl exited with <código>: <salida>` (o `kubectl node …` / `kubectl wget …`).

### Pruebas

`src/proxy/tunnel/kubectl/kubectl.test.ts` pone un `kubectl` falso al inicio del `PATH` que registra sus argumentos y
ejecuta localmente lo que va después de `--`. Comprueba ambos motores, el motor por defecto, la
forma exacta de `kubectl exec`, que ningún dato de la petición llega al shell, los errores `502`
y la validación del manifiesto.

## `kubectl_pass`

Forma anidada de [`command_pass kubectl`](#command_pass-kubectl): la directiva nombra el pod y el
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
- `context <nombre>` y `namespace <nombre>` son subdirectivas que seleccionan el cluster y el
  namespace; equivalen a `"--context" "<nombre>" "--namespace" "<nombre>"` y se añaden después de
  las opciones de la línea y antes del destino:

  ```
  route https?://api.internal/ {
    kubectl_pass "deploy/api" {
      context dev
      namespace prod
      command_pass curl
    }
  }
  ```

  El valor debe ser un nombre (texto no vacío); con otro (`namespace 5`, `context ""`) el
  arranque falla con `namespace debe ser un nombre` / `context debe ser un nombre`.
  Lo mismo vale para [`command_pass kubectl`](#command_pass-kubectl); con otro comando falla con
  `namespace solo aplica a kubectl_pass y command_pass kubectl`.
- Debe tener un `command_pass` hijo con `curl`, `wget` o `node` (equivale a `engine`); con otro
  comando, o sin hijo, el arranque falla. Sus argumentos son **opciones adicionales del comando
  remoto** (`curl`: tras los flags fijos; `wget`: antes de la URL; `node`: antes del script, sin
  espacios). Siguen las mismas reglas de `engine` (`wget` solo GET y POST).
- [`concurrency`](command-pass.md#concurrencia) va dentro del `command_pass` hijo.
- Un `route` no puede combinar `kubectl_pass` con otra acción.
- El `log_file` registra el `kubectl exec …` completo, igual que con `command_pass kubectl`.

### Ejemplo: dos pods (`conn-pod` y `echo-pod`)

`src/proxy/tunnel/kubectl/two-pods/pods.yaml` despliega dos pods: `conn-pod` (el pod al que
entra `kubectl_pass`) y `echo-pod` (recibe la petición y escribe una línea JSON por cada una;
se ve con `kubectl logs echo-pod`). `echo-pod` solo tiene un Service `ClusterIP`: no está
expuesto, solo es accesible desde dentro del cluster, es decir, desde `conn-pod`. Los nombres de
Kubernetes no admiten `_`, por eso son `conn-pod` y `echo-pod`.

```
route {
  kubectl_pass "conn-pod" {
    context kind-kind-cluster
    namespace donly-proxy-two-pods
    command_pass node
  }
}
```

Un `fetch` directo a `http://echo-pod.donly-proxy-two-pods.svc.cluster.local/` falla; el mismo
`fetch` a través del proxy llega a `echo-pod` por `conn-pod`. El test está en
`src/proxy/tunnel/kubectl/two-pods/` y necesita el cluster `kind-kind-cluster` (si no, se omite).
