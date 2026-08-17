import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import dotenv from "dotenv";
import { ZodError } from "zod";
import { AgentIncompleteError, PaycheckAgentService } from "../src/agent/service.js";
import { AgentRequestSchema } from "../src/agent/schemas.js";

dotenv.config({ quiet: true });

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
      modelAccess: "unchecked",
      authentication: process.env.AWS_BEARER_TOKEN_BEDROCK ? "bedrock-api-key" : "aws-credential-chain",
      contractVersion: 5,
      executionBudget: {
        timeoutMs: Number(process.env.STRANDS_TIMEOUT_MS ?? 120_000),
        verifierTimeoutMs: Number(process.env.STRANDS_VERIFIER_TIMEOUT_MS ?? 30_000),
        turns: Number(process.env.STRANDS_TURN_LIMIT ?? 9),
        outputTokens: Number(process.env.STRANDS_OUTPUT_TOKEN_LIMIT ?? 12_000),
        totalTokens: Number(process.env.STRANDS_TOTAL_TOKEN_LIMIT ?? 100_000)
      }
    });
    return;
  }

  if (request.method === "POST" && request.url === "/api/agent") {
    let payload;
    try {
      payload = AgentRequestSchema.parse(await readJson(request));
    } catch (error) {
      if (error instanceof ZodError) {
        sendJson(response, 400, { code: "INVALID_REQUEST", message: "The request did not match the expected financial-plan schema.", issues: error.issues });
        return;
      }
      sendJson(response, 400, { code: "INVALID_JSON", message: "The request body must be valid JSON." });
      return;
    }

    try {
      const result = await service.advise(payload);
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof AgentIncompleteError) {
        console.error("Agent request incomplete:", error.message);
        sendJson(response, 503, {
          code: "AGENT_INCOMPLETE",
          message: "The Strands agent reached an execution budget before it produced a validated answer.",
          stopReason: error.stopReason,
          durationMs: error.wallClockMs,
          diagnostics: error.diagnostics
        });
        return;
      }
      if (error instanceof ZodError) {
        console.error("Agent output validation failed:", error.issues.map((issue) => issue.path.join(".")).join(", "));
        sendJson(response, 502, {
          code: "INVALID_AGENT_OUTPUT",
          message: "The Strands agent returned output that failed the application safety contract.",
          issuePaths: error.issues.map((issue) => issue.path.join("."))
        });
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
