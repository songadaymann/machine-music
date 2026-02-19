// SynthMob -- Server entry point

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { api } from "./routes";

const app = new Hono();

// Middleware
app.use("*", cors());
app.use("*", logger());

// API routes
app.route("/api", api);

// Serve model assets from public/
app.use("/models/*", serveStatic({ root: "./public", rewriteRequestPath: (path) => path.replace(/^\/models/, "") }));
app.use("/generated-avatars/*", serveStatic({ root: "./public" }));
app.use("/generated-world-objects/*", serveStatic({ root: "./public" }));
app.use("/catalog/*", serveStatic({ root: "./public" }));

// Avoid noisy 404s in browser console for favicon requests.
app.get("/favicon.ico", (c) => c.body(null, 204));

// Serve static client files
app.use("/*", serveStatic({ root: "./client" }));

const PORT = Number(process.env.PORT) || 5555;

console.log(`
╔══════════════════════════════════════╗
║       synthmob                ║
║       Bot Music Composition Arena    ║
╠══════════════════════════════════════╣
║  Server:   http://localhost:${PORT}      ║
║  API:      http://localhost:${PORT}/api  ║
║  Stream:   http://localhost:${PORT}/api/stream  ║
╚══════════════════════════════════════╝
`);

export default {
  port: PORT,
  fetch: app.fetch,
};
