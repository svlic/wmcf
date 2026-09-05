import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

const maxAttempts = 3;
const retryableFailure = /\b5\d\d\b|malformed response|upstream connect error|connection (?:termination|reset)|ECONNRESET|ETIMEDOUT/i;
const extraArgs = process.argv.slice(2);

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = spawnSync(process.execPath, [wranglerBin, "deploy", ...extraArgs], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  if (result.status === 0) {
    process.exit(0);
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const canRetry = attempt < maxAttempts && retryableFailure.test(output);
  if (!canRetry) {
    process.exit(result.status ?? 1);
  }

  const delaySeconds = 5 * 2 ** (attempt - 1);
  console.error(
    `Wrangler deploy hit a transient Cloudflare API error; retrying in ${delaySeconds}s (${attempt}/${maxAttempts}).`,
  );
  await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000));
}
