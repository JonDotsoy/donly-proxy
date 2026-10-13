# Features

Generado por `bun run features` a partir de `spec_tests.json` (las specs que registra
`testFeature`, ver `src/utils/test_utils/test-feature`). No lo edites a mano.

Cada spec es un test: las líneas marcadas con `+` son las directivas del manifest que el test
ejercita (`-` si el test falla).

Specs: **65** · ✅ pasan: **59** · 🔴 fallan: **1** · ⏳ sin resultado: **5** · ⏭️ omitidas: **0**

## a 4xx response keeps its status even though wget exits with an error

**Status:** ✅ passed

```diff
  proxy {
    route / {
      command_pass ssh "user@remote.test" {
+       engine wget
      }
    }
  }
```

## a body becomes a POST sent from a temporary file

**Status:** ✅ passed

```diff
  proxy {
    route / {
      command_pass ssh "user@remote.test" {
+       engine wget
      }
    }
  }
```

## a failing process frees its place for the next request

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://conc.test/default/ {
+     command_pass curl
    }
    route http://conc.test/two/ {
+     command_pass curl {
+       concurrency 2
+     }
    }
  }
```

## a GET becomes a fixed wget command line with quoted values

**Status:** ✅ passed

```diff
  proxy {
    route / {
      command_pass ssh "user@remote.test" {
+       engine wget
      }
    }
  }
```

## a later fetch without proxy still adds nothing to the log

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
  }
```

## a route without arguments matches every request

**Status:** ⏳ pending

```diff
  proxy {
    host "127.0.0.1"
    port 0
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route http://specific.test/ {
      respond 200 "specific"
    }
+   route {
+     respond 202 "catch-all"
+   }
    route http://never.test/ {
      respond 200 "unreachable"
    }
  }
```

## command_pass curl hands the request to curl

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./logs/proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route https?://pass.test/ {
      proxy_pass "http://127.0.0.1:<port>"
    }
    route http://fixed.test/ {
      proxy_pass "http://127.0.0.1:<port>/fixed"
    }
    route http://curl.test/ {
+     command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
    }
    route POST http://example.com/ {
      respond 201 "created"
    }
    route https?://example.com/ {
      respond 200 "good"
    }
  }
```

## command_pass curl reports a bad gateway when curl fails

**Status:** ✅ passed

```diff
  proxy {
    route http://dead.test/ {
+     command_pass curl "--connect-to" "dead.test:80:127.0.0.1:<port>"
    }
  }
```

## command_pass curl runs the curl found in PATH

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route http://fake.test/ {
+     command_pass curl "--max-time" "5"
    }
  }
```

## command_pass kubectl uses curl when no engine is given

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
+     command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
+       engine curl
+     }
    }
    route http://127.0.0.1:<port>/node/ {
+     command_pass kubectl "pod/api-0" {
+       engine node
+     }
    }
    route http://127.0.0.1:<port>/pass/ {
      kubectl_pass "-n" "prod" "deploy/api" {
        command_pass curl "--max-time" "5"
      }
    }
    route http://127.0.0.1:<port>/default/ {
+     command_pass kubectl "pod/api-0"
    }
  }
```

## command_pass kubectl with engine curl reaches an echo Service in the kind-kind-cluster

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./proxy.ndjson"
    route http://echo.donly-proxy-test.svc.cluster.local/curl/ {
+     kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {
+       command_pass curl
+     }
    }
  }
```

## command_pass kubectl with engine curl runs the request inside the pod

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
      command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
+       engine curl
      }
    }
    route http://127.0.0.1:<port>/node/ {
      command_pass kubectl "pod/api-0" {
+       engine node
      }
    }
    route http://127.0.0.1:<port>/pass/ {
      kubectl_pass "-n" "prod" "deploy/api" {
        command_pass curl "--max-time" "5"
      }
    }
    route http://127.0.0.1:<port>/default/ {
      command_pass kubectl "pod/api-0"
    }
  }
```

## command_pass kubectl with engine node reaches an echo Service in the kind-kind-cluster

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./proxy.ndjson"
    route http://echo.donly-proxy-test.svc.cluster.local/node/ {
      command_pass kubectl "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {
        engine node
      }
    }
  }
```

## command_pass kubectl with engine node runs the request inside the pod

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
      command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
