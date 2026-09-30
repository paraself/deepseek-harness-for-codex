import { createServer } from "node:http";

let nextWorkspace = 1;
let nextSession = 1;
const sessions = new Map();

function ok(rpcId, value) {
  return { type: "server-response", rpcId, result: { ok: true, value } };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fake.invalid");
  const authToken = process.env.FAKE_DSH_AUTH_TOKEN;
  if (authToken && request.method === "GET" && url.pathname === "/" && url.searchParams.get("token") === authToken) {
    response.writeHead(303, { location: "/", "set-cookie": "fake_dsh=authenticated; HttpOnly; Path=/" });
    response.end();
    return;
  }
  if (authToken && !request.headers.cookie?.includes("fake_dsh=authenticated")) {
    response.writeHead(401, { "content-type": "text/plain" });
    response.end("authentication required");
    return;
  }
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>Fake DeepSeek Harness Web</body></html>");
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const message = JSON.parse(body);
    const { method, payload, rpcId } = message;
    if (url.pathname !== `/api/${method}`) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const args = payload.args;
    let value;
    if (method === "workspace/create") {
      value = { workspace: { workspaceId: `workspace-${nextWorkspace++}` }, created: true };
    } else if (method === "session/create") {
      const sessionId = `session-${nextSession++}`;
      sessions.set(sessionId, { running: false, events: [], task: "", title: null });
      value = { sessionId };
    } else if (method === "session/prompt") {
      const prompt = args.request;
      if (typeof prompt.requestId !== "string" || prompt.requestId.length === 0) throw new Error("missing requestId");
      const session = sessions.get(prompt.sessionId);
      session.running = true;
      session.task = prompt.content[0].text;
      if (session.events.length === 0) {
        session.title = session.task === "title-provider" || session.task === "title-fallback" ? "fallback title" : `auto:${session.task}`;
        session.events.push({ event: { type: "session/title", seq: session.events.length, data: { title: session.title, source: { kind: "fallback" } } } });
        if (session.task === "title-provider") {
          session.events.push({ event: { type: "session/title-llm-request", seq: session.events.length, data: {} } });
          setTimeout(() => {
            session.title = "generated title";
            session.events.push({ event: { type: "session/title", seq: session.events.length, data: { title: session.title, source: { kind: "provider" } } } });
          }, 400);
        }
      }
      session.events.push({ event: { type: "turn/start", seq: session.events.length, data: {} } });
      if (session.task === "request approval") {
        session.events.push({
          event: {
            type: "approval/asked",
            seq: session.events.length,
            data: { id: "approval-1", toolName: "pwsh", reason: "Needs elevated access" },
          },
        });
        value = { accepted: true };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(ok(rpcId, value)));
        return;
      }
      setTimeout(() => {
        if (session.task === "be blocked") {
          session.events.push({ event: { type: "turn/end", seq: session.events.length, data: { reason: { kind: "blocked" } } } });
          session.running = false;
          return;
        }
        const terminalKinds = new Map([
          ["end with error", "error"],
          ["end with max tokens", "max-tokens"],
          ["end interrupted", "interrupted"],
          ["end aborted", "aborted"],
        ]);
        const terminalKind = terminalKinds.get(session.task);
        if (terminalKind) {
          session.events.push({ event: { type: "turn/end", seq: session.events.length, data: { reason: { kind: terminalKind } } } });
          session.running = false;
          return;
        }
        if (session.task.includes("DSH_MCP_SANDBOX_DIAGNOSTIC")) {
          session.events.push({
            event: {
              type: "tool/call",
              seq: session.events.length,
              data: { callId: "sandbox-tool-1", name: "shell", arguments: '{"script":"import tempfile; tempfile.TemporaryDirectory()"}' },
            },
          });
          session.events.push({
            event: {
              type: "tool/result",
              seq: session.events.length,
              data: {
                message: {
                  content: [{ type: "tool-result", toolCallId: "sandbox-tool-1", content: [{ type: "text", text: "ok" }] }],
                },
              },
            },
          });
        }
        session.events.push({
          event: {
            type: "assistant/message",
            seq: session.events.length,
            data: {
              message: {
                content: [{
                  type: "text",
                  text: session.task.includes("DSH_MCP_SANDBOX_DIAGNOSTIC")
                    ? "DSH_SANDBOX_READY"
                    : `completed:${session.task}`,
                }],
              },
            },
          },
        });
        session.events.push({ event: { type: "turn/end", seq: session.events.length, data: { reason: { kind: "completed" } } } });
        session.running = false;
      }, 200);
      value = { accepted: true };
    } else if (method === "session/list") {
      value = { items: [...sessions].map(([sessionId, session]) => ({
        sessionId,
        running: session.running,
        blank: session.events.length === 0,
        projections: { asOfSeq: session.events.at(-1)?.event.seq ?? -1, values: { title: session.title } },
      })) };
    } else if (method === "session/page") {
      const page = args.request;
      const events = sessions.get(page.address.sessionId)?.events ?? [];
      value = { records: events.filter(({ event }) => event.seq <= page.throughSeq), hasMore: false };
    } else if (method === "session/cancel") {
      const session = sessions.get(args.request.sessionId);
      session.running = false;
      session.events.push({ event: { type: "turn/end", seq: session.events.length, data: { reason: { kind: "aborted" } } } });
      value = { accepted: true };
    } else if (method === "session/rename") {
      const session = sessions.get(args.request.sessionId);
      session.title = args.request.title;
      session.events.push({ event: { type: "session/title", seq: session.events.length, data: { title: session.title, source: { kind: "user" } } } });
      value = { title: session.title, seq: session.events.at(-1).event.seq };
    } else {
      value = {};
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(ok(rpcId, value)));
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const token = process.env.FAKE_DSH_AUTH_TOKEN;
  process.stdout.write(`dsh web: http://127.0.0.1:${address.port}${token ? `/?token=${token}` : ""}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
