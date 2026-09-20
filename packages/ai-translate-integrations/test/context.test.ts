import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDetectionContext, dependencyNames, findProjectFiles } from "../src/context";

const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function seed(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai-translate-context-boundaries-"));
  workspaces.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, "utf8");
  }
  return root;
}

describe("detection filesystem boundaries", () => {
  it("confines direct reads and listings to the project root", async () => {
    const workspace = await seed({ "project/messages/en.json": "{}", "outside.json": "private" });
    const root = path.join(workspace, "project");
    const context = createDetectionContext(root);
    expect(await context.readFile("messages/en.json")).toBe("{}");
    expect(await context.readFile("messages/../messages/en.json")).toBe("{}");
    expect(await context.readFile("../outside.json")).toBeNull();
    expect(await context.readFile(path.join(workspace, "outside.json"))).toBeNull();
    expect(await context.listFiles("..")).toEqual([]);
    expect(await context.listDirectories("../project/../")).toEqual([]);
    expect(await context.listFiles(path.join(workspace, "project"))).toEqual([]);
    expect(await context.listDirectories(".")).toEqual(["messages"]);
  });

  it("rejects file links and directory links even when they alias another file inside the project", async () => {
    const root = await seed({ "authored/en.json": "{}" });
    await fs.symlink(path.join(root, "authored/en.json"), path.join(root, "linked.json"));
    await fs.symlink(path.join(root, "authored"), path.join(root, "alias"));
    await fs.symlink(path.join(root, "missing.json"), path.join(root, "dangling.json"));
    const context = createDetectionContext(root);
    expect(await context.readFile("linked.json")).toBeNull();
    expect(await context.readFile("alias/en.json")).toBeNull();
    expect(await context.readFile("dangling.json")).toBeNull();
    expect(await context.listFiles("alias")).toEqual([]);
    expect(await context.listDirectories("alias")).toEqual([]);
    expect(await context.listFiles(".")).toEqual([]);
    expect(await context.listDirectories(".")).toEqual(["authored"]);
  });

  it("rejects linked ancestors into another project and linked manifests", async () => {
    const workspace = await seed({
      "project/authored/en.json": "{}",
      "other/messages/de.json": "{}",
      "other/package.json": '{"dependencies":{"expo":"57"}}',
    });
    const root = path.join(workspace, "project");
    await fs.symlink(path.join(workspace, "other"), path.join(root, "other"));
    await fs.symlink(path.join(workspace, "other/package.json"), path.join(root, "package.json"));
    const context = createDetectionContext(root);
    expect(await context.readFile("other/messages/de.json")).toBeNull();
    expect(await context.listDirectories("other/messages")).toEqual([]);
    expect(await context.packageJson()).toBeNull();
    expect(await findProjectFiles(context, () => true)).toEqual(["authored/en.json"]);
  });

  it("supports an explicitly selected project root that is itself a symlink", async () => {
    const workspace = await seed({ "project/messages/en.json": "{}", "project/package.json": '{"name":"app"}' });
    const linkedRoot = path.join(workspace, "selected-project");
    await fs.symlink(path.join(workspace, "project"), linkedRoot);
    const context = createDetectionContext(linkedRoot);
    expect(context.root).toBe(linkedRoot);
    expect(await context.readFile("messages/en.json")).toBe("{}");
    expect(await context.packageJson()).toEqual({ name: "app" });
    expect(await findProjectFiles(context, (file) => file.endsWith(".json"))).toEqual(["messages/en.json", "package.json"]);
  });

  it("returns absent results for missing paths and paths of the wrong kind", async () => {
    const root = await seed({ "messages/en.json": "{}" });
    const context = createDetectionContext(root);
    expect(await context.readFile("missing")).toBeNull();
    expect(await context.readFile("messages")).toBeNull();
    expect(await context.listFiles("messages/en.json")).toEqual([]);
    expect(await context.listDirectories("missing")).toEqual([]);
    const missingRoot = createDetectionContext(path.join(root, "missing-project"));
    expect(await missingRoot.readFile("package.json")).toBeNull();
    expect(await findProjectFiles(missingRoot, () => true)).toEqual([]);
  });

  it("treats filesystem read errors as absent data without exposing partial results", async () => {
    const root = await seed({ "messages/en.json": "{}" });
    const context = createDetectionContext(root);
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(Object.assign(new Error("unreadable"), { code: "EACCES" }));
    expect(await context.readFile("messages/en.json")).toBeNull();
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(Object.assign(new Error("unreadable"), { code: "EACCES" }));
    expect(await context.listFiles("messages")).toEqual([]);
  });

  it("accepts a BOM manifest and ignores malformed dependency sections", async () => {
    const root = await seed({
      "package.json": `\uFEFF${JSON.stringify({
        dependencies: ["expo"], devDependencies: "react", peerDependencies: null,
        optionalDependencies: { i18next: "25" },
      })}`,
    });
    expect(await dependencyNames(createDetectionContext(root))).toEqual(new Set(["i18next"]));
  });
});

