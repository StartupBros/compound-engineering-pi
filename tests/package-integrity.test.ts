import { describe, expect, test } from "bun:test"
import { promises as fs } from "fs"
import path from "path"

const repoRoot = path.resolve(import.meta.dir, "..")

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readRepoFile(...segments: string[]): Promise<string> {
  return fs.readFile(path.join(repoRoot, ...segments), "utf8")
}

describe("package integrity", () => {
  test("Pi runtime extensions load prompt templates from the published prompts directory", async () => {
    const workflowCommands = await readRepoFile("extensions", "workflow-commands.ts")
    const reviewRuntime = await readRepoFile("extensions", "review-runtime.ts")

    expect(workflowCommands).toContain('"..", "prompts"')
    expect(reviewRuntime).toContain('"..", "prompts", "workflows-review.md"')
    expect(workflowCommands).not.toContain("workflow-prompts")
    expect(reviewRuntime).not.toContain("workflow-prompts")
    expect(reviewRuntime).not.toContain("/home/")
  })

  test("published package has a single canonical prompt-template source", async () => {
    const packageJson = JSON.parse(await readRepoFile("package.json"))

    expect(packageJson.files).toContain("prompts")
    expect(packageJson.pi.prompts).toEqual(["./prompts"])
    expect(packageJson.files).not.toContain("workflow-prompts")
    expect(await pathExists(path.join(repoRoot, "workflow-prompts"))).toBe(false)
  })

  test("Pi-owned compatibility skills referenced by commands are present", async () => {
    const skillNames = ["onboarding", "reproduce-bug", "slfg", "todo-resolve", "todo-triage"]

    for (const skillName of skillNames) {
      expect(await pathExists(path.join(repoRoot, "skills", skillName, "SKILL.md"))).toBe(true)
    }
  })

  test("Pi runtime support modules use extension-resolvable relative imports", async () => {
    const ceTodos = await readRepoFile("src", "ce-todos.ts")

    expect(ceTodos).toContain('from "./workflow-context.ts"')
    expect(ceTodos).not.toMatch(/from ["']\.\/workflow-context["']/)
  })

  test("legacy workflows colon aliases remain extension-backed", async () => {
    const workflowCommands = await readRepoFile("extensions", "workflow-commands.ts")

    for (const command of ["workflows:brainstorm", "workflows:plan", "workflows:work", "workflows:compound"]) {
      expect(workflowCommands).toContain(`command: "${command}"`)
    }
  })

  test("does not ship stale bundled MCPorter config when upstream has no MCP servers", async () => {
    expect(await pathExists(path.join(repoRoot, "plugins", "compound-engineering", ".mcp.json"))).toBe(false)
    expect(await pathExists(path.join(repoRoot, "pi-resources", "compound-engineering", "mcporter.json"))).toBe(false)
  })

  test("compat subagent tool exposes full-output reporting controls", async () => {
    const compatExtension = await readRepoFile("extensions", "compound-engineering-compat.ts")

    expect(compatExtension).toContain("includeOutputs")
    expect(compatExtension).toContain("formatSingleSubagentResult")
    expect(compatExtension).toContain("formatChainSubagentResult")
  })
})