+       engine curl
      }
    }
    route http://127.0.0.1:<port>/node/ {
      command_pass kubectl "pod/api-0" {
+       engine node
      }
    }
    route http://127.0.0.1:<port>/pass/ {
      kubectl_pass "-n" "prod" "deploy/api" {
        command_pass curl "--max-time" "5"
      }
    }
    route http://127.0.0.1:<port>/default/ {
      command_pass kubectl "pod/api-0"
    }
  }
```

## command_pass kubectl with engine wget reaches an echo Service in the kind-kind-cluster

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./proxy.ndjson"
    route http://echo.donly-proxy-test.svc.cluster.local/wget/ {
+     kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {
+       command_pass wget
+     }
    }
  }
```

## command_pass node performs https requests with https.request

**Status:** ⏳ pending

```diff
  proxy {
    host "127.0.0.1"
    port 0
    ssl {
      cert "./ssl/cert.pem"
      key "./ssl/key.pem"
    }
    route http://127.0.0.1:<port>/ {
+     command_pass node "--no-warnings"
    }
    route https://127.0.0.1:<port>/ {
+     command_pass node "--no-warnings"
    }
  }
```

## command_pass node performs the request with http.request

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    ssl {
      cert "./ssl/cert.pem"
      key "./ssl/key.pem"
    }
    route http://127.0.0.1:<port>/ {
+     command_pass node "--no-warnings"
    }
    route https://127.0.0.1:<port>/ {
+     command_pass node "--no-warnings"
    }
  }
```

## command_pass node reports a bad gateway when the request fails

**Status:** ✅ passed

```diff
  proxy {
    route http://127.0.0.1:<port>/ {
+     command_pass node
    }
  }
```

## command_pass only supports known commands

**Status:** ✅ passed

```diff
  proxy {
    route / {
+     command_pass wget
    }
  }
```

## command_pass ssh uses curl when no engine is given

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
+     command_pass ssh "-p" "2222" "user@remote.test" {
+       engine curl
+     }
    }
    route http://127.0.0.1:<port>/node/ {
+     command_pass ssh "user@remote.test" {
+       engine node
+     }
    }
    route http://127.0.0.1:<port>/default/ {
+     command_pass ssh "user@remote.test"
    }
  }
```

## command_pass ssh with engine curl runs the request on the remote host

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
      command_pass ssh "-p" "2222" "user@remote.test" {
+       engine curl
      }
    }
    route http://127.0.0.1:<port>/node/ {
      command_pass ssh "user@remote.test" {
+       engine node
      }
    }
    route http://127.0.0.1:<port>/default/ {
      command_pass ssh "user@remote.test"
    }
  }
```

## command_pass ssh with engine node runs the request on the remote host

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
      command_pass ssh "-p" "2222" "user@remote.test" {
+       engine curl
      }
    }
    route http://127.0.0.1:<port>/node/ {
      command_pass ssh "user@remote.test" {
+       engine node
      }
    }
    route http://127.0.0.1:<port>/default/ {
      command_pass ssh "user@remote.test"
    }
  }
```

## concurrency <n> allows n processes in parallel

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://conc.test/default/ {
      command_pass curl
    }
    route http://conc.test/two/ {
      command_pass curl {
+       concurrency 2
      }
    }
  }
```

## concurrency must be a positive integer

**Status:** ✅ passed

```diff
  proxy {
    route / {
      command_pass curl {
+       concurrency 0
      }
    }
  }
```

## each route has its own limit

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://conc.test/default/ {
+     command_pass curl
    }
    route http://conc.test/two/ {
+     command_pass curl {
+       concurrency 2
+     }
    }
  }
```

## earlier routes win and the catch-all takes the rest

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
+   route http://specific.test/ {
+     respond 200 "specific"
+   }
+   route {
+     respond 202 "catch-all"
+   }
+   route http://never.test/ {
+     respond 200 "unreachable"
+   }
  }
```

## fetch through the proxy goes through it and is logged

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
  }
```

## fetch without proxy reaches the local server and writes no log

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
  }
```

## GET http://example.com through the proxy is answered by the route

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./logs/proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route https?://pass.test/ {
      proxy_pass "http://127.0.0.1:<port>"
    }
    route http://fixed.test/ {
      proxy_pass "http://127.0.0.1:<port>/fixed"
    }
    route http://curl.test/ {
      command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
    }
    route POST http://example.com/ {
+     respond 201 "created"
    }
    route https?://example.com/ {
+     respond 200 "good"
    }
  }
```

