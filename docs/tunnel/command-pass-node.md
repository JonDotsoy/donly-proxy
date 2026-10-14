# `command_pass node`

Pasa la petición a un proceso `node` que la ejecuta con `http.request` (URL `http://`) o
`https.request` (URL `https://`). Es parte de [`command_pass`](command-pass.md); aquí está solo el
detalle del motor `node`.

```
route https?://example.com/ {
  command_pass node "--no-warnings"
}
```

## Qué hace el proxy

Ejecuta `node <argumentos del manifiesto> src/proxy/tunnel/node/node-request.mjs`. Los argumentos del manifiesto
son **opciones de node** y van antes del script (`--no-warnings`, `--use-openssl-ca`, etc.).

El proxy se comunica con el script mediante JSON:

| Canal | Contenido |
| --- | --- |
| stdin | `{ "method", "url", "headers", "body" }`, con el cuerpo en base64. |
| stdout | `{ "status", "headers", "body" }`, con el cuerpo en base64. |
| stderr / código de salida | Si el script falla (conexión rechazada, protocolo no soportado…) escribe el motivo y sale con código `1`. |

- El método, la URL completa, las cabeceras y el cuerpo de la petición se pasan tal cual. Se
  omiten las cabeceras de conexión, `host`, `content-length` y `accept-encoding`; node calcula
  `host` y `content-length` para el destino.
- Si el destino responde comprimido (`gzip`, `deflate` o `br`), el script lo descomprime y
  quita `content-encoding`.
- Las redirecciones no se siguen.
- La verificación TLS la hace node con sus certificados habituales. Para un certificado propio
  puedes usar las variables de entorno de node (`NODE_EXTRA_CA_CERTS`) en el entorno del proxy,
  o la opción `--use-openssl-ca`.

## Pruebas

`src/proxy/tunnel/node/node.test.ts` pone un `node` que registra sus argumentos y ejecuta el node real al inicio
del `PATH`, y comprueba que el proxy lanza `node --no-warnings …/node-request.mjs`, que la
petición llega a un servidor HTTP y a uno HTTPS con método, cabeceras, ruta, query y cuerpo
correctos, y que un destino caído produce un `502`.

## Sin avisos (`no_warnings`)

`no_warnings` es una directiva hija de `command_pass node` equivalente a pasar
`"--no-warnings"` (node no imprime avisos de proceso, como los de módulos experimentales):

```
route https?://example.com/ {
  command_pass node {
    no_warnings
  }
}
```

- Sin valor (o `no_warnings true`) añade `--no-warnings`; `no_warnings false` no añade nada.
- Con otro valor el arranque falla con `no_warnings debe ser true o false`.
- Solo aplica a `node`; con otro comando falla con `no_warnings solo aplica a command_pass node`.
- Va tras los argumentos de la línea y `extra_args`, antes de `insecure` y `max_time`. También se
  puede usar en el `command_pass node` hijo de `kubectl_pass` y `ssh_pass`.

## Node remoto con `ssh` y `kubectl`

Con `engine node` ([`ssh`](command-pass.md#ssh), [`kubectl`](command-pass.md#kubectl),
`ssh_pass`, `kubectl_pass`) se usa el mismo script, pero el proceso corre en el host o el contenedor
remoto y el script **viaja por stdin**:

- El comando remoto es `node [opciones] --input-type=module -`. Como se pasa como palabras sueltas,
  las opciones de node no pueden contener espacios (si no, la petición falla con `502`).
- stdin contiene una primera línea que asigna `globalThis.__donlyRequest` con la petición (JSON en
  base64) seguida del código de `node-request.mjs`. El script usa esa variable en lugar de leer
  stdin.
- La respuesta vuelve igual que en local: JSON `{ status, headers, body }` por stdout, y el motivo
  del fallo por stderr con código `1`.
- El script completo queda en el [`log_file`](../manifest.md#log_file) como una línea
  `type: "script"` justo después de las líneas `command`.
- Solo requiere `node` en el destino; no usa `sh`, `base64` ni `mktemp`.

Ver también: [ciclo de vida de `command_pass`](command-pass.md#ciclo-de-vida-setup-ejecución-y-stdin).
