import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let rootEnvLoaded = false;

export function loadRootEnv(): void {
  if (rootEnvLoaded) {
    return;
  }

  rootEnvLoaded = true;

  const envPaths = [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")];

  for (const envPath of envPaths) {
    try {
      applyEnvFile(readFileSync(envPath, "utf8"));
      return;
    } catch {
    }
  }
}

function applyEnvFile(raw: string): void {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [name, ...valueParts] = trimmed.split("=");
    const key = name.trim();

    if (!key || process.env[key]) {
      continue;
    }

    process.env[key] = stripEnvQuotes(valueParts.join("=").trim());
  }
}

function stripEnvQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}
