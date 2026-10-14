# `command_pass curl`

Pasa la petición al binario `curl` del `PATH`, que la ejecuta contra su URL original. Es parte de
[`command_pass`](command-pass.md) (ver su [ciclo de vida](command-pass.md#ciclo-de-vida-setup-ejecución-y-stdin));
aquí está el detalle del motor `curl`. También es el motor por defecto de
[`ssh`](command-pass-ssh.md) y [`kubectl`](command-pass-kubectl.md), donde corre en el host o el
contenedor remoto.

## Qué hace el proxy

Ejecuta `curl` (el que se encuentre en el `PATH`) sin shell, pasando los argumentos como lista:

```
curl --silent --compressed --proto =http,https \
     --write-out '%{stderr}%{response_code}\n%{header_json}' \
     --header 'Expect:' \
     --request <MÉTODO> --output - [--data-binary @-] \
     --header '<nombre>: <valor>' ...   # cabeceras de la petición
     <argumentos del manifiesto> \
     --url <URL completa>
```

- El **método**, las **cabeceras** y el **cuerpo** de la petición se pasan a `curl`. El cuerpo
  viaja por stdin (`--data-binary @-`) y solo si no está vacío. Para `HEAD` se usa `--head`.
- No se reenvían las cabeceras de conexión (`connection`, `keep-alive`, `proxy-connection`,
  `transfer-encoding`, `upgrade`, `te`, `trailer`), `host`, `content-length` ni
  `accept-encoding`: `curl` negocia la codificación con `--compressed`.
- La URL se entrega con `--url`, y `--proto =http,https` restringe los protocolos.
- Las opciones del manifiesto se colocan **antes** de `--url`, por lo que pueden complementar
  la llamada (`--insecure`, `--max-time`, `--connect-to`, `--proxy`, etc.).
- Las redirecciones no se siguen (a menos que agregues `-L`).
- Con `HEAD` no hay cuerpo: se usa `--head --output /dev/null` y no se pasa `--request`.

## Qué se devuelve al cliente

`curl` entrega el resultado por dos canales, para no mezclar el cuerpo con los metadatos:

| Canal | Contenido |
| --- | --- |
| stdout | Cuerpo de la respuesta (ya descomprimido). |
| stderr | `<código de estado>\n<cabeceras en JSON>` (`%{response_code}` y `%{header_json}`). |

El cliente recibe ese estado, esas cabeceras (sin las de conexión ni `content-encoding`) y ese
cuerpo. Si `curl` termina con error, no está instalado o no produjo un estado, el proxy
responde `502` con `bad gateway: curl exited with <código>: <salida>`.

## Ejemplos

Enviar una URL a otro destino sin cambiar el host de la petición, con `--connect-to`:

```
route http://example.com/ {
  command_pass curl "--connect-to" "example.com:80:127.0.0.1:3000"
}
```

Ignorar certificados inválidos del servidor real:

```
route https://internal.example.com/ {
  command_pass curl "--insecure"
}
```

## Pruebas

`src/proxy/tunnel/curl/curl.test.ts` coloca un `curl` falso (un script `.sh`) al inicio del `PATH` y comprueba que
la petición pasa por él: que recibe la URL, el método, las cabeceras, los argumentos del
manifiesto y el cuerpo, y que su respuesta llega al cliente. Si cambias el contrato con `curl`
(los flags de arriba), ajusta también ese script.

## Certificados inseguros (`insecure`)

`insecure` es una directiva hija de `command_pass curl` equivalente a pasar `"--insecure"`
(curl no valida el certificado TLS del destino):

```
route https?://example.com/ {
  command_pass curl {
    insecure
  }
}
```

- Sin valor (o `insecure true`) añade `--insecure`; `insecure false` no añade nada.
- Con otro valor el arranque falla con `insecure debe ser true o false`.
- Solo aplica a `curl`; con otro comando falla con `insecure solo aplica a command_pass curl`.
- También se puede usar en el `command_pass curl` hijo de `kubectl_pass`.

## Tiempo máximo (`max_time`)

`max_time <segundos>` es una directiva hija de `command_pass curl` equivalente a pasar
`"--max-time" "<segundos>"`:

```
route https?://example.com/ {
  command_pass curl {
    max_time 5
  }
}
```

- El valor debe ser un **número positivo** (admite decimales, p. ej. `2.5`); con otro (`0`,
  negativo, texto o una cadena entre comillas) el arranque falla con
  `max_time debe ser un número positivo`.
- Solo aplica a `curl`; con otro comando el arranque falla con
  `max_time solo aplica a command_pass curl`.
- Va después de los argumentos de la propia línea (`command_pass curl "--insecure" { … }`) y
  también se puede usar en el `command_pass curl` hijo de `kubectl_pass`.

## Reintentos (`retry`)

`retry <n>` es una directiva hija de `command_pass curl` equivalente a pasar
`"--retry" "<n>"` (curl reintenta hasta `n` veces ante errores transitorios):

```
route https?://example.com/ {
  command_pass curl {
    retry 5
  }
}
```

- El valor debe ser un **entero no negativo** (`0` desactiva los reintentos); con otro (negativo,
  decimal, texto o una cadena entre comillas) el arranque falla con
  `retry debe ser un entero no negativo`.
- Solo aplica a `curl`; con otro comando falla con `retry solo aplica a command_pass curl`.
- También se puede usar en el `command_pass curl` hijo de `kubectl_pass`.

## Con `ssh` y `kubectl`

Con `engine curl` se usan los mismos flags fijos, pero la línea se arma en el destino remoto: la URL,
el método y las cabeceras viajan en un archivo de configuración (`curl -K`) en base64 y el cuerpo
por stdin. Detalle en [el ciclo de vida de `command_pass`](command-pass.md#cómo-llega-la-petición-al-comando-remoto).
