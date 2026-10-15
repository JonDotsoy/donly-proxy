# `curl: (35) ... tlsv1 alert protocol version` tras un `CONNECT` con 200

## Síntoma

`curl` a través del proxy abre el túnel, pero el handshake TLS falla de inmediato:

```
$ curl -v -k --proxy http://127.0.0.1:8080 https://google.com
* Establish HTTP proxy tunnel to google.com:443
< HTTP/1.1 200 Connection Established
* CONNECT tunnel established, response 200
* ALPN: curl offers h2,http/1.1
* (304) (OUT), TLS handshake, Client hello (1):
curl: (35) LibreSSL/3.3.6: error:1404B42E:SSL routines:ST_CONNECT:tlsv1 alert protocol version
```

Variante: con `--tlsv1.2 --tls-max 1.3` el `curl` puede **quedarse colgado** tras el `Client hello`
hasta `^C`, sin alerta ni error. En ambos casos el túnel `CONNECT` funciona y falla el TLS con el proxy.

`-k` no lo evita: desactiva la verificación del certificado, no la negociación TLS.

## Causa confirmada: Bun 1.3.x no completa el handshake sobre un socket envuelto

Reproducido con **Bun 1.3.11** (la versión donde se vio el error) y el manifest exacto: el túnel
`CONNECT` responde `200` y el `curl` (también el 8.7.1 compilado contra LibreSSL 3.3.6) se queda
colgado tras el `Client hello` hasta `^C`, sin alerta. Con Bun 1.4.2 el mismo caso funciona.

El proxy termina el TLS él mismo (ver [Cómo funciona](../overview.md)) y no contacta al host del
`CONNECT`. Hasta la versión 0.0.9 lo hacía envolviendo el socket del `CONNECT` en
`new tls.TLSSocket(socket, { isServer: true })`; en Bun 1.3.11 ese camino nunca completa el
handshake. Desde la corrección, el proxy envía el túnel a un servidor HTTPS interno (en
`127.0.0.1`, puerto efímero) y funciona en 1.3.11 y 1.4.2.

**Solución:** actualiza donly-proxy a una versión que incluya la corrección. Mientras tanto,
`bun upgrade` (Bun 1.4.2 o superior) también lo evita.