## GET https://example.com through the proxy is answered by the route

**Status:** ⏳ pending

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./logs/proxy.ndjson"
+   ssl {
+     cert "./certs/cert.pem"
+     key "./certs/key.pem"
+   }
    route https?://pass.test/ {
      proxy_pass "http://127.0.0.1:<port>"
    }
    route http://fixed.test/ {
      proxy_pass "http://127.0.0.1:<port>/fixed"
    }
    route http://curl.test/ {
      command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
    }
    route POST http://example.com/ {
+     respond 201 "created"
    }
    route https?://example.com/ {
+     respond 200 "good"
    }
  }
```

## its pattern is a real wildcard, not the text 'undefined'

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route http://specific.test/ {
      respond 200 "specific"
    }
+   route {
+     respond 202 "catch-all"
+   }
    route http://never.test/ {
      respond 200 "unreachable"
    }
  }
```

## kubectl failures are reported as a bad gateway

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
+     command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
+       engine curl
+     }
    }
    route http://127.0.0.1:<port>/node/ {
+     command_pass kubectl "pod/api-0" {
+       engine node
+     }
    }
    route http://127.0.0.1:<port>/pass/ {
      kubectl_pass "-n" "prod" "deploy/api" {
        command_pass curl "--max-time" "5"
      }
    }
    route http://127.0.0.1:<port>/default/ {
+     command_pass kubectl "pod/api-0"
    }
  }
```

## kubectl_pass with a nested command_pass curl runs the request inside the pod with the curl options

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
      command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
        engine curl
      }
    }
    route http://127.0.0.1:<port>/node/ {
      command_pass kubectl "pod/api-0" {
        engine node
      }
    }
    route http://127.0.0.1:<port>/pass/ {
+     kubectl_pass "-n" "prod" "deploy/api" {
+       command_pass curl "--max-time" "5"
+     }
    }
    route http://127.0.0.1:<port>/default/ {
      command_pass kubectl "pod/api-0"
    }
  }
```

## loadConfig reads concurrency, defaulting to 1

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://conc.test/default/ {
      command_pass curl
    }
    route http://conc.test/two/ {
      command_pass curl {
+       concurrency 2
      }
    }
  }
```

## log_file and ssl are resolved relative to the manifest, not the cwd

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "../out/rel.ndjson"
+   ssl {
+     cert "../ssl/cert.pem"
+     key "../ssl/key.pem"
+   }
  }
```

## log_file only supports .ndjson

**Status:** ✅ passed

```diff
  proxy {
+   log_file "./proxy.log"
  }
```

## log_file records request and response sharing a transaction id

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./logs/proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route https?://pass.test/ {
      proxy_pass "http://127.0.0.1:<port>"
    }
    route http://fixed.test/ {
      proxy_pass "http://127.0.0.1:<port>/fixed"
    }
    route http://curl.test/ {
      command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
    }
    route POST http://example.com/ {
      respond 201 "created"
    }
    route https?://example.com/ {
      respond 200 "good"
    }
  }
```

## log_file snapshot

**Status:** ⏳ pending

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./snap.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route POST http://example.com/ {
      respond 201 "created"
    }
    route https?://example.com/ {
      respond 200 "good"
    }
    route http://pass.test/ {
      proxy_pass "http://127.0.0.1:<port>"
    }
  }
```

## logs the curl command that was executed

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./proxy.ndjson"
    route http://logcmd.test/curl {
+     command_pass curl "--max-time" "5"
    }
    route http://127.0.0.1:<port>/node {
+     command_pass node "--no-warnings"
    }
    route http://logcmd.test/ssh {
+     command_pass ssh "-p" "2222" "user@remote.test"
    }
    route http://logcmd.test/kubectl {
+     command_pass kubectl "-n" "prod" "deploy/api"
    }
    route http://logcmd.test/respond {
      respond 200 "plain"
    }
  }
```

## logs the kubectl command that was executed

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./proxy.ndjson"
    route http://logcmd.test/curl {
+     command_pass curl "--max-time" "5"
    }
    route http://127.0.0.1:<port>/node {
+     command_pass node "--no-warnings"
    }
    route http://logcmd.test/ssh {
+     command_pass ssh "-p" "2222" "user@remote.test"
    }
    route http://logcmd.test/kubectl {
+     command_pass kubectl "-n" "prod" "deploy/api"
    }
    route http://logcmd.test/respond {
      respond 200 "plain"
    }
  }
```

