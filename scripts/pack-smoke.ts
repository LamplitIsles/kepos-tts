import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";

const root = resolve(new URL("..", import.meta.url).pathname);
if (!existsSync(join(root, "dist", "index.js")) || !existsSync(join(root, "dist", "client.js"))) {
  throw new Error("pack-smoke requires a fresh `bun run build`");
}

function dshEntry(): string {
  const configured = process.env.DSH_CLI;
  let cli = configured;
  if (!cli) {
    try {
      cli = execFileSync("which", ["dsh"], { encoding: "utf8" }).trim();
    } catch {
      cli = undefined;
    }
  }
  if (!cli || !existsSync(cli)) {
    throw new Error("pack-smoke requires the installed `dsh` CLI (set DSH_CLI to its path)");
  }
  const entry = realpathSync(cli);
  if (!existsSync(entry)) throw new Error(`DSH CLI target does not exist: ${entry}`);
  return entry;
}

function startRuntime(entry: string, env: NodeJS.ProcessEnv, cwd: string): Promise<{ child: ChildProcess; baseUrl: string }> {
  const child = spawn(process.execPath, ["--expose-internals", entry, "--profile", "web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolveRuntime, rejectRuntime) => {
    const finish = (error: Error | undefined, baseUrl?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectRuntime(error);
      else if (baseUrl) resolveRuntime({ child, baseUrl });
      else rejectRuntime(new Error("DSH Web runtime exited without a URL"));
    };
    const readOutput = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) finish(undefined, match[1]);
    };
    child.stdout?.on("data", readOutput);
    child.stderr?.on("data", readOutput);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`DSH Web runtime exited before ready (${code ?? "?"}/${signal ?? "?"}): ${output}`));
    });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`timed out waiting for DSH Web runtime: ${output}`));
    }, 30_000);
  });
}

function isolatedEnvironment(temp: string, dshHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const testHome = join(temp, "home");
  return {
    ...env,
    HOME: testHome,
    USERPROFILE: testHome,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: "1",
    npm_config_store_dir: join(temp, "pnpm-store"),
    npm_config_cache: join(temp, "npm-cache"),
    XDG_CACHE_HOME: join(temp, "cache"),
    XDG_CONFIG_HOME: join(temp, "config"),
    XDG_DATA_HOME: join(temp, "data"),
    XDG_STATE_HOME: join(temp, "state")
  };
}

async function stopRuntime(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    let finished = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, 5_000);
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolveStop();
    };
    child.once("exit", finish);
    if (!child.kill("SIGTERM")) finish();
  });
}

async function jsonRequest(baseUrl: string, path: string, body: unknown): Promise<{ response: Response; value: unknown }> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`DSH returned non-JSON from ${path}: ${text.slice(0, 200)}`);
  }
  return { response, value };
}

