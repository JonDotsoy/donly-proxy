# Motor `wget`

`wget` es un motor **solo remoto**: se elige con `engine wget` en [`command_pass ssh`](command-pass-ssh.md)
o [`command_pass kubectl`](command-pass-kubectl.md), o con `command_pass wget` dentro de
[`ssh_pass`](command-pass-ssh.md#ssh_pass) / [`kubectl_pass`](command-pass-kubectl.md#kubectl_pass).
No existe un `command_pass wget` local: con la forma directa el arranque falla con
`command_pass solo soporta "curl", "node", "ssh" y "kubectl"`. Está pensado para contenedores mínimos
(BusyBox) que tienen `wget` pero no `curl` ni `node`.

```
route https?://api.internal/ {
  kubectl_pass "deploy/api" {
    command_pass wget
  }
}
```

## Qué se ejecuta en el destino

El proxy arma un comando fijo que ejecuta el shell remoto (`sh -c` en `kubectl`, el shell del host
en `ssh`):

```
d=$(mktemp -d) && trap 'rm -rf "$d"' EXIT && cat > "$d/b" && \
wget -q -S -O - --header '<nombre>: <valor>' … <opciones> [--post-file "$d/b"] '<URL>'
```

- El **cuerpo** llega por stdin y se guarda en un archivo temporal (`$d/b`), porque `--post-file`
  necesita un archivo regular. El directorio se borra al terminar.
- Cada cabecera de la petición se pasa con `--header`. Las **opciones** del `command_pass wget`
  van después de las cabeceras y antes de la URL.
- La URL, las cabeceras y las opciones se citan como una sola palabra de shell, así que ningún dato
  de la petición puede salirse de su argumento. Si alguno contiene caracteres de control, la petición
  falla con `502`.
- Requiere en el destino `sh`, `wget` (BusyBox o GNU), `mktemp` y `cat`.

## Métodos admitidos

Solo **GET** y **POST**. Un cuerpo implica POST (`--post-file`); cualquier otro método, o un cuerpo
con un método distinto de POST, responde `502 bad gateway: … wget only supports GET and POST …`.

## Respuesta

`wget -S` imprime el estado y las cabeceras de cada respuesta por **stderr**, con dos espacios de
sangría, y el cuerpo por **stdout**. El proxy toma el **último** bloque `HTTP/…` (las redirecciones
intermedias se descartan) y devuelve su estado, sus cabeceras y el cuerpo.

- Con `4xx` / `5xx` `wget` sale con código distinto de `0` y sin cuerpo; el proxy devuelve igualmente
  el estado y las cabeceras, con el cuerpo vacío. Se aceptan los códigos de salida `0`, `1` y `8`.
- `wget` no descomprime el cuerpo.
- Si no hay ninguna línea de estado en stderr (host inalcanzable, `wget` no instalado) o el código de
  salida es otro, el cliente recibe `502 bad gateway: <ssh|kubectl> wget exited with <código>: <salida>`.

## Pruebas

`src/proxy/tunnel/wget/wget.test.ts` comprueba la línea de comandos, el citado, el POST desde un
archivo temporal, los métodos rechazados y la lectura de estado y cabeceras; las pruebas con
`kind` (`src/proxy/tunnel/kubectl/wget/`) lo ejecutan dentro de un pod si el clúster existe.

Ver también: [ciclo de vida de `command_pass`](command-pass.md#ciclo-de-vida-setup-ejecución-y-stdin).