## logs the node command that was executed

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./proxy.ndjson"
    route http://logcmd.test/curl {
+     command_pass curl "--max-time" "5"
    }
    route http://127.0.0.1:<port>/node {
+     command_pass node "--no-warnings"
    }
    route http://logcmd.test/ssh {
+     command_pass ssh "-p" "2222" "user@remote.test"
    }
    route http://logcmd.test/kubectl {
+     command_pass kubectl "-n" "prod" "deploy/api"
    }
    route http://logcmd.test/respond {
      respond 200 "plain"
    }
  }
```

## logs the ssh command that was executed, including the remote command

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./proxy.ndjson"
    route http://logcmd.test/curl {
+     command_pass curl "--max-time" "5"
    }
    route http://127.0.0.1:<port>/node {
+     command_pass node "--no-warnings"
    }
    route http://logcmd.test/ssh {
+     command_pass ssh "-p" "2222" "user@remote.test"
    }
    route http://logcmd.test/kubectl {
+     command_pass kubectl "-n" "prod" "deploy/api"
    }
    route http://logcmd.test/respond {
      respond 200 "plain"
    }
  }
```

## manifest validation for kubectl

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route / {
+  command_pass kubectl
   }
  }
```

## manifest validation for kubectl_pass

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route / {
+  kubectl_pass {
+  command_pass curl
+  }
   }
  }
```

## manifest validation for ssh and engine

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route / {
+  command_pass ssh
   }
  }
```

## manifest.donly configures the proxy

**Status:** ✅ passed

```diff
  proxy {
+   host "127.0.0.1"
+   port 0
    log_file "./logs/proxy.ndjson"
+   ssl {
+     cert "./certs/cert.pem"
+     key "./certs/key.pem"
+   }
    route https?://pass.test/ {
      proxy_pass "http://127.0.0.1:<port>"
    }
    route http://fixed.test/ {
      proxy_pass "http://127.0.0.1:<port>/fixed"
    }
    route http://curl.test/ {
      command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
    }
    route POST http://example.com/ {
      respond 201 "created"
    }
    route https?://example.com/ {
      respond 200 "good"
    }
  }
```

## methods other than GET and POST are refused

**Status:** ✅ passed

```diff
  proxy {
    route / {
      command_pass ssh "user@remote.test" {
+       engine wget
      }
    }
  }
```

## proxy_pass forwards method, path, query and body to the target

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./logs/proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route https?://pass.test/ {
+     proxy_pass "http://127.0.0.1:<port>"
    }
    route http://fixed.test/ {
+     proxy_pass "http://127.0.0.1:<port>/fixed"
    }
    route http://curl.test/ {
      command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
    }
    route POST http://example.com/ {
      respond 201 "created"
    }
    route https?://example.com/ {
      respond 200 "good"
    }
  }
```

## proxy_pass with a target path replaces the path

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./logs/proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route https?://pass.test/ {
+     proxy_pass "http://127.0.0.1:<port>"
    }
    route http://fixed.test/ {
+     proxy_pass "http://127.0.0.1:<port>/fixed"
    }
    route http://curl.test/ {
      command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
    }
    route POST http://example.com/ {
      respond 201 "created"
    }
    route https?://example.com/ {
      respond 200 "good"
    }
  }
```

## proxy_pass works through an https tunnel

**Status:** ⏳ pending

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./logs/proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
    route https?://pass.test/ {
+     proxy_pass "http://127.0.0.1:<port>"
    }
    route http://fixed.test/ {
+     proxy_pass "http://127.0.0.1:<port>/fixed"
    }
    route http://curl.test/ {
      command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
    }
    route POST http://example.com/ {
      respond 201 "created"
    }
    route https?://example.com/ {
      respond 200 "good"
    }
  }
```

## request data cannot break out of the shell quoting

**Status:** ✅ passed

```diff
  proxy {
    route / {
      command_pass ssh "user@remote.test" {
+       engine wget
      }
    }
  }
```

## request data never reaches the command line or a shell

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
+     command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {
+       engine curl
+     }
    }
    route http://127.0.0.1:<port>/node/ {
