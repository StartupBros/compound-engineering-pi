import { describe, expect, test } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { writePiBundle } from "../src/targets/pi"
import type { PiBundle } from "../src/types/pi"

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

describe("writePiBundle", () => {
  test("writes prompts, skills, extensions, mcporter config, and AGENTS.md block", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-writer-"))
    const outputRoot = path.join(tempRoot, ".pi")
    const sourceSkillDir = path.join(tempRoot, "source-skill")
    await fs.mkdir(path.join(sourceSkillDir, "references"), { recursive: true })
    await fs.writeFile(path.join(sourceSkillDir, "SKILL.md"), "---\nname: skill-one\n---\n\nOriginal body")
    await fs.writeFile(path.join(sourceSkillDir, "references", "guide.md"), "Call /ce:work next and use AskUserQuestion if needed.\n")

    const bundle: PiBundle = {
      prompts: [{ name: "workflows-plan", content: "Prompt content" }],
      skillDirs: [
        {
          name: "skill-one",
          sourceDir: sourceSkillDir,
          skillContent: "---\nname: skill-one\ndescription: rewritten\n---\n\nRewritten body",
        },
      ],
      generatedSkills: [{ name: "repo-research-analyst", content: "---\nname: repo-research-analyst\n---\n\nBody" }],
      extensions: [{ name: "compound-engineering-compat.ts", content: "export default function () {}" }],
      mcporterConfig: {
        mcpServers: {
          context7: { baseUrl: "https://mcp.context7.com/mcp" },
        },
      },
    }

    await writePiBundle(outputRoot, bundle)

    expect(await exists(path.join(outputRoot, "prompts", "workflows-plan.md"))).toBe(true)
    expect(await exists(path.join(outputRoot, "skills", "skill-one", "SKILL.md"))).toBe(true)
    const copiedSkill = await fs.readFile(path.join(outputRoot, "skills", "skill-one", "SKILL.md"), "utf8")
    expect(copiedSkill).toContain("Rewritten body")
    const copiedGuide = await fs.readFile(path.join(outputRoot, "skills", "skill-one", "references", "guide.md"), "utf8")
    expect(copiedGuide).toContain("/ce-work")
    expect(copiedGuide).toContain("ask_user_question")
    expect(await exists(path.join(outputRoot, "skills", "repo-research-analyst", "SKILL.md"))).toBe(true)
    expect(await exists(path.join(outputRoot, "extensions", "compound-engineering-compat.ts"))).toBe(true)
    expect(await exists(path.join(outputRoot, "compound-engineering", "mcporter.json"))).toBe(true)

    const agentsPath = path.join(outputRoot, "AGENTS.md")
    const agentsContent = await fs.readFile(agentsPath, "utf8")
    expect(agentsContent).toContain("BEGIN COMPOUND PI TOOL MAP")
    expect(agentsContent).toContain("MCPorter")
  })

  test("writes to ~/.pi/agent style roots without nesting under .pi", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agent-root-"))
    const outputRoot = path.join(tempRoot, "agent")

    const bundle: PiBundle = {
      prompts: [{ name: "workflows-work", content: "Prompt content" }],
      skillDirs: [],
      generatedSkills: [],
      extensions: [],
    }

    await writePiBundle(outputRoot, bundle)

    expect(await exists(path.join(outputRoot, "prompts", "workflows-work.md"))).toBe(true)
    expect(await exists(path.join(outputRoot, ".pi"))).toBe(false)
  })

  test("backs up existing mcporter config before overwriting", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-backup-"))
    const outputRoot = path.join(tempRoot, ".pi")
    const configPath = path.join(outputRoot, "compound-engineering", "mcporter.json")

    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({ previous: true }, null, 2))

    const bundle: PiBundle = {
      prompts: [],
      skillDirs: [],
      generatedSkills: [],
      extensions: [],
      mcporterConfig: {
        mcpServers: {
          linear: { baseUrl: "https://mcp.linear.app/mcp" },
        },
      },
    }

    await writePiBundle(outputRoot, bundle)

    const files = await fs.readdir(path.dirname(configPath))
    const backupFileName = files.find((file) => file.startsWith("mcporter.json.bak."))
    expect(backupFileName).toBeDefined()

    const currentConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as { mcpServers: Record<string, unknown> }
    expect(currentConfig.mcpServers.linear).toBeDefined()
  })
})
