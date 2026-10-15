# `route`

Una **ruta** es una regla por petición: decide qué hace el proxy con las peticiones cuya URL y
método coinciden. Es el bloque central del [manifiesto](../manifest.md#route).

```
route [MÉTODO] <patrón> {
  <acción>
}
```

## Cómo se evalúa

1. El proxy arma la **URL completa** de la petición (`https://example.com/a/b?x=1`; en HTTPS, la
   del túnel `CONNECT` ya descifrado).
2. Recorre las rutas **en el orden del manifiesto** y gana la **primera** que coincida.
3. Si ninguna coincide, responde `200 ok`.

Una ruta coincide cuando se cumplen ambas condiciones:

| Parte | Regla |
| --- | --- |
| Método (opcional) | Uno de los métodos HTTP de la [lista del manifest](../manifest.md#route) (sin distinguir mayúsculas). Sin método aplica a cualquier método. |
| Patrón | [`URLPattern`](https://developer.mozilla.org/docs/Web/API/URLPattern) probado contra la URL completa. Coincide la URL **entera**: la ruta debe coincidir completa, usa `*` para prefijos. |

`route` recibe **uno o dos** argumentos: con uno (`route <patrón>`) solo se valida la URL; con dos
(`route <MÉTODO> <patrón>`), el método y la URL. Con más de dos el arranque falla.

### Patrón

El patrón es siempre un [`URLPattern`](https://developer.mozilla.org/docs/Web/API/URLPattern)
(estándar WHATWG, nativo en Bun), sin prefijo. Escríbelo entre comillas si lleva caracteres
especiales para el manifest (`\`, espacios).

- **Sin esquema** (`<host>[:puerto][/ruta]`): atajo por host. Se expande a `*://<…>/*`, de modo que
  cubre cualquier esquema, ruta y query. El puerto **debe** coincidir si se indica; sin puerto solo
  coincide el puerto por defecto (usa `:*` para cualquiera).
- **Con esquema** (`https://host/*`): se pasa tal cual a `URLPattern`. Si no hay ruta se añade `/*`.
- **Ruta**: debe coincidir completa. `http://example.com/api` no coincide con `/api/users`; usa
  `/api/*`.
- **IPv4**: escribe la IP exacta (`192.0.2.1`, `192.0.2.1:8080`). Los comodines no funcionan en una
  IP: `URLPattern` la canonicaliza (`198.51.100.*` pasa a `198.51.0.100*`).
- **IPv6**: escapa los `:` dentro de los corchetes, p. ej. `"https://[2001\\:db8\\:\\:1]/*"`.

| Patrón | Coincide con |
| --- | --- |
| `example.com` | `http://example.com/`, `https://example.com/a?x=1` |
| `example.com:8080` | solo el puerto `8080` |
| `example.com:*` | cualquier puerto |
| `*.example.com` | `http://a.b.example.com/` (no `example.com`) |
| `example.com/api/*` | rutas bajo `/api/` |
| `https://example.com/*` | solo HTTPS |
| `http{s}?://example.com/*` | HTTP y HTTPS (esquema explícito) |

Un patrón vacío o mal formado hace fallar el arranque (`route …: patrón inválido (…)`).

`route { … }` sin argumentos coincide con **todas** las peticiones. Como gana la primera, va al
**final**: las rutas declaradas después nunca se alcanzan.

## Acciones

Cada ruta debe tener **exactamente una** acción; con ninguna o con varias el arranque falla.

| Acción | Qué hace | Concepto |
| --- | --- | --- |
| `respond <estado> "<cuerpo>"` | Responde con un estado y cuerpo fijos (`text/plain`). | [manifiesto](../manifest.md#respond) |
| `proxy_pass` | Reenvía la petición a otro servidor. | [proxy_pass](proxy_pass.md) |
| `command_pass` | Ejecuta la petición con `curl`, `node`, `ssh` o `kubectl`. | [command_pass](command_pass.md) |
| `kubectl_pass` | Ejecuta la petición dentro de un pod. | [kubectl_pass](kubectl_pass.md) |
| `ssh_pass` | Ejecuta la petición en un host remoto. | [ssh_pass](ssh_pass.md) |

## Ejemplo

```
proxy {
  route GET http://specific.test/ {
    respond 200 "specific"
  }
  route http{s}?://api.example.com/* {
    proxy_pass "http://localhost:3000"
  }
  route {
    respond 404 "not found"
  }
}
```

Cada transacción de una ruta se registra en el [`log_file`](../manifest.md#log_file) si existe.

Ver también: [referencia del manifiesto](../manifest.md).
