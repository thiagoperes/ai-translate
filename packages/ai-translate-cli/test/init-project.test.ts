import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { applyProjectSetup, packageManagerProcess, planProjectSetup } from "../src/init-project";

const workspaces: string[] = [];
const required = ["@ai-translate/cli", "@ai-translate/apple", "@ai-translate/provider-openai"];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ai translate setup "));
  workspaces.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(root, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
  }
  return root;
}

async function managerShim(bin: string, name: string, source: string): Promise<void> {
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, name), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, `${name}.cjs`), source);
  await fs.writeFile(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`);
}

describe("project setup planning", () => {
  it("plans a private native manifest without touching the project", async () => {
    const root = await project();
    const plan = await planProjectSetup(root, required);
    expect(plan.packageManager).toBe("npm");
    expect(JSON.parse(plan.manifestContents ?? "{}")).toEqual({
      private: true,
      scripts: {
        translate: "ai-translate sync",
        "translate:check": "ai-translate check",
        "translate:validate": "ai-translate validate",
      },
    });
    expect(plan.installCommand.args).toEqual(["install", "--save-dev", "--ignore-scripts", ...required]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("preserves manifest fields, scripts, dependency versions, and indentation", async () => {
    const manifest = {
      name: "my-app",
      private: false,
      scripts: { translate: "custom translation", test: "test-runner" },
      dependencies: { "@ai-translate/cli": "^0.3.0" },
      devDependencies: { "@ai-translate/apple": "workspace:*" },
      optionalDependencies: { "@ai-translate/provider-openai": "file:../provider" },
      custom: { keep: true },
    };
    const root = await project({ "package.json": `${JSON.stringify(manifest, null, "\t")}\n` });
    const plan = await planProjectSetup(root, required);
    expect(JSON.parse(plan.manifestContents ?? "{}")).toMatchObject(manifest);
    expect(plan.manifestContents).toContain('\n\t"name"');
    expect(plan.packages).toEqual([]);
    expect(plan.installCommand.args).toEqual(["install", "--ignore-scripts"]);
  });

  it("keeps empty existing scripts instead of overwriting user choices", async () => {
    const root = await project({ "package.json": JSON.stringify({ scripts: { translate: "" } }) });
    const plan = await planProjectSetup(root, required);
    expect(JSON.parse(plan.manifestContents ?? "{}").scripts.translate).toBe("");
  });

  it("preserves CRLF and only adds missing direct declarations", async () => {
    const root = await project({ "package.json": '{\r\n    "peerDependencies": {"@ai-translate/cli":"*"}\r\n}\r\n' });
    const plan = await planProjectSetup(root, [required[0] ?? "", required[0] ?? ""]);
    expect(plan.manifestContents).toContain('\r\n    "scripts"');
    expect(plan.packages).toEqual(["@ai-translate/cli"]);
  });

  it.each([
    ["npm", "package-lock.json", ["install", "--save-dev", "--ignore-scripts"]],
    ["npm", "npm-shrinkwrap.json", ["install", "--save-dev", "--ignore-scripts"]],
    ["pnpm", "pnpm-lock.yaml", ["add", "--save-dev", "--ignore-scripts"]],
    ["yarn", "yarn.lock", ["add", "--dev"]],
    ["bun", "bun.lock", ["add", "--dev", "--ignore-scripts"]],
    ["bun", "bun.lockb", ["add", "--dev", "--ignore-scripts"]],
  ] as const)("detects %s from %s", async (manager, lockfile, args) => {
    const root = await project({ [lockfile]: "" });
    const plan = await planProjectSetup(root, required);
    expect(plan.packageManager).toBe(manager);
    expect(plan.installCommand.args).toEqual([...args, ...required]);
    expect(plan.installCommand.env).toEqual(manager === "yarn" ? { YARN_ENABLE_SCRIPTS: "false" } : undefined);
  });

  it("does not mistake multiple lockfiles for the same manager as ambiguity", async () => {
    const root = await project({ "bun.lock": "", "bun.lockb": "" });
    expect((await planProjectSetup(root, required)).packageManager).toBe("bun");
  });

  it("prefers an explicit manager, then packageManager, and rejects ambiguous locks", async () => {
    const root = await project({ "package-lock.json": "", "pnpm-lock.yaml": "" });
    await expect(planProjectSetup(root, required)).rejects.toThrow(/Ambiguous package managers/u);
    await fs.writeFile(path.join(root, "package.json"), '{"packageManager":"pnpm@10.0.0+sha512.test"}');
    expect((await planProjectSetup(root, required)).packageManager).toBe("pnpm");
    expect((await planProjectSetup(root, required, { packageManager: "bun" })).packageManager).toBe("bun");
  });

  it("uses the enclosing workspace manager without adding pnpm's root flag to members", async () => {
    const root = await project({
      "package.json": '{"packageManager":"pnpm@10.0.0"}',
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/app/package.json": '{"name":"app"}',
    });
    const member = await planProjectSetup(path.join(root, "packages/app"), required);
    expect(member.packageManager).toBe("pnpm");
    expect(member.installCommand.args).not.toContain("--workspace-root");
    expect(member.installCommand.cwd).toBe(await fs.realpath(path.join(root, "packages/app")));
    const workspace = await planProjectSetup(root, required);
    expect(workspace.installCommand.args).toContain("--workspace-root");
  });

  it("uses ancestor workspace lockfiles and detects conflicting member locks", async () => {
    const root = await project({
      "package.json": '{"workspaces":["apps/*"]}',
      "yarn.lock": "",
      "apps/app/package.json": "{}",
    });
    expect((await planProjectSetup(path.join(root, "apps/app"), required)).packageManager).toBe("yarn");
    await fs.writeFile(path.join(root, "apps/app/package-lock.json"), "");
    await expect(planProjectSetup(path.join(root, "apps/app"), required)).rejects.toThrow(/Ambiguous/u);
  });

  it("does not attach an unrelated native project to an ancestor workspace", async () => {
    const root = await project({
      "package.json": '{"workspaces":["apps/*"],"packageManager":"pnpm@10"}',
      "native/App/App.swift": "",
    });
    const plan = await planProjectSetup(path.join(root, "native/App"), required);
    expect(plan.packageManager).toBe("npm");
    expect(plan.installCommand.args).not.toContain("--workspace-root");
  });

  it.each([
    'packages:\n  - "apps/*"\n  - "!apps/excluded"\n',
    "packages:\n  - 'apps/*' # included\n  - '!apps/excluded'\ncatalog: {}\n",
    'packages: ["apps/*", "!apps/excluded"]\n',
    "packages:\n- apps/*\n- '!apps/excluded'\n",
  ])("requires positive pnpm membership and respects exclusions for %s", async (yaml) => {
    const root = await project({
      "package.json": '{"packageManager":"pnpm@10"}',
      "pnpm-workspace.yaml": yaml,
      "apps/included/package.json": "{}",
      "apps/excluded/package.json": "{}",
      "native/App.swift": "",
    });
    expect((await planProjectSetup(path.join(root, "apps/included"), required)).packageManager).toBe("pnpm");
    expect((await planProjectSetup(path.join(root, "apps/excluded"), required)).packageManager).toBe("npm");
    expect((await planProjectSetup(path.join(root, "native"), required)).packageManager).toBe("npm");
  });

  it("recognizes legacy Yarn workspace objects and brace patterns", async () => {
    const root = await project({
      "package.json": '{"packageManager":"yarn@1.22.22","workspaces":{"packages":["{apps,packages}/*"]}}',
      "packages/app/package.json": "{}",
    });
    expect((await planProjectSetup(path.join(root, "packages/app"), required)).packageManager).toBe("yarn");
  });

  it.each([
    "packages: *projectPackages\n",
    "catalog: {}\n",
    "packages:\n  - *projectAlias\n",
    "packages:\n  - {}\n",
  ])("does not guess membership from unsupported YAML %s", async (yaml) => {
    const root = await project({
      "package.json": '{"packageManager":"pnpm@10"}',
      "pnpm-workspace.yaml": yaml,
      "native/App.swift": "",
    });
    expect((await planProjectSetup(path.join(root, "native"), required)).packageManager).toBe("npm");
  });

  it("does not cross a nested Git repository boundary", async () => {
    const root = await project({
      "package.json": '{"workspaces":["apps/*"],"packageManager":"pnpm@10"}',
      "apps/app/package.json": "{}",
      "apps/app/.git": "gitdir: elsewhere",
    });
    expect((await planProjectSetup(path.join(root, "apps/app"), required)).packageManager).toBe("npm");
  });

  it.each([
    ["{", /Invalid JSON/u],
    ["[]", /JSON object/u],
    ['{"dependencies":[]}', /dependencies must be/u],
    ['{"devDependencies":{"foo":42}}', /devDependencies must be/u],
    ['{"dependencies":{"foo":" "}}', /dependencies must be/u],
    ['{"optionalDependencies":null}', /optionalDependencies must be/u],
    ['{"peerDependencies":{"foo":null}}', /peerDependencies must be/u],
    ['{"scripts":{"translate":false}}', /scripts must be/u],
    ['{"packageManager":null}', /packageManager must be/u],
    ['{"packageManager":"deno@2"}', /Unsupported package manager/u],
    ['{"workspaces":null}', /workspaces must contain/u],
    ['{"workspaces":{"packages":[42]}}', /workspaces must contain/u],
  ])("rejects malformed manifest %s before changing any files", async (contents, message) => {
    const root = await project({ "package.json": contents });
    await expect(planProjectSetup(root, required)).rejects.toThrow(message);
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(contents);
  });

  it.each(["--ignore-scripts=false", "pkg;touch bad", "./package", "https://example.org/pkg", "@scope", "foo/bar"])("rejects unsafe install argument %s", async (name) => {
    const root = await project();
    await expect(planProjectSetup(root, [name])).rejects.toThrow(/Invalid dependency package name/u);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("accepts a symlinked project path but refuses a symlinked manifest", async () => {
    const root = await project({ "real/package.json": "{}" });
    await fs.symlink(path.join(root, "real"), path.join(root, "alias"));
    expect((await planProjectSetup(path.join(root, "alias"), required)).manifestPath).toBe(path.join(await fs.realpath(root), "real/package.json"));
    await fs.symlink(path.join(root, "real/package.json"), path.join(root, "package.json"));
    await expect(planProjectSetup(root, required)).rejects.toThrow(/regular file/u);
  });
});

describe("applying project setup", () => {
  it("writes setup without invoking an installer when installation is disabled", async () => {
    const root = await project();
    const installer = vi.fn().mockResolvedValue(undefined);
    const lines = await applyProjectSetup(await planProjectSetup(root, required), { install: false, installer });
    expect(installer).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("npm install --save-dev --ignore-scripts @ai-translate/cli");
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).private).toBe(true);
  });

  it("passes packages as individual arguments and uses the project as cwd", async () => {
    const root = await project();
    const installer = vi.fn().mockResolvedValue(undefined);
    await applyProjectSetup(await planProjectSetup(root, required), { installer });
    expect(installer).toHaveBeenCalledWith("npm", ["install", "--save-dev", "--ignore-scripts", ...required], await fs.realpath(root), undefined);
  });

  it("shows safe manual installation commands for both Yarn generations", async () => {
    const root = await project({ "yarn.lock": "" });
    const lines = await applyProjectSetup(await planProjectSetup(root, required), { install: false });
    expect(lines.join("\n")).toContain("Yarn 2+): YARN_ENABLE_SCRIPTS=false yarn add");
    expect(lines.join("\n")).toContain("--ignore-scripts --ignore-workspace-root-check");
  });

  it("restores declared but uninstalled packages on repeat runs without rewriting the manifest", async () => {
    const root = await project({ "package.json": JSON.stringify({ dependencies: Object.fromEntries(required.map((name) => [name, "^1.0.0"])) }) });
    await applyProjectSetup(await planProjectSetup(root, required), { install: false });
    const before = await fs.readFile(path.join(root, "package.json"), "utf8");
    const plan = await planProjectSetup(root, required);
    const installer = vi.fn().mockResolvedValue(undefined);
    expect(plan.manifestContents).toBeUndefined();
    await applyProjectSetup(plan, { installer });
    expect(installer).toHaveBeenCalledWith("npm", ["install", "--ignore-scripts"], await fs.realpath(root), undefined);
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(before);
  });

  it("leaves setup in place after installation fails, with a retry command", async () => {
    const root = await project();
    const installer = vi.fn().mockRejectedValue(new Error("registry unavailable"));
    await expect(applyProjectSetup(await planProjectSetup(root, required), { installer })).rejects.toThrow(/registry unavailable.*Setup files were kept.*Retry init/u);
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).scripts.translate).toBe("ai-translate sync");
    await applyProjectSetup(await planProjectSetup(root, required), { installer: vi.fn().mockResolvedValue(undefined) });
  });

  it("does not overwrite a manifest edited after planning", async () => {
    const root = await project({ "package.json": "{}" });
    const plan = await planProjectSetup(root, required);
    await fs.writeFile(path.join(root, "package.json"), '{"user":"edit"}');
    const installer = vi.fn();
    await expect(applyProjectSetup(plan, { installer })).rejects.toThrow(/changed during init/u);
    expect(installer).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe('{"user":"edit"}');
  });

  it("does not overwrite a manifest created after planning", async () => {
    const root = await project();
    const plan = await planProjectSetup(root, required);
    await fs.writeFile(path.join(root, "package.json"), '{"new":"file"}');
    await expect(applyProjectSetup(plan, { install: false })).rejects.toThrow(/changed during init/u);
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe('{"new":"file"}');
  });

  it("reports actual installer failures and keeps retryable setup", async () => {
    const root = await project();
    const bin = path.join(root, "bin");
    await managerShim(bin, "npm", 'process.exit(17);\n');
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    await expect(applyProjectSetup(await planProjectSetup(root, required))).rejects.toThrow(/npm exited with code 17.*Setup files were kept/u);
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).private).toBe(true);
  });

  it("does not follow a manifest replaced by a symlink after planning", async () => {
    const root = await project({ "package.json": "{}", "outside.json": "{}" });
    const plan = await planProjectSetup(root, required);
    await fs.unlink(path.join(root, "package.json"));
    await fs.symlink(path.join(root, "outside.json"), path.join(root, "package.json"));
    await expect(applyProjectSetup(plan, { install: false })).rejects.toThrow(/regular file/u);
    expect(await fs.readFile(path.join(root, "outside.json"), "utf8")).toBe("{}");
  });

  it.each(["1.22.22", "4.9.0"])("disables lifecycle scripts with the actual Yarn %s binary", async (version) => {
    const root = await project({ "package.json": '{"packageManager":"yarn@4.9.0"}' });
    const bin = path.join(root, "bin");
    const output = path.join(root, "invocation.json");
    await managerShim(bin, "yarn", `const fs = require('node:fs');\nif (process.argv[2] === '--version') console.log(${JSON.stringify(version)});\nelse fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({args:process.argv.slice(2), scripts:process.env.YARN_ENABLE_SCRIPTS}));\n`);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    await applyProjectSetup(await planProjectSetup(root, required));
    const invocation = JSON.parse(await fs.readFile(output, "utf8"));
    expect(invocation.args.includes("--ignore-scripts")).toBe(version.startsWith("1."));
    expect(invocation.args.includes("--ignore-workspace-root-check")).toBe(version.startsWith("1."));
    expect(invocation.scripts).toBe(version.startsWith("1.") ? undefined : "false");
  });
});

describe("package manager process invocation", () => {
  it.each(["npm", "pnpm", "yarn"])("uses cmd.exe for Windows %s shims with a fixed safe command", (manager) => {
    const process = packageManagerProcess(manager, ["add", "--dev", "@ai-translate/cli"], "win32");
    expect(process.command.toLowerCase()).toMatch(/cmd\.exe$/u);
    expect(process.args).toEqual(["/d", "/s", "/c", `"${manager} add --dev @ai-translate/cli"`]);
    expect(process.windowsVerbatimArguments).toBe(true);
  });

  it("uses a native executable for Bun and Unix managers", () => {
    expect(packageManagerProcess("bun", ["add", "--dev"], "win32")).toEqual({ command: "bun", args: ["add", "--dev"] });
    expect(packageManagerProcess("npm", ["install"], "darwin")).toEqual({ command: "npm", args: ["install"] });
  });

  it.each(["pkg & calc", "%COMSPEC%", "!variable!", "pkg^arg", 'pkg"arg', "pkg\nnext"])("rejects cmd.exe metacharacters in %s", (argument) => {
    expect(() => packageManagerProcess("npm", ["install", argument], "win32")).toThrow(/Unsafe Windows/u);
  });

  it("rejects arbitrary Windows shell commands", () => {
    expect(() => packageManagerProcess("npm & calc", ["install"], "win32")).toThrow(/Unsafe Windows/u);
  });
});
