import { formatFrontmatter } from "../utils/frontmatter"
import { appendPiCompatibilityNoteIfNeeded, transformTextBodyForPi } from "../utils/pi-transform"
import type {
  ClaudeAgent,
  ClaudeCommand,
  ClaudeMcpServer,
  ClaudePlugin,
  ClaudeSkill,
} from "../types/claude"
import type {
  PiBundle,
  PiGeneratedSkill,
  PiMcporterConfig,
  PiMcporterServer,
  PiSkillDir,
} from "../types/pi"
import type { ClaudeToOpenCodeOptions } from "./claude-to-opencode"
import { PI_COMPAT_EXTENSION_SOURCE } from "../templates/pi/compat-extension"

export type ClaudeToPiOptions = ClaudeToOpenCodeOptions

const PI_DESCRIPTION_MAX_LENGTH = 1024

export function convertClaudeToPi(
  plugin: ClaudePlugin,
  _options: ClaudeToPiOptions,
): PiBundle {
  const promptNames = new Set<string>()
  const usedSkillNames = new Set<string>()

  const skillDirs = plugin.skills.map((skill) => convertSkill(skill, usedSkillNames))

  const prompts = plugin.commands
    .filter((command) => !command.disableModelInvocation)
    .map((command) => convertPrompt(command, promptNames))

  const generatedSkills = plugin.agents.map((agent) => convertAgent(agent, usedSkillNames))

  const extensions = [
    {
      name: "compound-engineering-compat.ts",
      content: PI_COMPAT_EXTENSION_SOURCE,
    },
  ]

  return {
    prompts,
    skillDirs,
    generatedSkills,
    extensions,
    mcporterConfig: plugin.mcpServers ? convertMcpToMcporter(plugin.mcpServers) : undefined,
  }
}

function convertPrompt(command: ClaudeCommand, usedNames: Set<string>) {
  const name = uniqueName(normalizeName(command.name), usedNames)
  const frontmatter: Record<string, unknown> = {
    description: command.description,
    "argument-hint": command.argumentHint,
  }

  let body = transformTextBodyForPi(command.body)
  body = appendPiCompatibilityNoteIfNeeded(body)

  return {
    name,
    content: formatFrontmatter(frontmatter, body.trim()),
  }
}

function convertSkill(skill: ClaudeSkill, usedNames: Set<string>): PiSkillDir {
  const name = uniqueName(normalizeName(skill.name), usedNames)
  const frontmatter = {
    ...skill.frontmatter,
    name,
  }
  let body = transformTextBodyForPi(skill.body)
  body = appendPiCompatibilityNoteIfNeeded(body)

  return {
    name,
    sourceDir: skill.sourceDir,
    skillContent: formatFrontmatter(frontmatter, body.trim()),
  }
}

function convertAgent(agent: ClaudeAgent, usedNames: Set<string>): PiGeneratedSkill {
  const name = uniqueName(normalizeName(agent.name), usedNames)
  const description = sanitizeDescription(
    agent.description ?? `Converted from Claude agent ${agent.name}`,
  )

  const frontmatter: Record<string, unknown> = {
    name,
    description,
  }

  const sections: string[] = []
  if (agent.capabilities && agent.capabilities.length > 0) {
    sections.push(`## Capabilities\n${agent.capabilities.map((capability) => `- ${capability}`).join("\n")}`)
  }

  const body = [
    ...sections,
    agent.body.trim().length > 0
      ? agent.body.trim()
      : `Instructions converted from the ${agent.name} agent.`,
  ].join("\n\n")

  return {
    name,
    content: formatFrontmatter(frontmatter, body),
  }
}

function convertMcpToMcporter(servers: Record<string, ClaudeMcpServer>): PiMcporterConfig {
  const mcpServers: Record<string, PiMcporterServer> = {}

  for (const [name, server] of Object.entries(servers)) {
    if (server.command) {
      mcpServers[name] = {
        command: server.command,
        args: server.args,
        env: server.env,
        headers: server.headers,
      }
      continue
    }

    if (server.url) {
      mcpServers[name] = {
        baseUrl: server.url,
        headers: server.headers,
      }
    }
  }

  return { mcpServers }
}

function normalizeName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "item"
  const normalized = trimmed
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[:\s]+/g, "-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized || "item"
}

function sanitizeDescription(value: string, maxLength = PI_DESCRIPTION_MAX_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  const ellipsis = "..."
  return normalized.slice(0, Math.max(0, maxLength - ellipsis.length)).trimEnd() + ellipsis
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let index = 2
  while (used.has(`${base}-${index}`)) {
    index += 1
  }
  const name = `${base}-${index}`
  used.add(name)
  return name
}
