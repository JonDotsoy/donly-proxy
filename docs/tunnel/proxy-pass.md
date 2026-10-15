# `proxy_pass`

Reenvía la petición a otro servidor y devuelve su respuesta al cliente.

```
route http{s}?://api.example.com/* {
  proxy_pass "http://localhost:3000"
}
```

El valor debe ser una URL absoluta entre comillas.

## Cómo se construye la URL de destino

| `proxy_pass` | Petición original | Se envía a |
| --- | --- | --- |
| `"http://localhost:3000"` | `http://api.example.com/a/b?x=1` | `http://localhost:3000/a/b?x=1` |
| `"http://localhost:3000/v2"` | `http://api.example.com/a/b?x=1` | `http://localhost:3000/v2?x=1` |

- Si el destino **no declara ruta** (o es `/`), se conserva la ruta original.
- Si el destino **declara una ruta**, esa ruta reemplaza a la original.
- El query original siempre se conserva.

## Qué se reenvía

**Petición:** el método, el cuerpo y las cabeceras. No se reenvían las cabeceras propias de la
conexión (`connection`, `keep-alive`, `proxy-connection`, `transfer-encoding`, `upgrade`, `te`,
`trailer`) ni `host` y `content-length`; el cliente HTTP genera los suyos para el destino.

**Respuesta:** el estado, las cabeceras y el cuerpo. El cuerpo llega ya descomprimido, por lo que
se omiten `content-encoding`, `content-length` y las cabeceras de conexión.

## Redirecciones y errores

- Las redirecciones del destino **no se siguen**: el cliente recibe el `3xx` tal cual.
- Si el destino no responde o falla la conexión, el proxy contesta
  `502` con el cuerpo `bad gateway: <motivo>`.

## HTTPS

Funciona también para tráfico HTTPS: el proxy termina el TLS del túnel `CONNECT` y reenvía la
petición descifrada al destino con el esquema que tenga `proxy_pass` (`http://` o `https://`).
Para que la ruta coincida, el patrón debe contemplar la URL `https://host/...`.

## Ejemplo completo

```
proxy {
  port 8080
  log_file "./logs/proxy.ndjson"

  route POST http{s}?://example.com/api/* {
    proxy_pass "http://localhost:3001"
  }
}
```

```sh
curl -x http://127.0.0.1:8080 -X POST -d 'hola' http://example.com/api/items?x=1
# el servidor en :3001 recibe: POST /api/items?x=1  con el cuerpo "hola"
```

Ver también: [`command_pass`](command-pass.md), [referencia del manifiesto](../manifest.md).
