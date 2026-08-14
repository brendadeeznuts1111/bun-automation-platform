#!/usr/bin/env bun
/**
 * Dev/staging server for the Bun Automation Platform dashboard.
 *
 * Enables HTTP/3 (QUIC) alongside HTTP/1.1 on the same port. Browsers
 * auto-upgrade via Alt-Svc after the first HTTP/1.1 response.
 *
 * Requires TLS (HTTP/3 runs over UDP + QUIC, which mandates TLS).
 * For dev, we use a self-signed cert — generate with:
 *   openssl req -x509 -newkey rsa:2048 -keyout dev-key.pem -out dev-cert.pem \
 *     -days 365 -nodes -subj "/CN=localhost"
 *
 * Usage:
 *   bun run dev-server.ts
 *
 * Then open https://localhost:3000 (accept the self-signed cert warning).
 */

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const CERT = process.env.TLS_CERT_PATH ?? "dev-cert.pem";
const KEY = process.env.TLS_KEY_PATH ?? "dev-key.pem";

// Check cert/key exist
const certFile = Bun.file(CERT);
const keyFile = Bun.file(KEY);
if (!(await certFile.exists()) || !(await keyFile.exists())) {
  console.error(
    `Missing TLS cert/key. Generate with:\n` +
      `  openssl req -x509 -newkey rsa:2048 -keyout dev-key.pem -out dev-cert.pem -days 365 -nodes -subj "/CN=localhost"`,
  );
  process.exit(1);
}

const cert = await certFile.text();
const key = await keyFile.text();

const server = Bun.serve({
  port: PORT,
  tls: { cert, key },
  http3: true, // Serve HTTP/3 over UDP on the same port
  fetch(req) {
    const url = new URL(req.url);

    // Alt-Svc header tells browsers to upgrade to HTTP/3 for future requests.
    // h3-29 is the IETF draft version Bun implements.
    const headers = {
      "Alt-Svc": `h3=":${PORT}"; ma=86400`,
      "Content-Type": "text/html",
    };

    if (url.pathname === "/") {
      return new Response(
        `<!DOCTYPE html>
<html>
<head><title>Bun Automation Platform — Dev</title></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 2rem auto;">
  <h1>Bun Automation Platform</h1>
  <p>Dev server running on Bun v${Bun.version}</p>
  <p>HTTP/3 enabled — browsers will auto-upgrade via Alt-Svc.</p>
  <h2>Endpoints</h2>
  <ul>
    <li><a href="/health">/health</a> — health check</li>
    <li><a href="/protocol">/protocol</a> — check which protocol this request used</li>
  </ul>
</body>
</html>`,
        { headers },
      );
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: Bun.version }, { headers });
    }

    if (url.pathname === "/protocol") {
      // Bun doesn't expose the negotiated protocol directly, but we can
      // infer from the Alt-Svc header: if the client already has the Alt-Svc
      // cached, it's using HTTP/3.
      return Response.json(
        {
          method: req.method,
          url: req.url,
          userAgent: req.headers.get("user-agent"),
          note: "Check browser devtools Network tab — protocol column shows h3 or http/1.1",
        },
        { headers },
      );
    }

    return new Response("Not found", { status: 404, headers });
  },
});

console.log(`Dev server running on https://localhost:${server.port}`);
console.log(`  HTTP/1.1:  TCP/${server.port}`);
console.log(`  HTTP/3:    UDP/${server.port} (QUIC)`);
console.log(`  Alt-Svc:   h3=":${server.port}"; ma=86400`);
console.log(`\nOpen https://localhost:${server.port} in your browser.`);
console.log(`(Accept the self-signed cert warning on first visit.)`);
