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
| Método (opcional) | `GET`, `POST`, etc. Sin método aplica a cualquier método. |
| Patrón | Expresión regular de JavaScript probada contra la URL completa. **No está anclada**: usa `^` y `$` si lo necesitas, y recuerda que `.` coincide con cualquier carácter. |

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
  route https?://api.example.com/ {
    proxy_pass "http://localhost:3000"
  }
  route {
    respond 404 "not found"
  }
}
```

Cada transacción de una ruta se registra en el [`log_file`](../manifest.md#log_file) si existe.

Ver también: [referencia del manifiesto](../manifest.md).
