import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { PaycheckAgentService } from "../src/agent/service.js";

const port = Number(process.env.AGENT_PORT ?? 8787);
const service = new PaycheckAgentService();

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "http://127.0.0.1:5173",
    "access-control-allow-headers": "content-type"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 256_000) throw new Error("Request body exceeds 256 KB.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "http://127.0.0.1:5173",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS"
    });
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/api/health") {
    sendJson(response, 200, {
      status: "ok",
      framework: "Strands Agents SDK",
      provider: "Amazon Bedrock",
      model: process.env.STRANDS_MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
      modelAccess: "unchecked"
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/agent") {
    try {
      const payload = await readJson(request);
      const result = await service.advise(payload);
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof ZodError) {
        sendJson(response, 400, { code: "INVALID_REQUEST", message: "The request did not match the expected financial-plan schema.", issues: error.issues });
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown agent error";
      console.error("Agent request failed:", message);
      sendJson(response, 503, {
        code: "AGENT_UNAVAILABLE",
        message: "The Strands agent could not complete this request. Check AWS credentials, region, and Bedrock model access."
      });
    }
    return;
  }

  sendJson(response, 404, { code: "NOT_FOUND", message: "Route not found." });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Paycheck Two Strands agent listening at http://127.0.0.1:${port}`);
});
