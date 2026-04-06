import { describe, expect, test } from "bun:test"
import path from "path"
import { loadClaudePlugin } from "../src/parsers/claude"
import { convertClaudeToPi } from "../src/converters/claude-to-pi"
import { parseFrontmatter } from "../src/utils/frontmatter"
import type { ClaudePlugin } from "../src/types/claude"

const fixtureRoot = path.join(import.meta.dir, "fixtures", "sample-plugin")

describe("convertClaudeToPi", () => {
  test("converts commands, skills, extensions, and MCPorter config", async () => {
    const plugin = await loadClaudePlugin(fixtureRoot)
    const bundle = convertClaudeToPi(plugin, {
      agentMode: "subagent",
      inferTemperature: false,
      permissions: "none",
    })

    // Prompts are normalized command names
    expect(bundle.prompts.some((prompt) => prompt.name === "workflows-review")).toBe(true)
    expect(bundle.prompts.some((prompt) => prompt.name === "plan_review")).toBe(true)

    // Commands with disable-model-invocation are excluded
    expect(bundle.prompts.some((prompt) => prompt.name === "deploy-docs")).toBe(false)

    const workflowsReview = bundle.prompts.find((prompt) => prompt.name === "workflows-review")
    expect(workflowsReview).toBeDefined()
    const parsedPrompt = parseFrontmatter(workflowsReview!.content)
    expect(parsedPrompt.data.description).toBe("Run a multi-agent review workflow")

    // Existing skills are copied with Pi-normalized names/content and agents are converted into generated Pi skills
    expect(bundle.skillDirs.some((skill) => skill.name === "skill-one")).toBe(true)
    expect(bundle.skillDirs.find((skill) => skill.name === "skill-one")?.skillContent).toContain("name: skill-one")
    expect(bundle.generatedSkills.some((skill) => skill.name === "repo-research-analyst")).toBe(true)

    // Pi compatibility extension is included (with subagent + MCPorter tools)
    const compatExtension = bundle.extensions.find((extension) => extension.name === "compound-engineering-compat.ts")
    expect(compatExtension).toBeDefined()
    expect(compatExtension!.content).toContain('name: "subagent"')
    expect(compatExtension!.content).toContain('name: "mcporter_call"')
    expect(compatExtension!.content).toContain('multiSelect: Type.Optional(Type.Boolean')
    expect(compatExtension!.content).toContain('const multiSelect = params.multiSelect ?? false')

    // Claude MCP config is translated to MCPorter config
    expect(bundle.mcporterConfig?.mcpServers.context7?.baseUrl).toBe("https://mcp.context7.com/mcp")
    expect(bundle.mcporterConfig?.mcpServers["local-tooling"]?.command).toBe("echo")
  })

  test("transforms Task calls, AskUserQuestion, slash commands, and todo tool references", () => {
    const plugin: ClaudePlugin = {
      root: "/tmp/plugin",
      manifest: { name: "fixture", version: "1.0.0" },
      agents: [],
      commands: [
        {
          name: "workflows:plan",
          description: "Plan workflow",
          body: [
            "Run these in order:",
            "- Task repo-research-analyst(feature_description)",
            "- Task learnings-researcher(feature_description)",
            "Use AskUserQuestion tool for follow-up.",
            "Then use /workflows:work and /prompts:deepen-plan.",
            "Call the /deepen-plan command with the plan file path.",
            "Run `/workflows:work docs/plans/plan.md &` to continue remotely.",
            "Track progress with TodoWrite and TodoRead.",
          ].join("\n"),
          sourcePath: "/tmp/plugin/commands/plan.md",
        },
      ],
      skills: [],
      hooks: undefined,
      mcpServers: undefined,
    }

    const bundle = convertClaudeToPi(plugin, {
      agentMode: "subagent",
      inferTemperature: false,
      permissions: "none",
    })

    expect(bundle.prompts).toHaveLength(1)
    const parsedPrompt = parseFrontmatter(bundle.prompts[0].content)

    expect(parsedPrompt.body).toContain("Run subagent with agent=\"repo-research-analyst\" and task=\"feature_description\".")
    expect(parsedPrompt.body).toContain("Run subagent with agent=\"learnings-researcher\" and task=\"feature_description\".")
    expect(parsedPrompt.body).toContain("ask_user_question")
    expect(parsedPrompt.body).toContain("/workflows-work")
    expect(parsedPrompt.body).toContain("/deepen-plan")
    expect(parsedPrompt.body).toContain("Invoke `/deepen-plan` as a Pi prompt (never as a direct bash command)")
    expect(parsedPrompt.body).toContain('Run `pi --no-session -p "/workflows-work docs/plans/plan.md" &`')
    expect(parsedPrompt.body).toContain("Slash commands are Pi prompt templates, not shell executables")
    expect(parsedPrompt.body).toContain("file-based todos (todos/ + /skill:file-todos)")
  })

  test("normalizes skill names and transforms skill content for Pi", () => {
    const plugin: ClaudePlugin = {
      root: "/tmp/plugin",
      manifest: { name: "fixture", version: "1.0.0" },
      agents: [],
      commands: [],
      skills: [
        {
          name: "ce:plan",
          description: "Plan things",
          argumentHint: "[idea]",
          disableModelInvocation: undefined,
          body: [
            "Use AskUserQuestion for follow-up.",
            "- Task compound-engineering:research:repo-research-analyst(feature description)",
            "Then call /ce:work.",
            'Re-invoke with: Skill("compound-engineering:document-review", "mode:headless docs/plans/x.md")',
          ].join("\n"),
          frontmatter: {
            name: "ce:plan",
            description: "Plan things",
            "argument-hint": "[idea]",
          },
          sourceDir: "/tmp/plugin/skills/ce-plan",
          skillPath: "/tmp/plugin/skills/ce-plan/SKILL.md",
        },
      ],
      hooks: undefined,
      mcpServers: undefined,
    }

    const bundle = convertClaudeToPi(plugin, {
      agentMode: "subagent",
      inferTemperature: false,
      permissions: "none",
    })

    expect(bundle.skillDirs).toHaveLength(1)
    expect(bundle.skillDirs[0].name).toBe("ce-plan")

    const parsedSkill = parseFrontmatter(bundle.skillDirs[0].skillContent!)
    expect(parsedSkill.data.name).toBe("ce-plan")
    expect(parsedSkill.body).toContain("ask_user_question")
    expect(parsedSkill.body).toContain('Run subagent with agent="repo-research-analyst" and task="feature description".')
    expect(parsedSkill.body).toContain("/ce-work")
    expect(parsedSkill.body).toContain("`/skill:document-review mode:headless docs/plans/x.md`")
  })

  test("appends MCPorter compatibility note when command references MCP", () => {
    const plugin: ClaudePlugin = {
      root: "/tmp/plugin",
      manifest: { name: "fixture", version: "1.0.0" },
      agents: [],
      commands: [
        {
          name: "docs",
          description: "Read MCP docs",
          body: "Use MCP servers for docs lookup.",
          sourcePath: "/tmp/plugin/commands/docs.md",
        },
      ],
      skills: [],
      hooks: undefined,
      mcpServers: undefined,
    }

    const bundle = convertClaudeToPi(plugin, {
      agentMode: "subagent",
      inferTemperature: false,
      permissions: "none",
    })

    const parsedPrompt = parseFrontmatter(bundle.prompts[0].content)
    expect(parsedPrompt.body).toContain("Pi + MCPorter note")
    expect(parsedPrompt.body).toContain("mcporter_call")
  })
})