const temp = mkdtempSync(join(tmpdir(), "kepos-tts-pack-"));
let runtime: { child: ChildProcess; baseUrl: string } | undefined;
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" })) as Array<{ filename: string }>;
  const tarball = join(temp, packed[0]!.filename);
  const home = join(temp, "dsh-home");
  const runtimeCwd = join(temp, "runtime-cwd");
  mkdirSync(runtimeCwd, { recursive: true });
  const env = isolatedEnvironment(temp, home);
  const entry = dshEntry();
  try {
    execFileSync(process.execPath, ["--expose-internals", entry, "plugin", "--profile", "web", "add", tarball, "--ignore-scripts"], {
      cwd: runtimeCwd,
      stdio: "pipe",
      env
    });
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
    throw new Error(`failed to install packed plugin into disposable DSH_HOME: ${detail}`);
  }

  const install = join(home, "profiles", "web");
  const packageDir = join(install, "node_modules", "@lamplitisles", "kepos-tts");
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name: string;
    dsh?: { client?: { platform?: string } };
  };
  if (manifest.name !== "@lamplitisles/kepos-tts" || manifest.dsh?.client?.platform !== "web") {
    throw new Error("installed manifest does not describe the DSH Web bundle");
  }

  const patch = readFileSync(join(packageDir, "cordis.patch.yml"), "utf8");
  for (const required of ["kepos-tts", "@lamplitisles/kepos-tts", "connection", "credentials", "settings", "systemPrompt", "sessions", "webServer"]) {
    if (!patch.includes(required)) throw new Error(`Cordis patch is missing ${required}`);
  }

  runtime = await startRuntime(entry, env, runtimeCwd);
  const homePage = await fetch(runtime.baseUrl);
  if (!homePage.ok) throw new Error(`installed DSH Web runtime returned ${homePage.status} for /`);
  const html = await homePage.text();
  const bootStart = html.indexOf('globalThis["__DSH_BOOT__"]');
  const bootEnd = bootStart < 0 ? -1 : html.indexOf("</script>", bootStart);
  const bootSource = bootStart < 0 || bootEnd < 0 ? "" : html.slice(bootStart, bootEnd);
  const jsonStart = bootSource.indexOf("{");
  const jsonEnd = bootSource.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error("DSH Web bootstrap did not expose __DSH_BOOT__");
  const boot = JSON.parse(bootSource.slice(jsonStart, jsonEnd + 1)) as { entries?: Array<{ id?: string; url?: string }> };
  const pluginEntry = boot.entries?.find((candidate) => candidate.id === manifest.name);
  if (!pluginEntry?.url) throw new Error("installed plugin is absent from the DSH Web bootstrap entries");

  const clientResponse = await fetch(new URL(pluginEntry.url, runtime.baseUrl));
  if (!clientResponse.ok) throw new Error(`installed DSH client bundle returned ${clientResponse.status}`);
  const clientCode = await clientResponse.text();
  let loaded: { id?: string; factory?: unknown } | undefined;
  vm.runInNewContext(clientCode, {
    window: { __ModuleLoader__: { load(spec: { id?: string; factory?: unknown }) { loaded = spec; } } }
  });
  if (
    loaded?.id !== manifest.name ||
    typeof loaded.factory !== "function" ||
    !clientCode.includes('data-plugin-css') ||
    !/\.[A-Za-z0-9]+_player audio\{width:100%;height:32px\}/.test(clientCode) ||
    !clientCode.includes('"player":') ||
    clientCode.includes("createObjectURL") ||
    clientCode.includes("revokeObjectURL") ||
    clientCode.includes("data:audio/") ||
    clientCode.includes('require("@deepseek-ai/dsh-credentials")') ||
    clientCode.includes('require("@deepseek-ai/schemastery")')
  ) {
    throw new Error("served client loader or inlined stylesheet is missing");
  }

  const rpc = await jsonRequest(runtime.baseUrl, "/kepos-tts/synthesize", {
    type: "client-request",
    rpcId: "pack-smoke-rpc",
    method: "synthesize",
    payload: { text: "", sessionId: "session-smoke" }
  });
  const rpcEnvelope = rpc.value as { type?: string; rpcId?: string; result?: { ok?: boolean; error?: { message?: string } } };
  if (!rpc.response.ok || rpcEnvelope.type !== "server-response" || rpcEnvelope.rpcId !== "pack-smoke-rpc" || rpcEnvelope.result?.error?.message !== "invalid-input") {
    throw new Error(`installed host RPC did not activate: ${JSON.stringify(rpc.value)}`);
  }

  const settings = await jsonRequest(runtime.baseUrl, "/api/settings.describe", {
    type: "client-request",
    rpcId: "pack-smoke-settings",
    method: "settings.describe",
    payload: { redactSecrets: true }
  });
  const settingsEnvelope = settings.value as {
    type?: string;
    rpcId?: string;
    result?: { ok?: boolean; value?: { namespaces?: Array<{ ns?: string; value?: { provider?: string; alibabaVoice?: string; bytedanceVoice?: string } }> } };
  };
  const namespace = settingsEnvelope.result?.value?.namespaces?.find((candidate) => candidate.ns === "kepos-tts");
  if (
    !settings.response.ok ||
    settingsEnvelope.type !== "server-response" ||
    settingsEnvelope.rpcId !== "pack-smoke-settings" ||
    settingsEnvelope.result?.ok !== true ||
    namespace?.value?.provider !== "alibaba" ||
    namespace?.value?.alibabaVoice !== "Maia" ||
    namespace?.value?.bytedanceVoice !== "zh_female_sajiaoxuemei_uranus_bigtts"
  ) {
    throw new Error(`installed Settings registration did not activate: ${JSON.stringify(settings.value)}`);
  }

  writeFileSync(join(home, "smoke-result.json"), JSON.stringify({ package: manifest.name, baseUrl: runtime.baseUrl, client: loaded.id, rpc: rpcEnvelope.result?.error?.message, settings: namespace.ns }));
  console.log(`pack-smoke: installed ${manifest.name}; DSH Web runtime, host RPC, Settings, and client loader verified on ${runtime.baseUrl}`);
} finally {
  if (runtime) await stopRuntime(runtime.child);
  rmSync(temp, { recursive: true, force: true });
}
