import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ADM_ZIP_OVERRIDE = "0.6.0";

interface EnableLevel1Options {
  packageDir?: string;
  gpu: boolean;
  withStt: boolean;
  dryRun: boolean;
}

type PeerPackageName = "@reflectworld/percept" | "@reflectworld/cam";

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}

interface NativeDependency {
  name: string;
  range: string;
}

function parseArgs(args: string[]): EnableLevel1Options {
  const opts: EnableLevel1Options = { gpu: false, withStt: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--gpu") opts.gpu = true;
    else if (arg === "--with-stt") opts.withStt = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--package-dir" && args[i + 1]) {
      opts.packageDir = args[i + 1]!;
      i++;
    } else if (arg === "--yes" || arg === "-y") {
      // Accepted for script symmetry; this command is already non-interactive.
    } else {
      throw new Error(`Unknown enable-level1 option: ${arg}`);
    }
  }
  return opts;
}

function findReflectWorldPackageRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "@reflectworld/reflectworld") return dir;
      } catch { /* continue */ }
    }
    dir = dirname(dir);
  }
  throw new Error("Cannot locate @reflectworld/reflectworld package root. Pass --package-dir <dir>.");
}

function findNearestPackageRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readPackageJson(path: string): PackageManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
  } catch {
    return undefined;
  }
}

function dependencyPackageJson(root: string, packageName: PeerPackageName): PackageManifest | undefined {
  const [, shortName] = packageName.split("/");
  const candidates = [
    join(root, "node_modules", "@reflectworld", shortName!, "package.json"),
    join(root, "..", shortName!, "package.json"),
    join(root, "..", "..", "packages", shortName!, "package.json"),
  ];
  for (const candidate of candidates) {
    const pkg = readPackageJson(candidate);
    if (pkg?.name === packageName) return pkg;
  }
  return undefined;
}

function nativeDependency(
  installRoot: string,
  runtimeRoot: string,
  packageName: PeerPackageName,
  peerName: string,
): NativeDependency {
  const installPackage = readPackageJson(join(installRoot, "package.json"));
  const runtimePackage = readPackageJson(join(runtimeRoot, "package.json"));
  const dependencyPackage = dependencyPackageJson(runtimeRoot, packageName);
  const range = installPackage?.peerDependencies?.[peerName]
    ?? runtimePackage?.peerDependencies?.[peerName]
    ?? dependencyPackage?.peerDependencies?.[peerName];
  return { name: peerName, range: typeof range === "string" ? range : "*" };
}

function resolveInstallRoot(opts: EnableLevel1Options, runtimeRoot: string): string {
  const root = opts.packageDir
    ? resolve(opts.packageDir)
    : findNearestPackageRoot(process.cwd()) ?? runtimeRoot;
  if (!existsSync(join(root, "package.json"))) {
    throw new Error(`Package directory does not contain package.json: ${root}`);
  }
  return root;
}