+     command_pass kubectl "pod/api-0" {
+       engine node
+     }
    }
    route http://127.0.0.1:<port>/pass/ {
      kubectl_pass "-n" "prod" "deploy/api" {
        command_pass curl "--max-time" "5"
      }
    }
    route http://127.0.0.1:<port>/default/ {
+     command_pass kubectl "pod/api-0"
    }
  }
```

## request data never reaches the remote command line or a shell

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
+     command_pass ssh "-p" "2222" "user@remote.test" {
+       engine curl
+     }
    }
    route http://127.0.0.1:<port>/node/ {
+     command_pass ssh "user@remote.test" {
+       engine node
+     }
    }
    route http://127.0.0.1:<port>/default/ {
+     command_pass ssh "user@remote.test"
    }
  }
```

## requests that match no route respond ok

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./logs/proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
+   route https?://pass.test/ {
+     proxy_pass "http://127.0.0.1:<port>"
+   }
+   route http://fixed.test/ {
+     proxy_pass "http://127.0.0.1:<port>/fixed"
+   }
+   route http://curl.test/ {
+     command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
+   }
+   route POST http://example.com/ {
+     respond 201 "created"
+   }
+   route https?://example.com/ {
+     respond 200 "good"
+   }
  }
```

## route can be limited by method

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./logs/proxy.ndjson"
    ssl {
      cert "./certs/cert.pem"
      key "./certs/key.pem"
    }
+   route https?://pass.test/ {
+     proxy_pass "http://127.0.0.1:<port>"
+   }
+   route http://fixed.test/ {
+     proxy_pass "http://127.0.0.1:<port>/fixed"
+   }
+   route http://curl.test/ {
+     command_pass curl "--connect-to" "curl.test:80:127.0.0.1:<port>"
+   }
+   route POST http://example.com/ {
+     respond 201 "created"
+   }
+   route https?://example.com/ {
+     respond 200 "good"
+   }
  }
```

## routes without command_pass log no command

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
+   log_file "./proxy.ndjson"
    route http://logcmd.test/curl {
      command_pass curl "--max-time" "5"
    }
    route http://127.0.0.1:<port>/node {
      command_pass node "--no-warnings"
    }
    route http://logcmd.test/ssh {
      command_pass ssh "-p" "2222" "user@remote.test"
    }
    route http://logcmd.test/kubectl {
      command_pass kubectl "-n" "prod" "deploy/api"
    }
    route http://logcmd.test/respond {
+     respond 200 "plain"
    }
  }
```

## runs one process at a time by default

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://conc.test/default/ {
+     command_pass curl
    }
    route http://conc.test/two/ {
+     command_pass curl {
+       concurrency 2
+     }
    }
  }
```

## should load the proxy block of the manifest

**Status:** ✅ passed

```diff
+ proxy {
+   host "127.0.0.1"
+   port 3000
+ }
```

## should read the port from the manifest

**Status:** 🔴 failed

```diff
  proxy {
    host "127.0.0.1"
-   port 3000
  }
```

## should read the port from the manifest

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
+   port 3000
  }
```

## ssh failures are reported as a bad gateway

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://127.0.0.1:<port>/curl/ {
+     command_pass ssh "-p" "2222" "user@remote.test" {
+       engine curl
+     }
    }
    route http://127.0.0.1:<port>/node/ {
+     command_pass ssh "user@remote.test" {
+       engine node
+     }
    }
    route http://127.0.0.1:<port>/default/ {
+     command_pass ssh "user@remote.test"
    }
  }
```

## the status and headers are read from the last response printed by -S

**Status:** ✅ passed

```diff
  proxy {
    route / {
      command_pass ssh "user@remote.test" {
+       engine wget
      }
    }
  }
```

## waiting requests are served in arrival order

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    route http://conc.test/default/ {
+     command_pass curl
    }
    route http://conc.test/two/ {
+     command_pass curl {
+       concurrency 2
+     }
    }
  }
```

## wget answers GET requests and reports the status of failed ones

**Status:** ✅ passed

```diff
  proxy {
    host "127.0.0.1"
    port 0
    log_file "./proxy.ndjson"
    route http://echo.donly-proxy-test.svc.cluster.local/wget/ {
+     kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {
+       command_pass wget
+     }
    }
  }
```

## without a status line the failure is reported

**Status:** ✅ passed

```diff
  proxy {
    route / {
      command_pass ssh "user@remote.test" {
+       engine wget
      }
    }
  }
```
