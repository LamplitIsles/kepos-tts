import { defineConfig } from "tsup";

const dshExternals = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-connection/client",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-runtime/client",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-settings-plugins/client",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-host-apiproxy",
  "@deepseek-ai/dsh-host-apiproxy/api",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/schemastery",
  "react",
  "react/jsx-runtime"
];

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      core: "src/core.ts"
    },
    format: ["esm"],
    platform: "node",
    target: "node20",
    dts: true,
    clean: true,
    external: dshExternals
  },
  {
    entry: { client: "src/client.ts" },
    format: ["cjs"],
    platform: "browser",
    target: "es2022",
    dts: true,
    clean: false,
    loader: { ".css": "text" },
    external: dshExternals,
    outExtension: () => ({ js: ".js" }),
    banner: {
      js: 'window.__ModuleLoader__.load({ id: "@lamplitisles/kepos-tts", factory: (require) => { var module = { exports: {} }; var exports = module.exports;'
    },
    footer: { js: "return module.exports; } });" }
  }
]);
