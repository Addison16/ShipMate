# Behind a reverse proxy

Shipmate is one web server on port 3000: the web app, the API and one WebSocket
(`/api/ws`, the Bridge's live channel) all on the same port. Any reverse proxy that passes
WebSockets works. You need three things:

1. **Its own address.** Serve Shipmate at the root of a (sub)domain, such as
   `https://shipmate.example.com`. A sub-path (`https://example.com/shipmate`) is not supported.
2. **`SHIPMATE_URL` set to that address**, exactly as people type it: `https://shipmate.example.com`.
   Restart Shipmate after changing it.
3. **WebSockets on**, and room for uploads: photos, PDFs and voice are up to 25 MB.

Then open **Health** in Shipmate (owners and admins). The **Web address** check says whether
the address you opened matches `SHIPMATE_URL`, and whether the proxy's https reached Shipmate.

## What Shipmate expects from the proxy

| | |
|---|---|
| Upstream | `http://<shipmate-host>:3000` (plain http; the proxy does TLS) |
| WebSocket | `GET /api/ws` with `Upgrade` and `Connection` headers passed through |
| Headers | `Host` (or `X-Forwarded-Host`), `X-Forwarded-Proto`, `X-Forwarded-For`; every proxy below sends them by default or in the snippet |
| Body size | at least 30 MB (`client_max_body_size 30m` on nginx; nginx's default of 1 MB breaks photo and voice uploads) |
| Timeouts | Shipmate pings the WebSocket every 25 s, so the usual 60 s idle timeouts are fine |
| Buffering | nothing streams over plain HTTP; replies stream over the WebSocket |

### Trusting the proxy

Shipmate believes `X-Forwarded-*` headers only from proxies listed in `SHIPMATE_TRUST_PROXY`.
The default (`loopback,linklocal,uniquelocal`) covers a proxy on the same machine, on a Docker
network, or elsewhere on a private LAN, which is nearly every home setup. If your proxy reaches
Shipmate from a public address (a VPS in front of a home server, for example), list that address:
`SHIPMATE_TRUST_PROXY=203.0.113.7`. To trust no proxy at all, set it to `off`.

### Opening it on the LAN as well

With `SHIPMATE_URL=https://…`, sign-in cookies are https-only, so signing in at
`http://192.168.1.10:3000` does not work: use the proxy address on the LAN too (split DNS or a
local DNS rewrite to the proxy helps). Links, webhooks and sign-in redirects always use
`SHIPMATE_URL`.

Installing the web app on a phone (PWA) and push notifications need https, which the proxy gives
you.

## Nginx Proxy Manager

**Hosts → Proxy Hosts → Add Proxy Host**:

- **Domain Names**: `shipmate.example.com`
- **Scheme** `http`, **Forward Hostname / IP**: the Unraid server's IP (or `Shipmate` when NPM is
  on the same custom Docker network), **Forward Port**: `3000`
- **Websockets Support**: on
- **Block Common Exploits**: on is fine
- **SSL** tab: request a Let's Encrypt certificate, **Force SSL** and **HTTP/2 Support** on
- **Advanced** tab, Custom Nginx Configuration:

  ```nginx
  client_max_body_size 30m;
  ```

## SWAG (linuxserver.io)

Save this as `/config/nginx/proxy-confs/shipmate.subdomain.conf` (on Unraid,
`/mnt/user/appdata/swag/nginx/proxy-confs/`) and restart SWAG. Put SWAG and Shipmate on the
same custom Docker network so `$upstream_app` resolves by container name, or set it to the
server's IP.

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    server_name shipmate.*;

    include /config/nginx/ssl.conf;

    client_max_body_size 30m;

    location / {
        include /config/nginx/proxy.conf;
        include /config/nginx/resolver.conf;
        set $upstream_app Shipmate;
        set $upstream_port 3000;
        set $upstream_proto http;
        proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    }
}
```

SWAG's `proxy.conf` already passes WebSockets and the `X-Forwarded-*` headers. Add SWAG's
`authelia` or `authentik` includes only if you want a second sign-in in front of Shipmate's own;
GitHub webhooks (`/api/hooks/`) and push actions (`/api/push/act/`) must still reach Shipmate
without it.

## Traefik

Labels on the Shipmate container (Traefik v2 or v3, with an entrypoint named `websecure` and a
certificate resolver named `letsencrypt`):

```yaml
services:
  shipmate:
    image: ghcr.io/addison16/shipmate:latest
    environment:
      SHIPMATE_URL: https://shipmate.example.com
    labels:
      - traefik.enable=true
      - traefik.http.routers.shipmate.rule=Host(`shipmate.example.com`)
      - traefik.http.routers.shipmate.entrypoints=websecure
      - traefik.http.routers.shipmate.tls.certresolver=letsencrypt
      - traefik.http.services.shipmate.loadbalancer.server.port=3000
    networks: [proxy]
```

Traefik passes WebSockets and `X-Forwarded-*` on its own and has no body size limit by default.
On Unraid, add the same labels in the template (**Add another Path, Port, Variable, Label or
Device → Label**) and set the container's network to Traefik's.

## Caddy

```caddyfile
shipmate.example.com {
    reverse_proxy 192.168.1.10:3000
}
```

That is all: Caddy gets the certificate, passes WebSockets and sets `X-Forwarded-*`.

## Plain nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name shipmate.example.com;
    ssl_certificate     /etc/ssl/shipmate/fullchain.pem;
    ssl_certificate_key /etc/ssl/shipmate/privkey.pem;

    client_max_body_size 30m;

    location / {
        proxy_pass http://192.168.1.10:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

## Cloudflare Tunnel

Point a public hostname at `http://<shipmate-host>:3000` (service type HTTP). WebSockets work
without extra settings. `cloudflared` reaches Shipmate from a private address, so the default
`SHIPMATE_TRUST_PROXY` already trusts it. Cloudflare's free plan limits uploads to 100 MB, well
above Shipmate's 25 MB.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Signing in does nothing, or you are sent back to the sign-in page | You opened an address other than `SHIPMATE_URL`, or the proxy's https did not reach Shipmate. The **Web address** check on Health says which. |
| The Bridge says "reconnecting" over and over | WebSockets are off on the proxy (NPM: **Websockets Support**). |
| Photos or voice messages fail with "413" | The proxy's body size limit; set `client_max_body_size 30m`. |
| GitHub webhooks fail | `SHIPMATE_URL` is a LAN address GitHub cannot reach, or a second sign-in in front of Shipmate blocks `/api/hooks/`. |
| Health says the page arrived over plain http | The proxy does not send `X-Forwarded-Proto`, or it is not covered by `SHIPMATE_TRUST_PROXY`. |
