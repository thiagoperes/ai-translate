import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface ProjectInstallCommand {
  command: PackageManager;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
}

export interface ProjectSetupPlan {
  packageManager: PackageManager;
  manifestPath: string;
  /** Undefined when the existing manifest needs no edits. */
  manifestContents: string | undefined;
  originalManifest: string | undefined;
  packages: readonly string[];
  installCommand: ProjectInstallCommand;
}

export type ProjectInstaller = (
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
) => Promise<void>;

const MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];
const LOCKFILES: Readonly<Record<PackageManager, readonly string[]>> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};
const SCRIPTS = {
  translate: "ai-translate sync",
  "translate:check": "ai-translate check",
  "translate:validate": "ai-translate validate",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(
  contents: string,
  manifestPath: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(
      `Invalid JSON in ${manifestPath}. Fix it before running init.`,
    );
  }
  if (!isRecord(value)) {
    throw new Error(`${manifestPath} must contain a JSON object.`);
  }
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "scripts",
  ]) {
    const entries = value[field];
    if (
      entries !== undefined &&
      (!isRecord(entries) ||
        Object.values(entries).some(
          (entry) =>
            typeof entry !== "string" ||
            (field !== "scripts" && entry.trim() === ""),
        ))
    ) {
      throw new Error(
        `${manifestPath}: ${field} must be an object of strings.`,
      );
    }
  }
  if (
    value.packageManager !== undefined &&
    typeof value.packageManager !== "string"
  ) {
    throw new Error(`${manifestPath}: packageManager must be a string.`);
  }
  if (value.workspaces !== undefined) {
    const patterns = isRecord(value.workspaces)
      ? value.workspaces.packages
      : value.workspaces;
    if (
      !Array.isArray(patterns) ||
      patterns.some(
        (pattern) => typeof pattern !== "string" || pattern.trim() === "",
      )
    ) {
      throw new Error(
        `${manifestPath}: workspaces must contain an array of package patterns.`,
      );
    }
  }
  return value;
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Only literal lists establish membership; YAML aliases and expressions do not. */
function pnpmWorkspacePatterns(
  contents: string,
): readonly string[] | undefined {
  const lines = contents.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^packages\s*:/u.test(line));
  if (start === -1) {
    return undefined;
  }
  const inline = lines[start]?.replace(/^packages\s*:\s*/u, "").trim() ?? "";
  if (inline !== "" && !inline.startsWith("#")) {
    try {
      const parsed: unknown = JSON.parse(inline);
      return Array.isArray(parsed) &&
        parsed.every((value) => typeof value === "string")
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (!/^(?:\s|-)/u.test(line)) {
      break;
    }
    const item = line.match(/^\s*-\s+(.+?)\s*$/u)?.[1];
    if (item === undefined) {
      return undefined;
    }
    const doubleQuoted = item.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/u)?.[1];
    const singleQuoted = item.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/u)?.[1];
    if (doubleQuoted !== undefined) {
      try {
        patterns.push(JSON.parse(doubleQuoted) as string);
      } catch {
        return undefined;
      }
    } else if (singleQuoted !== undefined) {
      patterns.push(singleQuoted.replaceAll("''", "'"));
    } else {
      const plain = item.replace(/\s+#.*$/u, "");
      if (/^[!*&@[{?]|[\s"'#:>|]/u.test(plain)) {
        return undefined;
      }
      patterns.push(plain);
    }
  }
  return patterns;
}

function matchesWorkspace(
  relative: string,
  patterns: readonly string[],
): boolean {
  const normalized = relative.split(path.sep).join("/");
  const matches = (pattern: string) =>
    path.matchesGlob(
      normalized,
      pattern.replace(/^\.\//u, "").replace(/\/$/u, ""),
    );
  return (
    patterns.some((pattern) => !pattern.startsWith("!") && matches(pattern)) &&
    !patterns.some(
      (pattern) => pattern.startsWith("!") && matches(pattern.slice(1)),
    )
  );
}

async function workspaceRoot(
  cwd: string,
  manifest: Record<string, unknown>,
): Promise<{ root: string; manifest: Record<string, unknown> } | undefined> {
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    const text =
      directory === cwd
        ? undefined
        : await readOptional(path.join(directory, "package.json"));
    const candidate =
      directory === cwd
        ? manifest
        : text === undefined
          ? {}
          : parseManifest(text, path.join(directory, "package.json"));
    const pnpmWorkspace = await readOptional(
      path.join(directory, "pnpm-workspace.yaml"),
    );
    if (candidate.workspaces !== undefined || pnpmWorkspace !== undefined) {
      const declared = isRecord(candidate.workspaces)
        ? candidate.workspaces.packages
        : candidate.workspaces;
      const patterns =
        pnpmWorkspace === undefined
          ? (declared as readonly string[])
          : pnpmWorkspacePatterns(pnpmWorkspace);
      return directory === cwd ||
        (patterns !== undefined &&
          matchesWorkspace(path.relative(directory, cwd), patterns))
        ? { root: directory, manifest: candidate }
        : undefined;
    }
    if (
      path.dirname(directory) === directory ||
      (await exists(path.join(directory, ".git")))
    ) {
      return undefined;
    }
  }
}

function managerFromDeclaration(value: unknown): PackageManager | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("The package manager must be npm, pnpm, yarn, or bun.");
  }
  const name = value.split("@")[0];
  if (!MANAGERS.includes(name as PackageManager)) {
    throw new Error(
      `Unsupported package manager ${value}. Use --package-manager npm, pnpm, yarn, or bun.`,
    );
  }
  return name as PackageManager;
}

