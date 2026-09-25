// Serve only the built static site; raw sessions and host files are never exposed.
import { resolve, sep } from "node:path";
const root = resolve(import.meta.dir, "../dist");
const i = process.argv.indexOf("--port"),
  port = Number(i >= 0 ? process.argv[i + 1] : 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid port");
if (!(await Bun.file(root + "/index.html").exists()))
  throw Error("Run pnpm viewer:build first");
Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response("Bad path", { status: 400 });
    }
    const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
    if (!file.startsWith(root + sep))
      return new Response("Not found", { status: 404 });
    const data = Bun.file(file);
    return (await data.exists())
      ? new Response(data, { headers: { "X-Content-Type-Options": "nosniff" } })
      : new Response("Not found", { status: 404 });
  },
});
console.log(`Static viewer: http://127.0.0.1:${port}`);
