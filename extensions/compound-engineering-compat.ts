import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent"
import { matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui"
import { Type } from "@sinclair/typebox"

const MAX_BYTES = 50 * 1024
const DEFAULT_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_PARALLEL_SUBAGENTS = 8

type SubagentTask = {
  agent: string
  task: string
  cwd?: string
}

type SubagentResult = {
  agent: string
  task: string
  cwd: string
  exitCode: number
  output: string
  stderr: string
}

function truncate(value: string): string {
  const input = value ?? ""
  if (Buffer.byteLength(input, "utf8") <= MAX_BYTES) return input
  const head = input.slice(0, MAX_BYTES)
  return head + "\n\n[Output truncated to 50KB]"
}

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'"
}

function normalizeName(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function resolveBundledMcporterConfigPath(): string | undefined {
  try {
    const extensionDir = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.join(extensionDir, "..", "pi-resources", "compound-engineering", "mcporter.json"),
      path.join(extensionDir, "..", "compound-engineering", "mcporter.json"),
    ]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    // noop: bundled path is best-effort fallback
  }

  return undefined
}

function resolveMcporterConfigPath(cwd: string, explicit?: string): string | undefined {
  if (explicit && explicit.trim()) {
    return path.resolve(explicit)
  }

  const projectPath = path.join(cwd, ".pi", "compound-engineering", "mcporter.json")
  if (fs.existsSync(projectPath)) return projectPath

  const globalPath = path.join(os.homedir(), ".pi", "agent", "compound-engineering", "mcporter.json")
  if (fs.existsSync(globalPath)) return globalPath

  return resolveBundledMcporterConfigPath()
}

function resolveTaskCwd(baseCwd: string, taskCwd?: string): string {
  if (!taskCwd || !taskCwd.trim()) return baseCwd
  const expanded = taskCwd === "~"
    ? os.homedir()
    : taskCwd.startsWith("~" + path.sep)
      ? path.join(os.homedir(), taskCwd.slice(2))
      : taskCwd
  return path.resolve(baseCwd, expanded)
}

function hasInstalledPiSubagents(baseDir: string): boolean {
  const checkPaths = [
    path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents", "package.json"),
  ]

  try {
    const execPath = process.execPath
    if (execPath) {
      checkPaths.push(path.join(path.dirname(path.dirname(execPath)), "lib", "node_modules", "pi-subagents", "package.json"))
    }
  } catch {
    // ignore runtime environments without process metadata
  }

  const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json")
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { packages?: Array<string | { source?: string }> }
    for (const entry of settings.packages ?? []) {
      const source = typeof entry === "string" ? entry : entry.source
      if (source && /(^|[/:])pi-subagents($|[@/])/.test(source)) return true
    }
  } catch {
    // settings parsing is best-effort only
  }

  let current = path.resolve(baseDir)
  while (true) {
    checkPaths.push(path.join(current, ".pi", "npm", "node_modules", "pi-subagents", "package.json"))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  return checkPaths.some((candidate) => fs.existsSync(candidate))
}

async function runSingleSubagent(
  pi: ExtensionAPI,
  baseCwd: string,
  task: SubagentTask,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_SUBAGENT_TIMEOUT_MS,
): Promise<SubagentResult> {
  const agent = normalizeName(task.agent)
  if (!agent) {
    throw new Error("Subagent task is missing a valid agent name")
  }

  const taskText = String(task.task ?? "").trim()
  if (!taskText) {
    throw new Error("Subagent task for " + agent + " is empty")
  }

  const cwd = resolveTaskCwd(baseCwd, task.cwd)
  const prompt = "/skill:" + agent + " " + taskText
  const script = "cd " + shellEscape(cwd) + " && pi --no-session -p " + shellEscape(prompt)
  const result = await pi.exec("bash", ["-lc", script], { signal, timeout: timeoutMs })

  return {
    agent,
    task: taskText,
    cwd,
    exitCode: result.code,
    output: truncate(result.stdout || ""),
    stderr: truncate(result.stderr || ""),
  }
}

