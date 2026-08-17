import test from "node:test";
import assert from "node:assert/strict";
import { setSingleBearerAuthorization } from "../src/agent/bedrock-auth.js";

test("normalizes mixed-case authorization headers to one bearer value", () => {
  const headers = {
    Authorization: "AWS4-HMAC-SHA256 old-signature",
    authorization: "another-value",
    "content-type": "application/json"
  };

  setSingleBearerAuthorization(headers, "test-key");

  const authorizationHeaders = Object.entries(headers).filter(([name]) => name.toLowerCase() === "authorization");
  assert.deepEqual(authorizationHeaders, [["authorization", "Bearer test-key"]]);
  assert.equal(headers["content-type"], "application/json");
});
