// Local HTTP proxy that sits between Claude Code and GLM (or any Anthropic-
// compatible upstream). It forwards every request verbatim — including the
// Authorization header Claude Code already attaches — so it stores no
// credentials. For streaming responses it tees the body: one copy flows
// untouched to Claude Code, the other is parsed for SSE events that feed the
// rate tracker, which writes the live tok/s to the status file.
//
// Binds to 127.0.0.1 only — never exposes traffic off the loopback interface.

import http from "node:http";

import { createSseParser } from "./sseParser.js";
import { createRateTracker } from "./rateTracker.js";

const SSE_CONTENT_TYPE = "text/event-stream";

// Headers that must not be copied across a proxy hop. Content-Encoding/Length
// are dropped because undici hands us a *decompressed* body; echoing the
// original encoding headers would make the client try to decode already-decoded
// bytes.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding"
]);

function forwardRequestHeaders(req, upstreamHost) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    headers[key] = value;
  }
  headers.host = upstreamHost;
  return headers;
}

function collectResponseHeaders(upstreamHeaders) {
  const headers = {};
  upstreamHeaders.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      return;
    }
    headers[key] = value;
  });
  return headers;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Route a parsed SSE event to the rate tracker.
function handleSseEvent(evt, tracker) {
  if (!evt.data) {
    return;
  }
  let payload;
  try {
    payload = JSON.parse(evt.data);
  } catch {
    return; // non-JSON data line (e.g. ping) — ignore
  }

  const type = payload.type || evt.event;
  if (type === "message_start") {
    tracker.onMessageStart();
  } else if (type === "message_delta") {
    const cum = payload?.usage?.output_tokens;
    if (Number.isFinite(cum)) {
      tracker.onMessageDelta(cum);
    }
  } else if (type === "content_block_delta") {
    tracker.onTextDelta();
  } else if (type === "message_stop") {
    tracker.onMessageStop();
  }
}

export function startProxyServer(options = {}) {
  const port = options.port;
  const upstreamBase = String(options.upstream || "").replace(/\/+$/, "");
  if (!upstreamBase) {
    throw new Error("startProxyServer requires an upstream base URL");
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(upstreamBase);
  } catch {
    throw new Error(`Invalid upstream base URL: ${upstreamBase}`);
  }

  const tracker = options.tracker || createRateTracker({ writeLiveRate: options.writeLiveRate });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const debug = Boolean(options.debug);
  const log = (msg) => {
    if (debug) {
      process.stderr.write(`[proxy] ${msg}\n`);
    }
  };

  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is unavailable (Node >= 18 required)");
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const body = await readRequestBody(req);
      const target = upstreamBase + req.url;
      const headers = forwardRequestHeaders(req, upstreamUrl.host);

      log(`${req.method} ${req.url}`);

      const upstream = await fetchImpl(target, {
        method: req.method,
        headers,
        body: body.length ? body : undefined
      });

      const respHeaders = collectResponseHeaders(upstream.headers);
      const contentType = upstream.headers.get("content-type") || "";
      const isSSE = contentType.includes(SSE_CONTENT_TYPE) && upstream.body;

      if (isSSE) {
        res.writeHead(upstream.status, {
          ...respHeaders,
          "content-type": SSE_CONTENT_TYPE,
          "cache-control": "no-cache"
        });

        const [toClient, toParse] = upstream.body.tee();
        const parser = createSseParser();
        tracker.onMessageStart();

        const parseJob = (async () => {
          try {
            for await (const chunk of toParse) {
              for (const evt of parser.feed(Buffer.from(chunk).toString())) {
                handleSseEvent(evt, tracker);
              }
            }
            for (const evt of parser.end()) {
              handleSseEvent(evt, tracker);
            }
          } catch (err) {
            log(`parse error: ${err.message}`);
          }
        })();

        const pipeJob = (async () => {
          try {
            for await (const chunk of toClient) {
              if (!res.write(Buffer.from(chunk))) {
                await new Promise((resolve) => res.once("drain", resolve));
              }
            }
          } catch (err) {
            log(`pipe error: ${err.message}`);
          } finally {
            try {
              res.end();
            } catch {}
          }
        })();

        await Promise.all([pipeJob, parseJob]);
        log(`streamed ${req.url} in ${Date.now() - started}ms`);
      } else {
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, respHeaders);
        res.end(buf);
        log(`${req.method} ${req.url} → ${upstream.status} (${buf.length}B)`);
      }
    } catch (err) {
      log(`error: ${err.message}`);
      try {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: "proxy_error", message: err.message }));
        }
      } catch {}
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const addr = server.address();
      resolve({
        server,
        tracker,
        port: addr.port,
        host: "127.0.0.1",
        close: () => {
          tracker.stop();
          server.close();
        }
      });
    });
  });
}