/** Reads project metadata only. Preview never executes a package manager or writes files. */
export async function planProjectSetup(
  cwd: string,
  packages: readonly string[],
  options: { packageManager?: PackageManager } = {},
): Promise<ProjectSetupPlan> {
  for (const name of packages) {
    if (
      name.length > 214 ||
      !/^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/iu.test(name)
    ) {
      throw new Error(
        `Invalid dependency package name ${JSON.stringify(name)}.`,
      );
    }
  }
  const root = await fs.realpath(cwd);
  const manifestPath = path.join(root, "package.json");
  if (await exists(manifestPath)) {
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile()) {
      throw new Error(
        `${manifestPath} must be a regular file, not a symlink or directory.`,
      );
    }
  }
  const originalManifest = await readOptional(manifestPath);
  const manifest: Record<string, unknown> =
    originalManifest === undefined
      ? { private: true }
      : parseManifest(originalManifest, manifestPath);
  const workspace = await workspaceRoot(root, manifest);
  let manager = managerFromDeclaration(
    options.packageManager ??
      manifest.packageManager ??
      workspace?.manifest.packageManager,
  );
  if (manager === undefined) {
    const detected = new Set<PackageManager>();
    for (let directory = root; ; directory = path.dirname(directory)) {
      for (const candidate of MANAGERS) {
        for (const fileName of LOCKFILES[candidate]) {
          if (await exists(path.join(directory, fileName))) {
            detected.add(candidate);
          }
        }
      }
      if (directory === (workspace?.root ?? root)) {
        break;
      }
    }
    if (detected.size > 1) {
      throw new Error(
        `Ambiguous package managers (${[...detected].join(", ")}). Pass --package-manager to choose.`,
      );
    }
    manager = [...detected][0] ?? "npm";
  }
  const declared = new Set(
    ["dependencies", "devDependencies", "optionalDependencies"].flatMap(
      (field) => Object.keys((manifest[field] ?? {}) as Record<string, string>),
    ),
  );
  const missing = [...new Set(packages)].filter((name) => !declared.has(name));
  const scripts = {
    ...(manifest.scripts as Record<string, string> | undefined),
  };
  let changed = originalManifest === undefined;
  for (const [name, command] of Object.entries(SCRIPTS)) {
    if (!Object.hasOwn(scripts, name)) {
      scripts[name] = command;
      changed = true;
    }
  }
  const indent = originalManifest?.match(/\r?\n([\t ]+)"/u)?.[1] ?? "  ";
  const newline = originalManifest?.includes("\r\n") === true ? "\r\n" : "\n";
  const manifestContents = changed
    ? `${JSON.stringify({ ...manifest, scripts }, null, indent).replaceAll("\n", newline)}${newline}`
    : undefined;
  const adding = missing.length > 0;
  const args =
    manager === "npm"
      ? [
          "install",
          ...(adding ? ["--save-dev"] : []),
          "--ignore-scripts",
          ...missing,
        ]
      : manager === "pnpm"
        ? [
            adding ? "add" : "install",
            ...(adding
              ? [
                  "--save-dev",
                  ...(workspace?.root === root ? ["--workspace-root"] : []),
                ]
              : []),
            "--ignore-scripts",
            ...missing,
          ]
        : manager === "bun"
          ? [
              adding ? "add" : "install",
              ...(adding ? ["--dev"] : []),
              "--ignore-scripts",
              ...missing,
            ]
          : [
              adding ? "add" : "install",
              ...(adding ? ["--dev"] : []),
              ...missing,
            ];
  return {
    packageManager: manager,
    manifestPath,
    manifestContents,
    originalManifest,
    packages: missing,
    installCommand: {
      command: manager,
      args,
      cwd: root,
      ...(manager === "yarn" ? { env: { YARN_ENABLE_SCRIPTS: "false" } } : {}),
    },
  };
}

