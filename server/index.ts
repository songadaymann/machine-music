// The Music Place -- Server entry point

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

// Serve static client files
app.use("/*", serveStatic({ root: "./client" }));

const PORT = Number(process.env.PORT) || 4000;

console.log(`
╔══════════════════════════════════════╗
║       the_music_place                ║
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