Para comprobar si tu Bun tiene el problema sin usar donly-proxy, ejecuta el script de
[Diagnóstico](#diagnóstico-en-tu-equipo) (punto 4): imprime `HANG` en Bun 1.3.11.

## Otras causas descartadas

Con Bun 1.4.2 en Linux no se reproduce el error. Probado con el comando exacto y el
`manifest.donly` por defecto:

| Cliente | Resultado |
| --- | --- |
| `curl` 8.5 (OpenSSL 3.0.13) | TLS 1.3, responde `ok` |
| `openssl s_client` de LibreSSL 3.3.6 compilado desde fuente (`-tls1_2` y `-tls1_3`) | TLS 1.2 / 1.3, responde `ok` |
| Igual, con certificado y clave generados por el `openssl` de LibreSSL 3.3.6 (cert X.509 v1) | `ok` |
| Bundle `dist/donly-proxy.js` en lugar de `bun start` | `ok` |
| `curl` 8.7.1 compilado contra LibreSSL 3.3.6 (como el de macOS) con `-v -k --tlsv1.2 --tls-max 1.3`, manifest con `log_file` y `ssl`, sin `route` | `ok`, sin colgarse |
| Certificado RSA 1024 o EC P-256 | `ok` |

Es decir: ni LibreSSL 3.3.6, ni el `curl` 8.7.1, ni el tipo de certificado, ni el bundle, ni
`log_file` explican el error. La diferencia que queda es la plataforma: todo se probó en Linux, y
lo que cambia es la versión de Bun (1.3.11 frente a 1.4.2), como se explica arriba. Lo que
**sí** produce un fallo TLS cuyo mensaje cambia según el cliente:

- **Cliente limitado a TLS ≤ 1.1** (`--tls-max 1.1`, `MaxProtocol` en `openssl.cnf`, `~/.curlrc`).
  El proxy exige TLS 1.2+. Bun cierra sin alerta (`unexpected eof`); con la pila de Node llega la
  alerta literal `tlsv1 alert protocol version`.
- **Certificado y clave que no coinciden** (`ERR_OSSL_X509_KEY_VALUES_MISMATCH`, por ejemplo se
  reemplazó `certs/cert.pem` pero no `certs/key.pem`). El proxy arranca bien, responde `200` al
  `CONNECT` y **se cae** al crear el contexto TLS; el cliente ve un error de handshake
  (`wrong version number` con OpenSSL) y luego `Connection refused`. No hay validación al
  arrancar. Se reproduce con:

  ```sh
  openssl req -x509 -newkey rsa:2048 -nodes -keyout k1.pem -out c1.pem -subj /CN=a
  openssl req -x509 -newkey rsa:2048 -nodes -keyout k2.pem -out c2.pem -subj /CN=b
  # manifest con: ssl { cert "./c1.pem" key "./k2.pem" }
  curl -vk --proxy http://127.0.0.1:8080 https://google.com   # error TLS y el proxy muere
  ```

## Diagnóstico en tu equipo

1. **¿Quién escucha en el 8080?** `lsof -nP -iTCP:8080 -sTCP:LISTEN`. El texto
   `200 Connection Established` lo usan muchos proxies; si hay otro (agente corporativo, VPN,
   otro proceso) puede no ser donly-proxy. Comprueba con `curl -s -x http://127.0.0.1:8080 http://example.com/` (debe responder `good` o `ok`).
2. **¿Murió el proxy?** Mira la consola donde corre: un `error: ... KEY_VALUES_MISMATCH` u otro
   error de TLS tras la petición indica un problema de certificado. Prueba
   `openssl x509 -in certs/cert.pem -noout -modulus | md5` frente a `openssl rsa -in certs/key.pem -noout -modulus | md5` (deben ser iguales) o borra `certs/` para regenerarlos.
3. **¿Qué versiones ofrece el cliente?** Revisa `~/.curlrc`, `--tls-max` y `openssl.cnf`, y prueba
   `curl -v -k --tlsv1.2 --tls-max 1.3 --proxy http://127.0.0.1:8080 https://google.com`.
4. **¿Tu Bun termina TLS sobre un socket envuelto?** Guarda esto como `tls-check.mjs` junto a `certs/`
   y ejecútalo con `bun tls-check.mjs`. Hace lo mismo que el proxy (antes de la corrección) en un
   `CONNECT` y no usa donly-proxy. Imprime `OK TLSv1.3` si todo va bien (Bun 1.4.2); si imprime
   `HANG` o un error, el problema está en tu Bun/plataforma y no en el manifest:

   ```js
   import net from "node:net";
   import tls from "node:tls";
   import { readFileSync } from "node:fs";

   const opts = { key: readFileSync("certs/key.pem"), cert: readFileSync("certs/cert.pem") };
   const server = net.createServer((socket) => {
     const secure = new tls.TLSSocket(socket, { ...opts, isServer: true });
     secure.on("error", (e) => console.log("server error:", e.code ?? e.message));
     secure.on("data", () => secure.end("ok"));
   });
   server.listen(0, "127.0.0.1", () => {
     const client = tls.connect({ port: server.address().port, host: "127.0.0.1", rejectUnauthorized: false });
     const timer = setTimeout(() => { console.log("HANG: no handshake after 5s"); process.exit(1); }, 5000);
     client.on("secureConnect", () => { clearTimeout(timer); console.log("OK", client.getProtocol()); client.write("hi"); });
     client.on("data", () => process.exit(0));
     client.on("error", (e) => { clearTimeout(timer); console.log("client error:", e.message); process.exit(1); });
   });
   ```

   Prueba también `bun upgrade` y repite.
5. **Compara el cliente:** `openssl s_client -connect google.com:443 -proxy 127.0.0.1:8080 -tls1_2 </dev/null`
   (OpenSSL 3) o un `curl` de Homebrew en lugar del de macOS.

## Mitigaciones

- Actualiza Bun (`bun upgrade`) o donly-proxy a la versión con la corrección.
- Regenera los certificados (`rm -r certs`) o corrige el par `cert`/`key`.
- Quita el tope de versión del cliente.
- Salta el proxy para ese host: `curl --noproxy <host>` o `NO_PROXY=<host>`.
- Si el destino real solo habla TLS 1.0/1.1 y quieres llegar a él desde el proxy, usa
  [`command_pass curl`](../tunnel/command-pass.md) con
  [`extra_args`](../tunnel/command-pass.md#argumentos-extra) `--tlsv1.0` (solo si el `curl` del
  equipo aún permite TLS < 1.2).
