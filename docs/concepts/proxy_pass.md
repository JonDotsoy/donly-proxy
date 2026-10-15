# `proxy_pass`

Acción de [`route`](route.md) que **reenvía la petición a otro servidor** desde el propio proceso
del proxy y devuelve su respuesta al cliente.

```
route http{s}?://api.example.com/* {
  proxy_pass "http://localhost:3000"
}
```

## Idea

El valor es una URL absoluta entre comillas (`http://` o `https://`). El proxy conserva el método,
el cuerpo y las cabeceras de la petición y los envía al destino:

- Si el destino **no declara ruta** (o es `/`), se conserva la ruta original.
- Si **declara una ruta**, esa reemplaza a la original.
- El query original siempre se conserva.

## Comportamiento

- Las redirecciones del destino **no se siguen**: el cliente recibe el `3xx` tal cual.
- El cuerpo de la respuesta llega ya descomprimido (se omiten `content-encoding`,
  `content-length` y las cabeceras de conexión).
- Si el destino no responde, el cliente recibe `502 bad gateway: <motivo>`.
- Funciona también con HTTPS: el proxy termina el TLS del túnel `CONNECT` y reenvía la petición
  descifrada con el esquema del destino.

## Diferencia con `command_pass`

`proxy_pass` hace la conexión **desde el proxy**. Cuando el tráfico debe salir desde otro lugar
(otra máquina o un pod), usa [`command_pass`](command_pass.md), [`ssh_pass`](ssh_pass.md) o
[`kubectl_pass`](kubectl_pass.md).

Detalle completo (construcción de la URL, qué se reenvía, ejemplos):
[`tunnel/proxy-pass.md`](../tunnel/proxy-pass.md).