describe("project traversal boundaries", () => {
  it("excludes compiled Apple bundles while preserving authored resource bundles", async () => {
    const root = await seed({
      "App/Localizable.xcstrings": "{}",
      "Resources/Feature.bundle/en.lproj/Localizable.strings": "text",
      "Exports/App.xcarchive/Products/Applications/App.app/en.lproj/Localizable.strings": "text",
      "Downloads/Helper.app/en.lproj/Localizable.strings": "text",
      "Frameworks/Feature.framework/en.lproj/Localizable.strings": "text",
      "Frameworks/Feature.xcframework/ios-arm64/Resources/en.lproj/Localizable.strings": "text",
      ".cache/Localizable.xcstrings": "{}",
      "node_modules/dependency/Localizable.xcstrings": "{}",
      "src-tauri/gen/apple/en.lproj/Localizable.strings": "text",
    });
    expect(await findProjectFiles(createDetectionContext(root), () => true)).toEqual([
      "App/Localizable.xcstrings", "Resources/Feature.bundle/en.lproj/Localizable.strings",
    ]);
  });

  it.each([false, true])("prunes entire trees with a %s asynchronous predicate", async (asynchronous) => {
    const root = await seed({
      "native/App/Localizable.xcstrings": "{}",
      "apps/mobile/ios/App/Localizable.xcstrings": "{}",
      "apps/mobile/locales/en.json": "{}",
      "node_modules/excluded/en.json": "{}",
    });
    const context = createDetectionContext(root);
    const readFiles = vi.spyOn(context, "listFiles");
    const visited: string[] = [];
    const shouldVisit = (directory: string) => {
      visited.push(directory);
      const permitted = directory !== "apps/mobile/ios";
      return asynchronous ? Promise.resolve(permitted) : permitted;
    };
    expect(await findProjectFiles(context, (file) => file.endsWith(".xcstrings"), shouldVisit)).toEqual(["native/App/Localizable.xcstrings"]);
    expect(visited).toContain("apps/mobile/ios");
    expect(visited.some((directory) => directory.startsWith("apps/mobile/ios/"))).toBe(false);
    expect(visited.some((directory) => directory.startsWith("node_modules"))).toBe(false);
    expect(readFiles.mock.calls.some(([directory]) => directory.startsWith("apps/mobile/ios"))).toBe(false);
  });

  it("returns deterministic sorted paths independent of directory enumeration order", async () => {
    const root = await seed({ "z/Z.json": "{}", "a/B.json": "{}", "a/A.json": "{}" });
    const context = createDetectionContext(root);
    const listDirectories = context.listDirectories;
    const listFiles = context.listFiles;
    context.listDirectories = async (directory) => (await listDirectories(directory)).toReversed();
    context.listFiles = async (directory) => (await listFiles(directory)).toReversed();
    expect(await findProjectFiles(context, (file) => file.endsWith(".json"))).toEqual(["a/A.json", "a/B.json", "z/Z.json"]);
  });
});
