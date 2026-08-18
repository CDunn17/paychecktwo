import { BedrockModel } from "@strands-agents/sdk";
import { normalizeBedrockApiKeyHeader } from "./bedrock-auth.js";

export interface BedrockModelOptions {
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
}

export function createBedrockModel(options: BedrockModelOptions = {}): BedrockModel {
  const bedrockApiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const model = new BedrockModel({
    region: process.env.AWS_REGION ?? "us-east-1",
    modelId: options.modelId ?? process.env.STRANDS_MODEL_ID ?? "global.anthropic.claude-sonnet-4-6",
    maxTokens: options.maxTokens ?? Number(process.env.STRANDS_MODEL_MAX_TOKENS ?? 2500),
    temperature: options.temperature ?? 0.1,
    ...(bedrockApiKey ? { apiKey: bedrockApiKey } : {})
  });
  if (bedrockApiKey) normalizeBedrockApiKeyHeader(model, bedrockApiKey);
  return model;
}
