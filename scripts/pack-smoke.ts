import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const root = resolve(new URL("..", import.meta.url).pathname);
if (!existsSync(join(root, "dist", "index.js")) || !existsSync(join(root, "dist", "client.js"))) {
  throw new Error("pack-smoke requires a fresh `bun run build`");
}

const temp = mkdtempSync(join(tmpdir(), "kepos-tts-pack-"));
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" })) as Array<{ filename: string }>;
  const tarball = join(temp, packed[0]!.filename);
  const home = join(temp, "dsh-home");
  const install = join(home, "web-profile");
  const smokeEnv = { ...process.env, DSH_HOME: home };
  execFileSync("npm", ["install", "--prefix", install, "--ignore-scripts", "--no-save", "--legacy-peer-deps", tarball], { cwd: root, stdio: "pipe", env: smokeEnv });

  const manifest = JSON.parse(readFileSync(join(install, "node_modules", "@lamplitisles", "kepos-tts", "package.json"), "utf8")) as {
    name: string;
    dsh?: { client?: { platform?: string } };
  };
  if (manifest.name !== "@lamplitisles/kepos-tts" || manifest.dsh?.client?.platform !== "web") throw new Error("installed manifest does not describe the DSH Web bundle");

  const patch = readFileSync(join(install, "node_modules", "@lamplitisles", "kepos-tts", "cordis.patch.yml"), "utf8");
  for (const required of ["kepos-tts", "@lamplitisles/kepos-tts", "connection", "credentials", "settings", "systemPrompt"]) {
    if (!patch.includes(required)) throw new Error(`Cordis patch is missing ${required}`);
  }

  // The installed host entry is loaded against the repository's pinned DSH
  // contracts, while all profile files and the runtime marker remain under
  // this disposable DSH_HOME.
  const peerRoot = join(install, "node_modules", "@deepseek-ai");
  mkdirSync(peerRoot, { recursive: true });
  for (const dependency of ["cordis", "dsh-client-connection", "dsh-credentials", "dsh-host-apiproxy", "dsh-settings", "dsh-system-prompt", "schemastery"]) {
    const target = join(peerRoot, dependency);
    if (!existsSync(target)) symlinkSync(resolve(root, "node_modules", "@deepseek-ai", dependency), target, "dir");
  }
  const registered: { channel?: string; authority?: string; handler?: Function } = {};
  const host = await import(pathToFileURL(join(install, "node_modules", "@lamplitisles", "kepos-tts", "dist", "index.js")).href);
  host.apply({
    settings: { register: () => ({ get: () => ({ voice: "onoAnna" }) }) },
    credentials: { resolve: async () => undefined },
    connection: { rpc: { handle(channel: string, handler: Function, options: { authority: string }) { registered.channel = channel; registered.handler = handler; registered.authority = options.authority; return async () => undefined; } } },
    systemPrompt: { section: () => () => undefined }
  });
  if (registered.channel !== "/kepos-tts" || registered.authority !== "trusted-host" || typeof registered.handler !== "function") throw new Error("installed host entry did not activate the trusted RPC");

  let loaded: { id?: string; factory?: unknown } | undefined;
  const clientCode = readFileSync(join(install, "node_modules", "@lamplitisles", "kepos-tts", "dist", "client.js"), "utf8");
  vm.runInNewContext(clientCode, { window: { __ModuleLoader__: { load(spec: { id?: string; factory?: unknown }) { loaded = spec; } } } });
  if (loaded?.id !== "@lamplitisles/kepos-tts" || typeof loaded.factory !== "function" || !clientCode.includes("kepos-tts-settings-card") || clientCode.includes('require("@deepseek-ai/dsh-credentials")') || clientCode.includes('require("@deepseek-ai/schemastery")')) {
    throw new Error("client loader or inlined stylesheet is missing");
  }

  const server = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback runtime did not start");
  writeFileSync(join(home, "smoke-result.json"), JSON.stringify({ package: manifest.name, port: address.port, client: loaded.id }));
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  console.log(`pack-smoke: installed ${manifest.name}; host patch and client loader verified in ${home}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
