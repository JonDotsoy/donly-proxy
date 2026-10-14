# `kubectl` + `node`: node dentro de un pod

Combinación de [`kubectl`](command-pass-kubectl.md) con el motor [`node`](command-pass-node.md): la
petición la ejecuta un proceso `node` **dentro del contenedor** de un pod, y el script llega por
stdin. Es el motor para imágenes que tienen `node` pero no `curl` ni `wget`.

```
route https?://api.internal/ {
  kubectl_pass "deploy/api" {
    context dev
    namespace prod
    command_pass node "--no-warnings"
  }
}
```

También con la forma directa: `command_pass kubectl "-n" "prod" "deploy/api" { engine node }`.
Requiere únicamente `node` en el contenedor (no `sh`, `base64` ni `mktemp`).

## Qué se ejecuta

```
kubectl exec -i -q <opciones> <destino> -- node [opciones de node] --input-type=module -
```

- Las opciones de la línea, `extra_args`, `context` y `namespace` van como en
  [`command_pass kubectl`](command-pass-kubectl.md#argumentos), con el destino siempre al final de
  la parte de `kubectl`.
- Lo que sigue a `--` es el comando del contenedor, pasado como palabras sueltas (sin shell). Las
  **opciones de node** del `command_pass` hijo (`"--no-warnings"`, `no_warnings`, `extra_args`) van entre
  `node` y `--input-type=module`. Como no hay shell que las separe, **no pueden contener espacios**:
  si alguna los tiene, la petición responde `502` (`node options cannot contain whitespace`).
- `--input-type=module -` hace que node lea su programa de **stdin** como un módulo ES.

## Qué viaja por stdin

El proxy escribe un único bloque de texto y cierra stdin:

1. Una primera línea que asigna la petición a una variable global:
   `globalThis.__donlyRequest = JSON.parse(Buffer.from("<base64>", "base64").toString());`
   El JSON es `{ method, url, headers, body }` con el cuerpo en base64, y se escapa como base64 para
   que ningún dato de la petición se interprete como código.
2. El código completo de `node-request.mjs`, que usa `__donlyRequest` en lugar de leer stdin (cuando
   la variable no existe, lee la petición como JSON de stdin; así funciona el `node` local).

Implicaciones de seguridad de `globalThis.__donlyRequest`: [`SECURITY.md`](../../SECURITY.md#globalthis__donlyrequest).

Como el programa y los datos viajan juntos por el mismo canal, la petición **no aparece en la línea
de comandos** de `kubectl` ni en la del contenedor.

## Qué vuelve

- **stdout:** un JSON `{ status, headers, body }` con el cuerpo en base64. El script descomprime
  `gzip`, `deflate` y `br`, y quita `content-encoding`.
- **stderr y código de salida:** si la petición falla (conexión rechazada, protocolo no soportado…) el
  script escribe el motivo y sale con código `1`.
- `kubectl exec` devuelve el código del proceso del contenedor. Con un código distinto de `0`, o si
  `kubectl` falla antes (pod inexistente, sin permisos, sin acceso al clúster) o stdout no es un JSON
  válido, el cliente recibe `502 bad gateway: kubectl node exited with <código>: <salida>` (o
  `kubectl node returned an invalid response: …`).

## Registro

Entre la `request` y la `response` el [`log_file`](../manifest.md#log_file) tiene, con el mismo
`transaction_id`:

1. `command` del `kubectl exec …` completo.
2. `command` del comando que corre tras `--` (`node … --input-type=module -`).
3. `script` con el texto exacto enviado por stdin (prelude con la petición más el código del script).
4. `command_exit` del proceso del contenedor y `command_exit` de `kubectl`, ambos con el mismo
   `exit_code`.

La `response` incluye `command` con el `kubectl exec …`.

## Ejemplo con dos pods

`kubectl_pass "conn-pod" { … command_pass node }` es el caso de las pruebas: `conn-pod` tiene
`node` y llega por red de clúster a `echo-pod`, que no está expuesto. Ver
[el ejemplo en `command-pass-kubectl.md`](command-pass-kubectl.md#ejemplo-dos-pods-conn-pod-y-echo-pod).

## Pruebas

- `src/proxy/tunnel/kubectl/kubectl.test.ts` usa un `kubectl` falso que ejecuta localmente lo que va
  tras `--`: comprueba que los argumentos son `node --input-type=module -`, que la petición llega
  por stdin y que ningún dato pasa por la línea de comandos.
- `src/proxy/tunnel/kubectl/node/kind.test.ts` y `src/proxy/tunnel/kubectl/two-pods/` lo ejecutan
  contra el clúster `kind-kind-cluster` (si no existe, se omiten).
