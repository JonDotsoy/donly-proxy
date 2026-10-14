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

`-k` no lo evita: desactiva la verificación del certificado, no la negociación TLS.

## Qué hace el proxy aquí

El `200 Connection Established` solo indica que el túnel se abrió. A continuación **el propio
proxy termina el TLS** con el certificado de `ssl { cert … key … }` (ver
[Cómo funciona](../overview.md)); **no contacta** al host del `CONNECT` (`google.com`, o el host
interno que sea). Por eso la versión de TLS del destino no interviene: el fallo está entre el
cliente y el proxy.

## Estado de la investigación: no reproducido

Con el comando exacto `curl -v -k --proxy http://127.0.0.1:8080 https://google.com` y el
`manifest.donly` por defecto **no se reproduce** el error. Probado en Linux con Bun 1.4.2:

| Cliente | Resultado |
| --- | --- |
| `curl` 8.5 (OpenSSL 3.0.13) | TLS 1.3, responde `ok` |
| `openssl s_client` de LibreSSL 3.3.6 compilado desde fuente (`-tls1_2` y `-tls1_3`) | TLS 1.2 / 1.3, responde `ok` |
| Igual, con certificado y clave generados por el `openssl` de LibreSSL 3.3.6 (cert X.509 v1) | `ok` |
| Bundle `dist/donly-proxy.js` en lugar de `bun start` | `ok` |
| Certificado RSA 1024 o EC P-256 | `ok` |

Es decir: ni LibreSSL 3.3.6, ni el tipo de certificado, ni el bundle explican el error. Lo que
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
4. **¿Qué Bun es?** `bun --version`; prueba también con la última versión.
5. **Compara el cliente:** `openssl s_client -connect google.com:443 -proxy 127.0.0.1:8080 -tls1_2 </dev/null`
   (OpenSSL 3) o un `curl` de Homebrew en lugar del de macOS.

## Mitigaciones

- Regenera los certificados (`rm -r certs`) o corrige el par `cert`/`key`.
- Quita el tope de versión del cliente.
- Salta el proxy para ese host: `curl --noproxy <host>` o `NO_PROXY=<host>`.
- Si el destino real solo habla TLS 1.0/1.1 y quieres llegar a él desde el proxy, usa
  [`command_pass curl`](../tunnel/command-pass.md) con
  [`extra_args`](../tunnel/command-pass.md#argumentos-extra) `--tlsv1.0` (solo si el `curl` del
  equipo aún permite TLS < 1.2).
