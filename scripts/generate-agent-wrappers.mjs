#!/usr/bin/env node
import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname)
const skillsDir = path.join(repoRoot, "skills")
const packageAgentsDir = path.join(repoRoot, "agents")
const targetAgentsDir = path.join(os.homedir(), ".pi", "agent", "agents")

const HEADER = `# Global Compound Engineering agent wrappers

These files make Compound Engineering available to the global \`pi-subagents\` runtime.

Sources:
- \`${packageAgentsDir}\` contains generated Pi agents converted from upstream CE agents
- \`${skillsDir}\` contains generated Pi skills and a few Pi compatibility skills

This script writes into \`${targetAgentsDir}\` for local dogfooding. It is intentionally a developer convenience; the package's source of truth remains this repo.
`

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function listSkillNames() {
  if (!(await pathExists(skillsDir))) return []
  const entries = await fs.readdir(skillsDir, { withFileTypes: true })
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await pathExists(path.join(skillsDir, entry.name, "SKILL.md"))) {
      names.push(entry.name)
    }
  }
  return names.sort()
}

async function listGeneratedAgentFiles() {
  if (!(await pathExists(packageAgentsDir))) return []
  const entries = await fs.readdir(packageAgentsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()
}

async function writeFileIfChanged(filePath, content) {
  const existing = await fs.readFile(filePath, "utf8").catch(() => null)
  if (existing === content) return false
  await fs.writeFile(filePath, content, "utf8")
  return true
}

function skillWrapperBody(skillName) {
  return [
    "---",
    `name: ${skillName}`,
    `description: Compound Engineering skill wrapper: ${skillName}`,
    "tools: read, bash, edit, write, grep, find, ls",
    "thinking: medium",
    `skill: ${skillName}`,
    "defaultProgress: true",
    "---",
    `Use the injected Compound Engineering skill \`${skillName}\` to carry out the assigned task.`,
    "Prefer concrete evidence, stay scoped to the request, and only edit files when the task explicitly calls for changes.",
    "",
  ].join("\n")
}

function aliasAgentContent(content, aliasName) {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 4)
    if (end !== -1) {
      const frontmatter = content.slice(4, end)
      const body = content.slice(end + 5)
      const updatedFrontmatter = frontmatter.replace(/^name:\s*.+$/m, `name: ${aliasName}`)
      return `---\n${updatedFrontmatter}\n---\n${body}`
    }
  }

  return [
    "---",
    `name: ${aliasName}`,
    `description: Compound Engineering generated agent alias: ${aliasName}`,
    "---",
    content,
  ].join("\n")
}

async function main() {
  await ensureDir(targetAgentsDir)
  let changed = 0

  changed += Number(await writeFileIfChanged(path.join(targetAgentsDir, "README.md"), HEADER))

  const generatedAgentFiles = await listGeneratedAgentFiles()
  const generatedAgentNames = new Set(generatedAgentFiles.map((file) => file.replace(/\.md$/, "")))

  for (const fileName of generatedAgentFiles) {
    const sourcePath = path.join(packageAgentsDir, fileName)
    const content = await fs.readFile(sourcePath, "utf8")
    changed += Number(await writeFileIfChanged(path.join(targetAgentsDir, fileName), content))

    const agentName = fileName.replace(/\.md$/, "")
    if (agentName.startsWith("ce-")) {
      const aliasName = agentName.slice("ce-".length)
      changed += Number(await writeFileIfChanged(
        path.join(targetAgentsDir, `${aliasName}.md`),
        aliasAgentContent(content, aliasName),
      ))
    }
  }

  const skillNames = await listSkillNames()
  for (const skillName of skillNames) {
    if (generatedAgentNames.has(skillName)) continue
    changed += Number(await writeFileIfChanged(path.join(targetAgentsDir, `${skillName}.md`), skillWrapperBody(skillName)))
  }

  console.log(`Generated/updated ${changed} wrapper files in ${targetAgentsDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
