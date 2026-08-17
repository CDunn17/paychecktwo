import type { BedrockModel } from "@strands-agents/sdk";

type HeaderBag = Record<string, string>;

export function setSingleBearerAuthorization(headers: HeaderBag, apiKey: string): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "authorization") delete headers[name];
  }
  headers.authorization = `Bearer ${apiKey}`;
}

/**
 * Strands 1.13 adds its bearer middleware after SigV4 signing. With some
 * AWS SDK/Node combinations, differently-cased Authorization keys survive
 * and Node rejects the request as a multi-value authorization header.
 * Normalize immediately after the named Strands middleware until the SDK
 * handles authorization casing internally.
 */
export function normalizeBedrockApiKeyHeader(model: BedrockModel, apiKey: string): void {
  type MiddlewareArgs = { request: { headers: HeaderBag } };
  type MiddlewareNext = (args: MiddlewareArgs) => Promise<unknown>;
  type InternalBedrockModel = {
    _client: {
      middlewareStack: {
        addRelativeTo: (
          middleware: (next: MiddlewareNext) => (args: MiddlewareArgs) => Promise<unknown>,
          options: { relation: "after"; toMiddleware: string; name: string }
        ) => void;
      };
    };
  };

  const internal = model as unknown as InternalBedrockModel;
  internal._client.middlewareStack.addRelativeTo(
    (next) => async (args) => {
      setSingleBearerAuthorization(args.request.headers, apiKey);
      return next(args);
    },
    {
      relation: "after",
      toMiddleware: "bedrockApiKeyMiddleware",
      name: "paycheckTwoSingleAuthorizationHeader"
    }
  );
}