async function runParallelSubagents(
  pi: ExtensionAPI,
  baseCwd: string,
  tasks: SubagentTask[],
  signal?: AbortSignal,
  timeoutMs = DEFAULT_SUBAGENT_TIMEOUT_MS,
  maxConcurrency = 4,
  onProgress?: (completed: number, total: number) => void,
): Promise<SubagentResult[]> {
  const safeConcurrency = Math.max(1, Math.min(maxConcurrency, MAX_PARALLEL_SUBAGENTS, tasks.length))
  const results: SubagentResult[] = new Array(tasks.length)

  let nextIndex = 0
  let completed = 0

  const workers = Array.from({ length: safeConcurrency }, async () => {
    while (true) {
      const current = nextIndex
      nextIndex += 1
      if (current >= tasks.length) return

      results[current] = await runSingleSubagent(pi, baseCwd, tasks[current], signal, timeoutMs)
      completed += 1
      onProgress?.(completed, tasks.length)
    }
  })

  await Promise.all(workers)
  return results
}

function formatSubagentSummary(results: SubagentResult[]): string {
  if (results.length === 0) return "No subagent work was executed."

  const success = results.filter((result) => result.exitCode === 0).length
  const failed = results.length - success
  const header = failed === 0
    ? "Subagent run completed: " + success + "/" + results.length + " succeeded."
    : "Subagent run completed: " + success + "/" + results.length + " succeeded, " + failed + " failed."

  const lines = results.map((result) => {
    const status = result.exitCode === 0 ? "ok" : "error"
    const body = result.output || result.stderr || "(no output)"
    const preview = body.split("\n").slice(0, 6).join("\n")
    return "\n[" + status + "] " + result.agent + "\n" + preview
  })

  return header + lines.join("\n")
}

type MultiSelectPromptResult = {
  answers: string[]
  cancelled: boolean
}

class MultiSelectQuestionComponent {
  private cursorIndex = 0
  private selectedIndices = new Set<number>()
  private customAnswer: string | null = null
  private awaitingCustomAnswer = false
  private resolved = false
  private question: string
  private options: string[]
  private allowCustom: boolean
  private tui: TUI
  private theme: Theme
  private promptForCustomAnswer: () => Promise<string | null>
  private done: (result: MultiSelectPromptResult | null) => void

  constructor(
    question: string,
    options: string[],
    allowCustom: boolean,
    tui: TUI,
    theme: Theme,
    promptForCustomAnswer: () => Promise<string | null>,
    done: (result: MultiSelectPromptResult | null) => void,
  ) {
    this.question = question
    this.options = options
    this.allowCustom = allowCustom
    this.tui = tui
    this.theme = theme
    this.promptForCustomAnswer = promptForCustomAnswer
    this.done = done
  }

  invalidate(): void {}

  private get customIndex(): number {
    return this.allowCustom ? this.options.length : -1
  }

  private get doneIndex(): number {
    return this.options.length + (this.allowCustom ? 1 : 0)
  }

  private finish(result: MultiSelectPromptResult | null): void {
    if (this.resolved) return
    this.resolved = true
    this.done(result)
  }

  private getAnswers(): string[] {
    const selected = Array.from(this.selectedIndices)
      .sort((a, b) => a - b)
      .map((index) => this.options[index])
      .filter((value): value is string => Boolean(value))

    return this.customAnswer ? [...selected, this.customAnswer] : selected
  }

  private async editCustomAnswer(): Promise<void> {
    if (this.awaitingCustomAnswer) return

    this.awaitingCustomAnswer = true
    this.tui.requestRender()

    try {
      const custom = await this.promptForCustomAnswer()
      if (custom && custom.trim()) {
        this.customAnswer = custom.trim()
      }
    } finally {
      this.awaitingCustomAnswer = false
      this.tui.requestRender()
    }
  }

  handleInput(data: string): void {
    if (this.awaitingCustomAnswer) return

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.finish(null)
      return
    }

    if (matchesKey(data, "up")) {
      this.cursorIndex = Math.max(0, this.cursorIndex - 1)
      this.tui.requestRender()
      return
    }

    if (matchesKey(data, "down")) {
      this.cursorIndex = Math.min(this.doneIndex, this.cursorIndex + 1)
      this.tui.requestRender()
      return
    }

