# `tlsv1 alert protocol version` tras un `CONNECT` con 200

## Síntoma

`curl` a través del proxy abre el túnel con éxito, pero el handshake TLS falla de inmediato:

```
$ curl -v --proxy http://127.0.0.1:8080 https://servicio.example.com:8097/
* Establish HTTP proxy tunnel to servicio.example.com:8097
> CONNECT servicio.example.com:8097 HTTP/1.1
< HTTP/1.1 200 Connection Established
* CONNECT tunnel established, response 200
* ALPN: curl offers h2,http/1.1
* (304) (OUT), TLS handshake, Client hello (1):
curl: (35) LibreSSL/3.3.6: error:1404B42E:SSL routines:ST_CONNECT:tlsv1 alert protocol version
```

Con OpenSSL el mismo error se ve como `error:0A00042E:SSL routines::tlsv1 alert protocol version`
(o `unexpected eof while reading` si el otro extremo cierra sin avisar). `-k` no lo arregla:
desactiva la verificación del certificado, no la negociación de versión.

## Causa

Quien responde al `Client hello` rechaza todas las versiones de TLS que el cliente ofrece
(`protocol_version`). El `200 Connection Established` solo significa que el túnel `CONNECT` se
abrió; el TLS se negocia después y **lo termina el propio proxy**, no el destino
(ver [Cómo funciona](../overview.md)). Por eso:

- El proxy **no contacta** al host del `CONNECT` (aquí `servicio.example.com:8097`), así que la
  versión de TLS del destino es irrelevante para este error.
- El proxy usa los valores por defecto de `node:tls` de Bun: **TLS 1.2 como mínimo** (1.2 y 1.3).
  Un cliente que solo ofrece TLS 1.0/1.1 (por `--tls-max 1.1`, una opción en `~/.curlrc`, una
  librería o un entorno antiguo/endurecido) se queda sin versión común. Bun cierra la conexión sin
  enviar alerta (`unexpected eof`); con la pila de Node se ve literalmente `tlsv1 alert protocol version`.

La misma alerta aparece **sin proxy** cuando el destino real solo habla TLS 1.0/1.1 y el cliente
exige 1.2 o más: ahí sí es culpa del destino. Distinguir entre ambos casos es el diagnóstico.

## Cómo reproducirlo

Requisitos: `bun`, `openssl`, `curl` y `python3`. Todo en local.

1. Levanta el proxy con un manifest mínimo (genera `certs/` solo):

   ```sh
   cat > m.donly <<'EOF'
   proxy {
     host "127.0.0.1"
     port 18080
   }
   EOF
   bun src/cli/main.ts m.donly
   ```

2. Con un cliente que ofrece TLS 1.2+ el túnel funciona (`ok`):

   ```sh
   curl -k --proxy http://127.0.0.1:18080 https://servicio.example.com:8097/
   ```

3. Con un cliente limitado a TLS ≤ 1.1 falla tras el `200`. `openssl s_client` permite forzarlo
   (`SECLEVEL=0` es necesario en OpenSSL 3):

   ```sh
   openssl s_client -connect servicio.example.com:8097 -proxy 127.0.0.1:18080 \
     -tls1_1 -cipher 'ALL:@SECLEVEL=0' </dev/null
   # ... unexpected eof while reading ... New, (NONE), Cipher is (NONE)
   ```

   Contra la pila TLS de Node (por ejemplo `tls.TLSSocket` con `isServer: true`, que es lo que usa
   el proxy) el mismo cliente recibe `SSL: TLSV1_ALERT_PROTOCOL_VERSION`.

4. Para ver el caso "sin proxy", levanta un destino que solo hable TLS 1.1 y llámalo directo:

   ```sh
   openssl s_server -accept 18444 -cert certs/cert.pem -key certs/key.pem \
     -tls1_1 -cipher 'ALL:@SECLEVEL=0' -www &
   curl -sS -k https://127.0.0.1:18444/
   # curl: (35) OpenSSL/3.0.13: error:0A00042E:SSL routines::tlsv1 alert protocol version
   ```

   Por el proxy ese mismo destino responde `ok` (curl moderno, TLS 1.2+ contra el proxy), porque el
   proxy nunca lo llama.

> Observado en pruebas locales: con `curl` 8.5 (OpenSSL 3.0.13) y el proxy sobre Bun 1.4.2, un
> cliente con TLS 1.2/1.3 funciona y uno limitado a ≤ 1.1 recibe EOF. No se pudo probar LibreSSL
> 3.3.6 (el `curl` de macOS), que en teoría soporta 1.2/1.3: si el error aparece con él, revisa
> primero el punto 1 del diagnóstico.

## Diagnóstico

1. **¿Qué ofrece tu cliente?** Busca límites de versión: `--tls-max`, `--tlsv1.x`, `~/.curlrc`,
   `CURL_SSL_*`, `openssl.cnf` con `MinProtocol`/`MaxProtocol`, o un `curl` muy antiguo. Prueba:

   ```sh
   curl -v --tlsv1.2 -k --proxy http://127.0.0.1:8080 https://servicio.example.com:8097/
   ```

2. **¿El problema es del proxy o del destino?** Compara con y sin proxy:

   ```sh
   # directo al destino
   openssl s_client -connect servicio.example.com:8097 -tls1_2 </dev/null 2>&1 | grep -E 'Protocol|alert'
   # a través del proxy
   openssl s_client -connect servicio.example.com:8097 -proxy 127.0.0.1:8080 -tls1_2 </dev/null 2>&1 | grep -E 'Protocol|alert'
   ```

   - Falla solo directo → el destino no acepta TLS 1.2+: es un servidor antiguo (ver soluciones).
   - Falla solo con proxy → el cliente no llega a TLS 1.2 con el proxy (punto 1).
   - Falla en ambos → ambas cosas, o un cliente limitado a TLS ≤ 1.1.
3. **¿Qué versiones acepta el destino?** `nmap --script ssl-enum-ciphers -p 8097 servicio.example.com`
   o `openssl s_client -connect servicio.example.com:8097 -tls1_1 -cipher 'ALL:@SECLEVEL=0'`.

## Soluciones y mitigaciones

- **Cliente limitado:** quita el tope de versión (`--tls-max`, `~/.curlrc`, `MaxProtocol`) o
  actualiza el cliente/librería para que ofrezca TLS 1.2+. Es lo que corrige el error cuando
  viene del lado del proxy.
- **Destino antiguo (solo TLS 1.0/1.1):** lo correcto es actualizar el servidor a TLS 1.2+. Si debes
  llegar a él desde el proxy, usa una ruta con [`command_pass curl`](../tunnel/command-pass.md) y
  pasa la versión con [`extra_args`](../tunnel/command-pass.md#argumentos-extra) (`--tlsv1.0`); solo
  funciona si el `curl` del equipo aún permite TLS < 1.2 (muchas distribuciones recientes ya no).
- **Saltarse el proxy para ese host:** `NO_PROXY=servicio.example.com` o `curl --noproxy servicio.example.com`.
  Sirve si el cliente sí puede hablar con el destino directamente.
- **Cliente con OpenSSL en lugar de LibreSSL:** si el cliente de macOS (LibreSSL) falla, prueba con
  un `curl` de Homebrew (`brew install curl`) para descartar un problema propio de la librería.
- `-k` / `--insecure` **no** ayuda: solo omite la verificación del certificado del proxy.
