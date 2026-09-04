import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseCheck } from "../scripts/release-check.js";
import { npmDistTag, versionFromTag } from "../scripts/release-shared.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kepos-speech-release-check-"));
  temporaryDirectories.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@lamplitisles/kepos-speech",
    version,
    private: false,
    repository: { type: "git", url: "https://github.com/LamplitIsles/kepos-speech.git" },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
    scripts: {}
  }));
  return root;
}

describe("release tag preflight", () => {
  it("maps stable and prerelease semantic tags to npm channels", () => {
    expect(versionFromTag("v1.2.3")).toBe("1.2.3");
    expect(versionFromTag("v1.2.3-beta.4")).toBe("1.2.3-beta.4");
    expect(npmDistTag("v1.2.3")).toBe("latest");
    expect(npmDistTag("v1.2.3-beta.4")).toBe("beta");
    expect(() => versionFromTag("1.2.3")).toThrow();
    expect(() => versionFromTag("v1.2")).toThrow();
  });

  it("rejects a tag whose version differs from package metadata", async () => {
    const root = await fixture("1.2.3");
    expect(releaseCheck(root, "v1.2.4", false)).toContain(
      "@lamplitisles/kepos-speech version does not match v1.2.4."
    );
    expect(releaseCheck(root, "v1.2.3", false)).toEqual([]);
  });
});