    if ((matchesKey(data, "backspace") || matchesKey(data, "delete")) && this.allowCustom && this.cursorIndex === this.customIndex) {
      this.customAnswer = null
      this.tui.requestRender()
      return
    }

    const onRegularOption = this.cursorIndex < this.options.length
    const onCustomOption = this.allowCustom && this.cursorIndex === this.customIndex
    const onDone = this.cursorIndex === this.doneIndex

    if (matchesKey(data, "space") && onRegularOption) {
      if (this.selectedIndices.has(this.cursorIndex)) {
        this.selectedIndices.delete(this.cursorIndex)
      } else {
        this.selectedIndices.add(this.cursorIndex)
      }
      this.tui.requestRender()
      return
    }

    if (!matchesKey(data, "return")) return

    if (onRegularOption) {
      if (this.selectedIndices.has(this.cursorIndex)) {
        this.selectedIndices.delete(this.cursorIndex)
      } else {
        this.selectedIndices.add(this.cursorIndex)
      }
      this.tui.requestRender()
      return
    }

    if (onCustomOption) {
      void this.editCustomAnswer()
      return
    }

    if (!onDone) return

    const answers = this.getAnswers()
    if (answers.length === 0) {
      this.tui.requestRender()
      return
    }

    this.finish({ answers, cancelled: false })
  }

  render(width: number): string[] {
    const innerWidth = Math.max(38, Math.min(width, 100) - 2)
    const pad = (line: string) => line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)))
    const row = (line = "") => this.theme.fg("border", "│") + pad(truncateToWidth(line, innerWidth)) + this.theme.fg("border", "│")
    const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)]

    for (const wrapped of wrapTextWithAnsi(this.theme.bold(this.question), innerWidth - 1)) {
      lines.push(row(` ${wrapped}`))
    }

    lines.push(row())

    this.options.forEach((option, index) => {
      const selected = this.selectedIndices.has(index)
      const cursor = this.cursorIndex === index ? this.theme.fg("accent", "→") : " "
      const checkbox = selected ? this.theme.fg("success", "[✓]") : "[ ]"
      const label = selected ? this.theme.fg("success", option) : option
      lines.push(row(` ${cursor} ${checkbox} ${label}`))
    })

    if (this.allowCustom) {
      const hasCustomAnswer = Boolean(this.customAnswer)
      const cursor = this.cursorIndex === this.customIndex ? this.theme.fg("accent", "→") : " "
      const checkbox = hasCustomAnswer ? this.theme.fg("success", "[✓]") : "[ ]"
      const label = hasCustomAnswer
        ? this.theme.fg("success", `Other: ${this.customAnswer}`)
        : "Other (type custom answer)"
      lines.push(row(` ${cursor} ${checkbox} ${label}`))
    }

    const doneCursor = this.cursorIndex === this.doneIndex ? this.theme.fg("accent", "→") : " "
    const answerCount = this.getAnswers().length
    const doneLabel = answerCount > 0 ? `Done (${answerCount} selected)` : "Done"
    lines.push(row(` ${doneCursor} ${this.theme.bold(doneLabel)}`))
    lines.push(row())

    const statusLine = this.awaitingCustomAnswer
      ? "Waiting for custom answer…"
      : "↑↓ navigate • Space toggle • Enter toggle/open/done • Del clears custom • Esc cancel"
    lines.push(row(` ${this.theme.fg("dim", statusLine)}`))
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`))
    return lines
  }
}

async function askMultiSelectQuestion(
  ctx: ExtensionContext,
  question: string,
  options: string[],
  allowCustom: boolean,
): Promise<MultiSelectPromptResult | null> {
  return ctx.ui.custom<MultiSelectPromptResult | null>((tui, theme, _kb, done) => {
    return new MultiSelectQuestionComponent(
      question,
      options,
      allowCustom,
      tui,
      theme,
      async () => {
        const answer = await ctx.ui.input("Your answer")
        return answer?.trim() ? answer.trim() : null
      },
      done,
    )
  }, { overlay: true })
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: "Ask the user a question with optional choices. Supports single-select and multi-select.",
    parameters: Type.Object({
      question: Type.String({ description: "Question shown to the user" }),
      options: Type.Optional(Type.Array(Type.String(), { description: "Selectable options" })),
      allowCustom: Type.Optional(Type.Boolean({ default: true })),
      multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options before confirming", default: false })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          isError: true,
          content: [{ type: "text", text: "UI is unavailable in this mode." }],
          details: {},
        }
      }

      const options = params.options ?? []
      const allowCustom = params.allowCustom ?? true
      const multiSelect = params.multiSelect ?? false

      if (options.length === 0) {
        const answer = await ctx.ui.input(params.question)
        if (!answer) {
          return {
            content: [{ type: "text", text: "User cancelled." }],
            details: { answer: null },
          }
        }

        return {
          content: [{ type: "text", text: "User answered: " + answer }],
          details: { answer, mode: "input" },
        }
      }

      if (multiSelect) {
        const result = await askMultiSelectQuestion(ctx, params.question, options, allowCustom)
        if (!result || result.cancelled) {
          return {
            content: [{ type: "text", text: "User cancelled." }],
            details: { answer: null, answers: [], mode: "multi-select" },
          }
        }

        const answer = result.answers.join(", ")
        return {
          content: [{ type: "text", text: "User selected: " + answer }],
          details: { answer, answers: result.answers, mode: "multi-select" },
        }
      }

      const customLabel = "Other (type custom answer)"
      const selectable = allowCustom ? [...options, customLabel] : options
      const selected = await ctx.ui.select(params.question, selectable)

      if (!selected) {
        return {
          content: [{ type: "text", text: "User cancelled." }],
          details: { answer: null },
        }
      }

      if (selected === customLabel) {
        const custom = await ctx.ui.input("Your answer")
        if (!custom) {
          return {
            content: [{ type: "text", text: "User cancelled." }],
            details: { answer: null },
          }
        }

        return {
          content: [{ type: "text", text: "User answered: " + custom }],
          details: { answer: custom, mode: "custom" },
        }
      }

      return {
        content: [{ type: "text", text: "User selected: " + selected }],
        details: { answer: selected, mode: "select" },
      }
    },
  })

  const subagentTaskSchema = Type.Object({
    agent: Type.String({ description: "Skill/agent name to invoke" }),
    task: Type.String({ description: "Task instructions for that skill" }),
    cwd: Type.Optional(Type.String({ description: "Optional working directory for this task" })),
  })

  if (!hasInstalledPiSubagents(process.cwd())) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: "Run one or more skill-based subagent tasks. Supports single, parallel, and chained execution.",
      parameters: Type.Object({
        agent: Type.Optional(Type.String({ description: "Single subagent name" })),
        task: Type.Optional(Type.String({ description: "Single subagent task" })),
        cwd: Type.Optional(Type.String({ description: "Working directory for single mode" })),
        tasks: Type.Optional(Type.Array(subagentTaskSchema, { description: "Parallel subagent tasks" })),
        chain: Type.Optional(Type.Array(subagentTaskSchema, { description: "Sequential tasks; supports {previous} placeholder" })),
        maxConcurrency: Type.Optional(Type.Number({ default: 4 })),
        timeoutMs: Type.Optional(Type.Number({ default: DEFAULT_SUBAGENT_TIMEOUT_MS })),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const hasSingle = Boolean(params.agent && params.task)
      const hasTasks = Boolean(params.tasks && params.tasks.length > 0)
      const hasChain = Boolean(params.chain && params.chain.length > 0)
      const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain)

      if (modeCount !== 1) {
        return {
          isError: true,
          content: [{ type: "text", text: "Provide exactly one mode: single (agent+task), tasks, or chain." }],
          details: {},
        }
      }

      const timeoutMs = Number(params.timeoutMs || DEFAULT_SUBAGENT_TIMEOUT_MS)

      try {
        if (hasSingle) {
          const result = await runSingleSubagent(
            pi,
            ctx.cwd,
            { agent: params.agent!, task: params.task!, cwd: params.cwd },
            signal,
            timeoutMs,
          )

          const body = formatSubagentSummary([result])
          return {
            isError: result.exitCode !== 0,
            content: [{ type: "text", text: body }],
            details: { mode: "single", results: [result] },
          }
        }

        if (hasTasks) {
          const tasks = params.tasks as SubagentTask[]
          const maxConcurrency = Number(params.maxConcurrency || 4)

          const results = await runParallelSubagents(
            pi,
            ctx.cwd,
            tasks,
            signal,
            timeoutMs,
            maxConcurrency,
            (completed, total) => {
              onUpdate?.({
                content: [{ type: "text", text: "Subagent progress: " + completed + "/" + total }],
                details: { mode: "parallel", completed, total },
              })
            },
          )

          const body = formatSubagentSummary(results)
          const hasFailure = results.some((result) => result.exitCode !== 0)

          return {
            isError: hasFailure,
            content: [{ type: "text", text: body }],
            details: { mode: "parallel", results },
          }
        }

        const chain = params.chain as SubagentTask[]
        const results: SubagentResult[] = []
        let previous = ""

        for (const step of chain) {
          const resolvedTask = step.task.replace(/\{previous\}/g, previous)
          const result = await runSingleSubagent(
            pi,
            ctx.cwd,
            { agent: step.agent, task: resolvedTask, cwd: step.cwd },
            signal,
            timeoutMs,
          )
          results.push(result)
          previous = result.output || result.stderr

          onUpdate?.({
            content: [{ type: "text", text: "Subagent chain progress: " + results.length + "/" + chain.length }],
            details: { mode: "chain", completed: results.length, total: chain.length },
          })

          if (result.exitCode !== 0) break
        }

        const body = formatSubagentSummary(results)
        const hasFailure = results.some((result) => result.exitCode !== 0)

        return {
          isError: hasFailure,
          content: [{ type: "text", text: body }],
          details: { mode: "chain", results },
        }
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
        }
      }
    },
    })
  }

  pi.registerTool({
    name: "mcporter_list",
    label: "MCPorter List",
    description: "List tools on an MCP server through MCPorter.",
    parameters: Type.Object({
      server: Type.String({ description: "Configured MCP server name" }),
      allParameters: Type.Optional(Type.Boolean({ default: false })),
      json: Type.Optional(Type.Boolean({ default: true })),
      configPath: Type.Optional(Type.String({ description: "Optional mcporter config path" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["list", params.server]
      if (params.allParameters) args.push("--all-parameters")
      if (params.json ?? true) args.push("--json")

      const configPath = resolveMcporterConfigPath(ctx.cwd, params.configPath)
      if (configPath) {
        args.push("--config", configPath)
      }

      const result = await pi.exec("mcporter", args, { signal })
      const output = truncate(result.stdout || result.stderr || "")

      return {
        isError: result.code !== 0,
        content: [{ type: "text", text: output || "(no output)" }],
        details: {
          exitCode: result.code,
          command: "mcporter " + args.join(" "),
          configPath,
        },
      }
    },
  })

  pi.registerTool({
    name: "mcporter_call",
    label: "MCPorter Call",
    description: "Call a specific MCP tool through MCPorter.",
    parameters: Type.Object({
      call: Type.Optional(Type.String({ description: "Function-style call, e.g. linear.list_issues(limit: 5)" })),
      server: Type.Optional(Type.String({ description: "Server name (if call is omitted)" })),
      tool: Type.Optional(Type.String({ description: "Tool name (if call is omitted)" })),
      args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "JSON arguments object" })),
      configPath: Type.Optional(Type.String({ description: "Optional mcporter config path" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const args = ["call"]

      if (params.call && params.call.trim()) {
        args.push(params.call.trim())
      } else {
        if (!params.server || !params.tool) {
          return {
            isError: true,
            content: [{ type: "text", text: "Provide either call, or server + tool." }],
            details: {},
          }
        }
        args.push(params.server + "." + params.tool)
        if (params.args) {
          args.push("--args", JSON.stringify(params.args))
        }
      }

      args.push("--output", "json")

      const configPath = resolveMcporterConfigPath(ctx.cwd, params.configPath)
      if (configPath) {
        args.push("--config", configPath)
      }

      const result = await pi.exec("mcporter", args, { signal })
      const output = truncate(result.stdout || result.stderr || "")

      return {
        isError: result.code !== 0,
        content: [{ type: "text", text: output || "(no output)" }],
        details: {
          exitCode: result.code,
          command: "mcporter " + args.join(" "),
          configPath,
        },
      }
    },
  })
}

