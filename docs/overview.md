# donly-proxy

Proxy HTTP/HTTPS configurable con un manifiesto [DON](https://don.jon.soy/) (`manifest.donly`).
Por defecto responde `ok` a cualquier petición; con rutas (`route`) puede responder con un
cuerpo fijo, reenviar la petición a otro servidor (`proxy_pass`) o pasarla al comando `curl`
(`command_pass`). Cada transacción puede registrarse en un archivo `.ndjson`.

## Uso rápido

```sh
bun install
bun start                        # usa ./manifest.donly
bun src/server.ts otro.donly     # usa otro manifiesto
bun test
```

Con el servidor levantado (puerto 8080 por defecto):

```sh
curl -x http://127.0.0.1:8080 http://example.com/            # -> ok
curl -k -x http://127.0.0.1:8080 https://example.com/        # -> ok
```

## Cómo funciona

| Tráfico | Qué hace el proxy |
| --- | --- |
| HTTP | El cliente envía la petición con URL absoluta (`GET http://host/ruta`). El proxy la procesa directamente. |
| HTTPS | El cliente abre un túnel con `CONNECT host:443`. El proxy responde `200 Connection Established`, **termina el TLS él mismo** con su certificado y procesa la petición ya descifrada. |

Una vez que tiene la petición (con su URL completa, por ejemplo `https://example.com/ruta`), el
proxy:

1. Lee el cuerpo completo en memoria.
2. Registra la línea `request` si hay `log_file`.
3. Busca la primera `route` cuyo método y patrón coincidan. Según la ruta responde con
   [`respond`](manifest.md#respond), [`proxy_pass`](tunnel/proxy-pass.md) o
   [`command_pass`](tunnel/command-pass.md). Si ninguna coincide responde `200 ok`.
4. Registra la línea `response` y responde al cliente.

Como el TLS se termina en el proxy, los clientes HTTPS deben **confiar en su certificado** o
desactivar la verificación (`curl -k`, `fetch(..., { tls: { rejectUnauthorized: false } })`).
Los certificados se generan automáticamente con `openssl` si no existen (ver
[manifest](manifest.md#ssl)).

## Documentación

- [`manifest.md`](manifest.md): referencia del manifiesto (`host`, `port`, `ssl`, `log_file`, `route`).
- [`tunnel/proxy-pass.md`](tunnel/proxy-pass.md): reenviar una ruta a otro servidor.
- [`tunnel/command-pass.md`](tunnel/command-pass.md): pasar una ruta al comando `curl`.

## Estructura del código

| Archivo | Contenido |
| --- | --- |
| `src/server.ts` | Servidor, lectura del manifiesto, rutas y log. Se ejecuta con `bun src/server.ts`. |
| `src/curl.ts` | Ejecución del binario `curl` para `command_pass`. |
| `src/certs.ts` | Generación del certificado autofirmado con `openssl`. |
| `src/*.test.ts` | Pruebas (`bun test`). Corren en CI en cada pull request. |

## Requisitos y límites

- [Bun](https://bun.sh) para ejecutar el servidor y las pruebas.
- `openssl` instalado (solo si los certificados no existen) y `curl` (solo para `command_pass`).
- Solo HTTP/1.1. Los cuerpos se mantienen completos en memoria. No hay autenticación: no lo
  expongas fuera de `127.0.0.1` sin protegerlo.