function resolveNpmRoot(installRoot: string): string {
  let npmRoot: string;
  try {
    npmRoot = resolve(execFileSync("npm", ["prefix"], {
      cwd: installRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim());
  } catch (error) {
    throw new Error(`Cannot resolve the npm project root from ${installRoot}.`, { cause: error });
  }

  if (!existsSync(join(npmRoot, "package.json"))) {
    throw new Error(`npm project root does not contain package.json: ${npmRoot}`);
  }
  return npmRoot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addSecurityOverride(packageJsonPath: string): void {
  const original = readFileSync(packageJsonPath, "utf8");
  const manifest = JSON.parse(original) as PackageManifest;
  if (manifest.overrides !== undefined && !isRecord(manifest.overrides)) {
    throw new Error(`package.json overrides must be an object: ${packageJsonPath}`);
  }

  const overrides = manifest.overrides ?? {};
  const globalOverride = overrides["adm-zip"];
  if (globalOverride === ADM_ZIP_OVERRIDE) return;
  if (globalOverride !== undefined) {
    throw new Error(
      `Cannot replace existing adm-zip override (${String(globalOverride)}). `
      + `Set it to ${ADM_ZIP_OVERRIDE} and run enable-level1 again.`,
    );
  }

  const onnxOverride = overrides["onnxruntime-node"];
  if (onnxOverride !== undefined && !isRecord(onnxOverride)) {
    throw new Error(
      "Cannot add the adm-zip security override because overrides.onnxruntime-node is not an object.",
    );
  }

  const onnxOverrides = onnxOverride ?? {};
  const existing = onnxOverrides["adm-zip"];
  if (existing === ADM_ZIP_OVERRIDE) return;
  if (existing !== undefined) {
    throw new Error(
      `Cannot replace existing onnxruntime-node > adm-zip override (${String(existing)}). `
      + `Set it to ${ADM_ZIP_OVERRIDE} and run enable-level1 again.`,
    );
  }

  manifest.overrides = {
    ...overrides,
    "onnxruntime-node": { ...onnxOverrides, "adm-zip": ADM_ZIP_OVERRIDE },
  };
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function addDependencies(packageJsonPath: string, dependencies: NativeDependency[]): void {
  const original = readFileSync(packageJsonPath, "utf8");
  const manifest = JSON.parse(original) as PackageManifest;
  if (manifest.dependencies !== undefined && !isRecord(manifest.dependencies)) {
    throw new Error(`package.json dependencies must be an object: ${packageJsonPath}`);
  }

  manifest.dependencies = { ...manifest.dependencies };
  for (const dependency of dependencies) {
    manifest.dependencies[dependency.name] = dependency.range;
  }
  writeFileSync(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function dependencySpec(dependency: NativeDependency): string {
  return dependency.range === "*" ? dependency.name : `${dependency.name}@${dependency.range}`;
}

export async function runEnableLevel1(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const runtimeRoot = findReflectWorldPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const installRoot = resolveInstallRoot(opts, runtimeRoot);
  const resolvedNpmRoot = resolveNpmRoot(installRoot);
  const physicalInstallRoot = realpathSync(installRoot);
  const physicalNpmRoot = realpathSync(resolvedNpmRoot);
  const workspacePath = relative(physicalNpmRoot, physicalInstallRoot);
  if (workspacePath === ".." || workspacePath.startsWith(`..${sep}`) || isAbsolute(workspacePath)) {
    throw new Error(`Install project is outside the npm project root: ${installRoot}`);
  }
  const npmRoot = workspacePath === "" ? installRoot : resolvedNpmRoot;

  const dependencies = [
    nativeDependency(installRoot, runtimeRoot, "@reflectworld/percept", "onnxruntime-node"),
    nativeDependency(installRoot, runtimeRoot, "@reflectworld/percept", "sharp"),
    ...(opts.withStt
      ? [nativeDependency(installRoot, runtimeRoot, "@reflectworld/cam", "sherpa-onnx-node")]
      : []),
  ];

  const npmArgs = ["install"];
  console.log("\nReflectWorld Level 1 native dependency setup\n");
  console.log(`Install project: ${installRoot}`);
  if (npmRoot !== installRoot) console.log(`npm project root: ${npmRoot}`);
  console.log(`Dependencies: ${dependencies.map(dependencySpec).join(" ")}`);
  console.log(`Security override: onnxruntime-node > adm-zip=${ADM_ZIP_OVERRIDE}`);
  console.log(`Command: npm ${npmArgs.join(" ")}\n`);
  if (opts.gpu) {
    console.log(
      "--gpu is now a compatibility flag. ReflectWorld uses onnxruntime-node for both CPU/CoreML and CUDA; " +
      "CUDA is detected at runtime when NVIDIA driver, CUDA runtime, and cuDNN 9 are visible to Node.\n",
    );
  }

  if (!opts.dryRun) {
    const installPackageJsonPath = join(installRoot, "package.json");
    const npmPackageJsonPath = join(npmRoot, "package.json");
    const originalInstallPackageJson = readFileSync(installPackageJsonPath, "utf8");
    const originalNpmPackageJson = npmPackageJsonPath === installPackageJsonPath
      ? originalInstallPackageJson
      : readFileSync(npmPackageJsonPath, "utf8");

    try {
      addSecurityOverride(npmPackageJsonPath);
      addDependencies(installPackageJsonPath, dependencies);
      if (npmPackageJsonPath !== installPackageJsonPath) {
        const onnxRuntime = dependencies.find(({ name }) => name === "onnxruntime-node");
        if (!onnxRuntime) throw new Error("Cannot resolve the onnxruntime-node dependency range.");
        addDependencies(npmPackageJsonPath, [onnxRuntime]);
      }
      execFileSync("npm", npmArgs, { cwd: npmRoot, stdio: "inherit" });
    } catch (error) {
      writeFileSync(npmPackageJsonPath, originalNpmPackageJson);
      if (installPackageJsonPath !== npmPackageJsonPath) {
        writeFileSync(installPackageJsonPath, originalInstallPackageJson);
      }
      throw error;
    }
  }

  console.log(opts.dryRun ? "\nDry run complete; no packages were installed." : "\nNative dependencies are installed.");
  console.log("Next steps:");
  console.log("  1. Ensure Level 1 model files exist under REFLECTWORLD_MODELS_DIR or ~/.reflectworld/models.");
  console.log("  2. Run: reflectworld setup --level 1 --yes --accept-model-licenses");
  console.log("     (--accept-model-licenses acknowledges the AGPL / non-commercial model licenses;");
  console.log("      without it, Level 1 models are skipped and setup stays at Level 0.)");
  console.log("  3. For Linux GPU hosts, ensure CUDA 12 runtime + cuDNN 9 are on the dynamic library path.");
  console.log("  4. Restart OpenClaw: openclaw gateway restart\n");
}