const executeFile = promisify(execFile);

/** Windows package-manager shims need cmd.exe. Only fixed manager names and
 * argument tokens generated by this module may enter its command string. */
export function packageManagerProcess(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== "win32" || command === "bun") {
    return { command, args: [...args] };
  }
  if (
    !MANAGERS.includes(command as PackageManager) ||
    args.some((arg) => !/^[-@a-z\d._/]+$/iu.test(arg))
  ) {
    throw new Error("Unsafe Windows package-manager command or argument.");
  }
  return {
    command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${command} ${args.join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}

const installProject: ProjectInstaller = async (command, args, cwd, env) => {
  let actualArgs = [...args];
  let actualEnv = { ...process.env, ...env };
  if (command === "yarn") {
    const probe = packageManagerProcess(command, ["--version"]);
    const { stdout } = await executeFile(probe.command, probe.args, {
      cwd,
      timeout: 15_000,
      ...(probe.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: probe.windowsVerbatimArguments }),
    });
    const major = Number.parseInt(stdout.trim().split(".")[0] ?? "", 10);
    if (!Number.isFinite(major) || major < 1) {
      throw new Error("Unable to determine the installed Yarn version.");
    }
    if (major === 1) {
      actualArgs = [
        ...actualArgs,
        "--ignore-scripts",
        ...(actualArgs[0] === "add" ? ["--ignore-workspace-root-check"] : []),
      ];
      actualEnv = { ...process.env };
    }
  }
  await new Promise<void>((resolve, reject) => {
    const invocation = packageManagerProcess(command, actualArgs);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: actualEnv,
      shell: false,
      stdio: "inherit",
      ...(invocation.windowsVerbatimArguments === undefined
        ? {}
        : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} exited ${signal === null ? `with code ${String(code)}` : `after signal ${signal}`}.`,
          ),
        );
      }
    });
  });
};

/** Leaves successful setup edits in place if installing fails, so init can be retried. */
export async function applyProjectSetup(
  plan: ProjectSetupPlan,
  options: { install?: boolean; installer?: ProjectInstaller } = {},
): Promise<readonly string[]> {
  const current = await readOptional(plan.manifestPath);
  if (current !== plan.originalManifest) {
    throw new Error(
      `${plan.manifestPath} changed during init. Run init again.`,
    );
  }
  if (
    (await exists(plan.manifestPath)) &&
    !(await fs.lstat(plan.manifestPath)).isFile()
  ) {
    throw new Error(
      `${plan.manifestPath} must be a regular file, not a symlink or directory.`,
    );
  }
  const lines: string[] = [];
  if (plan.manifestContents !== undefined) {
    await fs.writeFile(plan.manifestPath, plan.manifestContents, {
      encoding: "utf8",
      flag: plan.originalManifest === undefined ? "wx" : "w",
    });
    lines.push(
      `${plan.originalManifest === undefined ? "Created" : "Updated"} package.json with translation scripts.`,
    );
  }
  const { command, args, cwd, env } = plan.installCommand;
  if (options.install === false) {
    if (command === "yarn") {
      lines.push(
        `Install dependencies (Yarn 2+): YARN_ENABLE_SCRIPTS=false yarn ${args.join(" ")}`,
        `Install dependencies (Yarn 1): yarn ${args.join(" ")} --ignore-scripts${args[0] === "add" ? " --ignore-workspace-root-check" : ""}`,
      );
    } else {
      lines.push(`Install dependencies: ${command} ${args.join(" ")}`);
    }
    return lines;
  }
  try {
    await (options.installer ?? installProject)(command, args, cwd, env);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const retry =
      command === "yarn"
        ? "Retry init to select the correct Yarn flags."
        : `Retry init, or run ${command} ${args.join(" ")}.`;
    throw new Error(
      `Dependency installation failed: ${detail} Setup files were kept. ${retry}`,
      { cause: error },
    );
  }
  lines.push(
    `Dependencies installed with ${command}; lifecycle scripts were disabled.`,
  );
  return lines;
}
