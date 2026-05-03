import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createComputeClientFromEnv } from "./compute-client.js";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, "..");
const repoRoot = resolve(packageDir, "../..");

dotenv.config({ path: resolve(repoRoot, ".env") });
dotenv.config();

async function main(): Promise<void> {
  assertRequiredEnv(["ZEROG_COMPUTE_PROVIDER_ADDRESS"]);

  const compute = createComputeClientFromEnv({ provider: "0g" });
  const response = await compute.complete({
    messages: [
      {
        role: "system",
        content: "You are a concise test responder for a dark-pool trading agent integration smoke test."
      },
      {
        role: "user",
        content: "Reply with one short sentence confirming 0G Compute is reachable."
      }
    ],
    temperature: 0,
    maxTokens: 64
  });

  assert.equal(response.provider, "0g");
  assert.ok(response.content.length > 0);

  console.log("✓ 0G Compute completion", {
    provider: response.provider,
    model: response.model,
    requestId: response.requestId,
    contentPreview: response.content.slice(0, 160)
  });
  process.exit(0);
}

function assertRequiredEnv(names: string[]): void {
  const missing = names.filter((name) => !process.env[name]);

  if (!process.env.ZEROG_COMPUTE_RPC_URL && !process.env.ZEROG_RPC_URL) {
    missing.push("ZEROG_COMPUTE_RPC_URL or ZEROG_RPC_URL");
  }

  if (!process.env.ZEROG_COMPUTE_PRIVATE_KEY && !process.env.ZEROG_PRIVATE_KEY) {
    missing.push("ZEROG_COMPUTE_PRIVATE_KEY or ZEROG_PRIVATE_KEY");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required 0G Compute env vars: ${missing.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
