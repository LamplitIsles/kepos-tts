import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseCheck } from "../scripts/release-check.js";
import { npmDistTag, versionFromTag } from "../scripts/release-shared.js";
import { synchronizeReleaseVersion } from "../scripts/sync-release-version.js";

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
  it("maps stable and strict prerelease tags to npm channels", () => {
    expect(versionFromTag("v1.2.3")).toBe("1.2.3");
    expect(versionFromTag("v1.2.3-beta.4")).toBe("1.2.3-beta.4");
    expect(versionFromTag("v1.2.3-0")).toBe("1.2.3-0");
    expect(versionFromTag("v1.2.3-alpha01")).toBe("1.2.3-alpha01");
    expect(versionFromTag("v1.2.3+build.1")).toBe("1.2.3+build.1");
    expect(versionFromTag("v1.2.3-alpha01+build.1")).toBe("1.2.3-alpha01+build.1");
    expect(npmDistTag("v1.2.3")).toBe("latest");
    expect(npmDistTag("v1.2.3-beta.4")).toBe("beta");
    expect(npmDistTag("v1.2.3+build.1")).toBe("latest");
    expect(() => versionFromTag("1.2.3")).toThrow();
    expect(() => versionFromTag("v1.2")).toThrow();
    expect(() => versionFromTag("v1.2.3-01")).toThrow();
    expect(() => versionFromTag("v1.2.3-alpha.01")).toThrow();
    expect(() => versionFromTag("v1.2.3-0.01")).toThrow();
  });

  it("rejects a tag whose version differs from package metadata", async () => {
    const root = await fixture("1.2.3");
    expect(releaseCheck(root, "v1.2.4", false)).toContain(
      "@lamplitisles/kepos-speech version does not match v1.2.4."
    );
    expect(releaseCheck(root, "v1.2.3", false)).toEqual([]);
  });

  it("synchronizes the manifest from a release tag before preflight", async () => {
    const root = await fixture("0.1.0-beta.0");

    await synchronizeReleaseVersion(root, "v0.2.0");

    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("0.2.0");
    expect(releaseCheck(root, "v0.2.0", false)).toEqual([]);
  });
});
