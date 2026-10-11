import { createServer } from "node:http";
import { WebSocketServer } from "ws";

let nextWorkspace = 1;
let nextSession = 1;
const sessions = new Map();
const archivedSessionIds = new Set();
const workspaces = new Map();
let deleteRequests = 0;
let followRequests = 0;
let cancelledFollows = 0;
const activeFollows = new Set();

function exactKeys(value, keys) {
  return value && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function ok(rpcId, value) {
  return { type: "server-response", rpcId, result: { ok: true, value } };
}

function fail(rpcId, code, message) {
  return { type: "server-response", rpcId, result: { ok: false, error: { code, message } } };
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
    if (url.pathname === "/__fixture_state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ deleteRequests, followRequests, cancelledFollows, activeFollows: activeFollows.size }));
      return;
    }
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
      if (!exactKeys(args, ["request"]) || !exactKeys(args.request, ["path"]) || typeof args.request.path !== "string") {
        value = fail(rpcId, "INVALID_ARGS", "workspace/create requires request.path");
      } else {
        let workspace = [...workspaces.values()].find((item) => item.path === args.request.path);
        const created = workspace === undefined;
        if (created) {
          const now = new Date().toISOString();
          workspace = { workspaceId: `workspace-${nextWorkspace++}`, path: args.request.path, title: "workspace", sessionIds: [], createdAt: now, updatedAt: now };
          workspaces.set(workspace.workspaceId, workspace);
        }
        value = { workspace, created };
      }
    } else if (method === "workspace/delete") {
      if (!exactKeys(args, ["request"]) || !exactKeys(args.request, ["workspaceId"]) || typeof args.request.workspaceId !== "string") {
        value = fail(rpcId, "INVALID_ARGS", "workspace/delete requires request.workspaceId");
      } else {
        deleteRequests++;
        if (process.env.FAKE_DSH_DELETE_ERROR) {
          value = fail(rpcId, "DELETE_UNAVAILABLE", "workspace deletion unavailable");
        } else if (!workspaces.has(args.request.workspaceId)) {
          value = fail(rpcId, "WORKSPACE_UNKNOWN", "unknown workspace");
        } else {
          workspaces.delete(args.request.workspaceId);
          value = { deleted: true };
        }
      }
    } else if (method === "session/create") {
      if (!exactKeys(args, ["request"]) || !exactKeys(args.request, ["workspaceId"]) || !workspaces.has(args.request.workspaceId)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(fail(rpcId, "INVALID_ARGS", "session/create requires an existing workspaceId")));
        return;
      }
      const sessionId = `session-${nextSession++}`;
      sessions.set(sessionId, { running: false, events: [], task: "", title: null });
      workspaces.get(args.request.workspaceId).sessionIds.push(sessionId);
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
      setTimeout(() => {
        if (!session.running) return;
        if (session.task === "fail") {
          session.events.push({ event: { type: "agent/error", seq: session.events.length, data: { message: "agent failed" } } });
          session.events.push({ event: { type: "turn/end", seq: session.events.length, data: { reason: "error" } } });
          session.running = false;
          return;
        }
        session.events.push({
          event: {
            type: "assistant/message",
            seq: session.events.length,
            data: { message: { content: [{ type: "text", text: `completed:${session.task}` }] } },
          },
        });
        session.events.push({ event: { type: "turn/end", seq: session.events.length, data: { reason: "stop" } } });
        session.running = false;
      }, session.task === "long task" ? 800 : 200);
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
      session.events.push({ event: { type: "turn/end", seq: session.events.length, data: { reason: "cancelled" } } });
      value = { accepted: true };
    } else if (method === "session/rename") {
      const session = sessions.get(args.request.sessionId);
      session.title = args.request.title;
      session.events.push({ event: { type: "session/title", seq: session.events.length, data: { title: session.title, source: { kind: "user" } } } });
      value = { title: session.title, seq: session.events.at(-1).event.seq };
    } else if (method === "workspace/archiveSession") {
      if (!exactKeys(args, ["request"]) || !exactKeys(args.request, ["sessionId"]) || !sessions.has(args.request.sessionId)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(fail(rpcId, "INVALID_ARGS", "workspace/archiveSession requires an existing sessionId")));
        return;
      }
      if (process.env.FAKE_DSH_ARCHIVE_ERROR) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(fail(rpcId, "ARCHIVE_UNAVAILABLE", "archive unavailable")));
        return;
      }
      archivedSessionIds.add(args.request.sessionId);
      value = { archivedSessionIds: [...archivedSessionIds] };
    } else {
      value = fail(rpcId, "METHOD_UNKNOWN", "unknown method");
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value?.type === "server-response" ? value : ok(rpcId, value)));
  });
});

const mux = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/api/remote.mux" || (process.env.FAKE_DSH_AUTH_TOKEN && !request.headers.cookie?.includes("fake_dsh=authenticated"))) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  mux.handleUpgrade(request, socket, head, (connection) => {
    const streams = new Set();
    connection.on("message", (data, binary) => {
      const frame = JSON.parse(data.toString());
      if (!binary && frame.type === "cancel" && exactKeys(frame, ["type", "streamId"])) {
        if (streams.delete(frame.streamId)) {
          activeFollows.delete(frame.streamId);
          cancelledFollows++;
        }
        return;
      }
      if (binary || !exactKeys(frame, ["type", "streamId", "endpoint", "payload"]) || frame.type !== "open" || typeof frame.streamId !== "string" || frame.endpoint !== "workspace/follow" || !exactKeys(frame.payload, ["args"]) || !exactKeys(frame.payload.args, [])) {
        connection.close(1008, "invalid Remote stream request");
        return;
      }
      followRequests++;
      if (process.env.FAKE_DSH_FOLLOW_ERROR) {
        connection.send(JSON.stringify({ type: "error", streamId: frame.streamId, error: { code: "FOLLOW_UNAVAILABLE", message: "workspace snapshot unavailable" } }));
        return;
      }
      streams.add(frame.streamId);
      activeFollows.add(frame.streamId);
      const item = JSON.stringify({ type: "item", streamId: frame.streamId, value: { type: "baseline", value: { items: [...workspaces.values()], archivedSessionIds: [...archivedSessionIds] } } });
      if (process.env.FAKE_DSH_FRAGMENT_FOLLOW) {
        const split = Math.floor(item.length / 2);
        connection.send(item.slice(0, split), { fin: false });
        setTimeout(() => {
          if (connection.readyState === 1) connection.send(item.slice(split), { fin: true });
        }, 15);
      } else {
        connection.send(item);
      }
      // 模拟持续的 follow 流，不发送 end；消费者取得 baseline 后必须取消。
    });
    connection.on("close", () => {
      for (const streamId of streams) activeFollows.delete(streamId);
    });
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const token = process.env.FAKE_DSH_AUTH_TOKEN;
  process.stdout.write(`dsh web: http://127.0.0.1:${address.port}${token ? `/?token=${token}` : ""}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
