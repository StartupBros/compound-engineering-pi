import path from "path"
import { formatFrontmatter, parseFrontmatter } from "./frontmatter"

export function transformTextBodyForPi(body: string): string {
  let result = body

  // Task repo-research-analyst(feature_description)
  // Task compound-engineering:research:repo-research-analyst(feature_description)
  // -> Run subagent with agent="repo-research-analyst" and task="feature_description"
  const taskPattern = /^(\s*-?\s*)Task\s+([a-z][a-z0-9:_-]*)\(([^)]*)\)/gm
  result = result.replace(taskPattern, (_match, prefix: string, agentName: string, args: string) => {
    const bareAgentName = agentName.split(":").pop() ?? agentName
    const skillName = normalizePiName(bareAgentName)
    const trimmedArgs = args.trim().replace(/\s+/g, " ")
    return `${prefix}Run subagent with agent=\"${skillName}\" and task=\"${trimmedArgs}\".`
  })

  const skillInvocationPattern = /Skill\("([^"]+)",\s*"([^"]*)"\)/g
  result = result.replace(skillInvocationPattern, (_match, skillName: string, args: string) => {
    const bareSkillName = skillName.split(":").pop() ?? skillName
    const normalizedSkillName = normalizePiName(bareSkillName)
    const prompt = args.trim().length > 0
      ? `/skill:${normalizedSkillName} ${args.trim()}`
      : `/skill:${normalizedSkillName}`
    return `\`${prompt}\``
  })

  result = result.replace(/\bAskUserQuestion\b/g, "ask_user_question")
  result = result.replace(/\bTodoWrite\b/g, "file-based todos (todos/ + /skill:file-todos)")
  result = result.replace(/\bTodoRead\b/g, "file-based todos (todos/ + /skill:file-todos)")

  const slashCommandPattern = /(?<![:\w])\/([a-z][a-z0-9_:-]*?)(?=[\s,."')\]}`]|$)/gi
  result = result.replace(slashCommandPattern, (match, commandName: string) => {
    if (commandName.includes("/")) return match
    if (["dev", "tmp", "etc", "usr", "var", "bin", "home"].includes(commandName)) {
      return match
    }

    if (commandName.startsWith("skill:")) {
      const skillName = commandName.slice("skill:".length)
      return `/skill:${normalizePiName(skillName)}`
    }

    const withoutPrefix = commandName.startsWith("prompts:")
      ? commandName.slice("prompts:".length)
      : commandName

    return `/${normalizePiName(withoutPrefix)}`
  })

  result = rewriteSlashCommandExecutionForPi(result)

  return result
}

export function appendPiCompatibilityNoteIfNeeded(body: string): string {
  if (!/\bmcp\b/i.test(body)) return body

  const note = [
    "",
    "## Pi + MCPorter note",
    "For MCP access in Pi, use MCPorter via the generated tools:",
    "- `mcporter_list` to inspect available MCP tools",
    "- `mcporter_call` to invoke a tool",
    "",
  ].join("\n")

  return body + note
}

export function transformMarkdownDocumentForPi(raw: string): string {
  const { data, body } = parseFrontmatter(raw)
  let transformedBody = transformTextBodyForPi(body)
  transformedBody = appendPiCompatibilityNoteIfNeeded(transformedBody)

  if (Object.keys(data).length === 0) {
    return transformedBody
  }

  return formatFrontmatter(data, transformedBody.trim())
}

export function shouldTransformSkillMarkdownFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".md"
}

function rewriteSlashCommandExecutionForPi(body: string): string {
  let result = body

  result = result.replace(/Call the \/([a-z][a-z0-9_-]*) command/gi, (_match, commandName: string) => {
    return `Invoke \`/${commandName}\` as a Pi prompt (never as a direct bash command)`
  })

  result = result.replace(/Run `\/([a-z][a-z0-9_-]*)([^`]*)`/gi, (_match, commandName: string, rawArgs: string) => {
    let args = (rawArgs ?? "").trim()
    let backgroundSuffix = ""

    if (args.endsWith("&")) {
      args = args.slice(0, -1).trimEnd()
      backgroundSuffix = " &"
    }

    const prompt = args.length > 0 ? `/${commandName} ${args}` : `/${commandName}`
    const escapedPrompt = prompt.replace(/"/g, '\\"')
    return `Run \`pi --no-session -p "${escapedPrompt}"${backgroundSuffix}\``
  })

  if (result !== body && !result.includes("Slash commands are Pi prompt templates")) {
    result += "\n\n**Important:** Slash commands are Pi prompt templates, not shell executables. Never run `/...` directly via bash."
  }

  return result
}

function normalizePiName(value: string): string {
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
