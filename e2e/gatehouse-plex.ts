// A loopback Plex origin for the local harnesses (dev.sh, run.sh, and the verify-* scripts).
//
// Each request goes out through the credential broker's helper (`gatehouse-request plex …`),
// which adds the Plex token on its side. So the harness never reads a token or an env file,
// and the server under test only ever holds a placeholder token. Point the server at
// this process with PLEX_API_SERVER_URL=http://127.0.0.1:<port>.
//
//   server/node_modules/.bin/tsx e2e/gatehouse-plex.ts
//
// Environment:
//   GATEHOUSE_REQUEST     the helper (default /work/bin/gatehouse-request)
//   GATEHOUSE_PLEX_PORT   the loopback port (default 18799)
//
// Limits, all from the helper: it reports no response headers, so the Content-Type is sniffed
// from the body; it reports the status only for an error, so every success is a 200; and the
// broker refuses HEAD, so a HEAD is sent as a GET and its body dropped. Plex.tv calls do not
// pass through here, so features that need plex.tv (Home users, per-account tokens, devices)
// fall back to their degraded paths in these harnesses.
import { spawn } from "node:child_process"
import { resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"

const HELPER =
  process.env.GATEHOUSE_REQUEST ||
  "/work/bin/gatehouse-request"
const PORT = Number(
  process.env.GATEHOUSE_PLEX_PORT || 18799,
)
// One helper process per request; a page of posters must not start a hundred at once.
const MAX_IN_FLIGHT = 8

/** The request path without any X-Plex-Token query parameter, byte for byte otherwise. */
export const withoutToken = (url: string): string => {
  const at = url.indexOf("?")
  if (at < 0) return url
  const kept = url
    .slice(at + 1)
    .split("&")
    .filter((part) => {
      const name = part.split("=", 1)[0] ?? ""
      let decoded = name
      try {
        decoded = decodeURIComponent(name)
      } catch {
        // A malformed escape is not the token parameter; keep it and let the broker judge.
      }
      return decoded.toLowerCase() !== "x-plex-token"
    })
  return kept.length && kept.some(Boolean)
    ? `${url.slice(0, at)}?${kept.join("&")}`
    : url.slice(0, at)
}

/** A Content-Type for a body whose real header the helper does not report. */
export const sniffType = (body: Buffer): string => {
  const head = body.subarray(0, 16)
  const text = head.toString("latin1").trimStart()
  if (text.startsWith("{") || text.startsWith("["))
    return "application/json"
  if (text.startsWith("<")) return "text/xml"
  if (
    head[0] === 0x89 &&
    head.toString("latin1", 1, 4) === "PNG"
  )
    return "image/png"
  if (head[0] === 0xff && head[1] === 0xd8)
    return "image/jpeg"
  if (head.toString("latin1", 0, 4) === "GIF8")
    return "image/gif"
  if (
    head.toString("latin1", 0, 4) === "RIFF" &&
    head.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp"
  return "application/octet-stream"
}

type Reply = { status: number; body: Buffer }

/** The status a helper run stands for: 0 is a success, 3 an upstream error it names, 4 a denial. */
export const statusOf = (
  exitCode: number | null,
  stderr: string,
): number => {
  if (exitCode === 0) return 200
  if (exitCode === 3) {
    const found = /answered HTTP (\d{3})/.exec(stderr)
    return found ? Number(found[1]) : 502
  }
  if (exitCode === 4) return 403
  return 502
}

const readBody = (
  request: IncomingMessage,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) =>
      chunks.push(chunk),
    )
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })

const runHelper = (
  method: string,
  path: string,
  headers: string[],
  body: Buffer,
): Promise<Reply> =>
  new Promise((resolve) => {
    const args = ["plex", method, path]
    for (const header of headers)
      args.push("--header", header)
    const isSending =
      body.length > 0 || !["GET", "HEAD"].includes(method)
    if (isSending) args.push("--data", "-")
    const child = spawn(HELPER, args, {
      // /dev/null keeps the helper from reading an env file, even if a fallback rule is
      // ever added for Plex.
      env: {
        ...process.env,
        GATEHOUSE_FALLBACK_ENV_FILE: "/dev/null",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) =>
      out.push(chunk),
    )
    child.stderr.on("data", (chunk: Buffer) =>
      err.push(chunk),
    )
    child.on("error", (error) =>
      resolve({
        status: 502,
        body: Buffer.from(
          JSON.stringify({
            error: "gatehouse-request did not start",
            detail: error.message,
          }),
        ),
      }),
    )
    child.on("close", (code) => {
      const stderr = Buffer.concat(err)
        .toString("utf8")
        .trim()
      const status = statusOf(code, stderr)
      if (code !== 0 && code !== 3) {
        // A refusal, a hold, or an unknown outcome: say so, and never retry it another way.
        resolve({
          status,
          body: Buffer.from(
            JSON.stringify({
              error: "gatehouse",
              exitCode: code,
              detail: stderr,
            }),
          ),
        })
        return
      }
      resolve({ status, body: Buffer.concat(out) })
    })
    child.stdin.end(isSending ? body : undefined)
  })

// Headers worth passing on. The token never is: the broker adds the real one.
const PASSED = ["accept", "content-type", "accept-language"]
const passedHeaders = (
  request: IncomingMessage,
): string[] =>
  Object.entries(request.headers).flatMap(
    ([name, value]) => {
      const lower = name.toLowerCase()
      const isPassed =
        PASSED.includes(lower) ||
        (lower.startsWith("x-plex-") &&
          lower !== "x-plex-token")
      if (!isPassed || value === undefined) return []
      return [
        `${name}: ${Array.isArray(value) ? value.join(", ") : value}`,
      ]
    },
  )

let inFlight = 0
const waiting: Array<() => void> = []
const slot = async (): Promise<() => void> => {
  if (inFlight >= MAX_IN_FLIGHT)
    await new Promise<void>((resolve) =>
      waiting.push(resolve),
    )
  inFlight += 1
  return () => {
    inFlight -= 1
    waiting.shift()?.()
  }
}

const handle = async (
  request: IncomingMessage,
  response: ServerResponse,
) => {
  const method = (request.method || "GET").toUpperCase()
  const path = withoutToken(request.url || "/")
  const body = await readBody(request)
  const release = await slot()
  try {
    const reply = await runHelper(
      method === "HEAD" ? "GET" : method,
      path,
      passedHeaders(request),
      body,
    )
    response.writeHead(reply.status, {
      "Content-Type": sniffType(reply.body),
      "Content-Length": String(reply.body.length),
    })
    response.end(method === "HEAD" ? undefined : reply.body)
  } finally {
    release()
  }
}

export const startGatehousePlex = (port = PORT) =>
  new Promise<ReturnType<typeof createServer>>(
    (resolve) => {
      const server = createServer((request, response) => {
        handle(request, response).catch(
          (error: unknown) => {
            response.writeHead(502, {
              "Content-Type": "application/json",
            })
            response.end(
              JSON.stringify({ error: String(error) }),
            )
          },
        )
      })
      server.listen(port, "127.0.0.1", () =>
        resolve(server),
      )
    },
  )

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    resolvePath(process.argv[1])
) {
  await startGatehousePlex()
  console.log(
    `[gatehouse-plex] Plex through gatehouse-request on http://127.0.0.1:${PORT}`,
  )
}
