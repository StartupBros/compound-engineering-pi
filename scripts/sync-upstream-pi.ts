import { access, mkdtemp, rm, cp, mkdir } from "fs/promises"
import os from "os"
import path from "path"

const repoRoot = path.resolve(import.meta.dir, "..")
const defaultCacheSource = path.join(os.homedir(), ".cache", "checkouts", "github.com", "EveryInc", "compound-engineering-plugin")
const siblingSource = path.resolve(repoRoot, "../compound-engineering-plugin")
const sourceRoot = process.env.COMPOUND_PLUGIN_SOURCE
  ? path.resolve(process.env.COMPOUND_PLUGIN_SOURCE)
  : await pathExists(defaultCacheSource)
    ? defaultCacheSource
    : siblingSource

const sourcePluginDir = path.join(sourceRoot, "plugins", "compound-engineering")
const targetPluginDir = path.join(repoRoot, "plugins", "compound-engineering")
const piOwnedSkillNames = ["onboarding", "reproduce-bug", "slfg", "todo-resolve", "todo-triage"]
const generatedRoot = await mkdtemp(path.join(os.tmpdir(), "compound-engineering-pi-sync-"))

try {
  await run("bun", [
    "run",
    "src/index.ts",
    "install",
    "./plugins/compound-engineering",
    "--to",
    "pi",
    "--pi-home",
    generatedRoot,
  ], sourceRoot)

  const generatedPiRoot = path.join(generatedRoot, ".pi")
  const generatedSkillsDir = path.join(generatedPiRoot, "skills")
  const generatedAgentsDir = path.join(generatedPiRoot, "agents")
  const generatedMcporterPath = path.join(generatedPiRoot, "compound-engineering", "mcporter.json")

  const preservedPiOwnedSkillsDir = path.join(generatedRoot, "pi-owned-skills")
  const preservedPiOwnedSkills = await preservePiOwnedSkills(preservedPiOwnedSkillsDir)

  console.log(`Syncing vendored plugin snapshot from ${sourcePluginDir}`)
  await replaceDir(targetPluginDir, sourcePluginDir)

  console.log(`Syncing generated Pi skills from ${generatedSkillsDir}`)
  await replaceDir(path.join(repoRoot, "skills"), generatedSkillsDir)
  await restorePiOwnedSkills(preservedPiOwnedSkillsDir, preservedPiOwnedSkills)

  if (await pathExists(generatedAgentsDir)) {
    console.log(`Syncing generated Pi agents from ${generatedAgentsDir}`)
    await replaceDir(path.join(repoRoot, "agents"), generatedAgentsDir)
  } else {
    console.log("No generated Pi agents found; preserving existing agents directory if present.")
  }

  if (await pathExists(generatedMcporterPath)) {
    console.log(`Syncing bundled MCPorter config from ${generatedMcporterPath}`)
    await copyFileToPath(generatedMcporterPath, path.join(repoRoot, "pi-resources", "compound-engineering", "mcporter.json"))
  } else {
    console.log("No generated MCPorter config found; preserving existing bundled config.")
  }

  console.log("Done. Note: prompts/, extensions/, and Pi-owned compatibility skills are preserved.")
} finally {
  await rm(generatedRoot, { recursive: true, force: true })
}

async function run(command: string, args: string[], cwd: string) {
  console.log(`$ (cd ${cwd} && ${[command, ...args].join(" ")})`)
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode}`)
  }
}

async function replaceDir(target: string, source: string) {
  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true })
}

async function copyFileToPath(source: string, target: string) {
  await rm(target, { force: true })
  await cp(source, target)
}

async function preservePiOwnedSkills(preservedRoot: string): Promise<string[]> {
  const preserved = [] as string[]
  await mkdir(preservedRoot, { recursive: true })
  for (const skillName of piOwnedSkillNames) {
    const source = path.join(repoRoot, "skills", skillName)
    if (!(await pathExists(source))) continue
    await cp(source, path.join(preservedRoot, skillName), { recursive: true })
    preserved.push(skillName)
  }
  return preserved
}

async function restorePiOwnedSkills(preservedRoot: string, skillNames: string[]) {
  for (const skillName of skillNames) {
    const target = path.join(repoRoot, "skills", skillName)
    if (await pathExists(target)) {
      throw new Error(`Upstream generated a skill named ${skillName}; resolve the conflict before preserving the Pi-owned copy.`)
    }
    console.log(`Restoring Pi-owned compatibility skill ${skillName}`)
    await cp(path.join(preservedRoot, skillName), target, { recursive: true })
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
