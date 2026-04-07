import { describe, expect, test } from "bun:test"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { createCeTodo, listCeTodos } from "../src/ce-todos"

describe("ce-todos", () => {
  test("createCeTodo assigns unique issue ids under concurrent creation", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ce-todos-"))

    await Promise.all([
      createCeTodo(cwd, {
        title: "first finding",
        priority: "p1",
        problemStatement: "Problem one",
        findings: ["Finding one"],
        dedupe: false,
      }),
      createCeTodo(cwd, {
        title: "second finding",
        priority: "p1",
        problemStatement: "Problem two",
        findings: ["Finding two"],
        dedupe: false,
      }),
      createCeTodo(cwd, {
        title: "third finding",
        priority: "p2",
        problemStatement: "Problem three",
        findings: ["Finding three"],
        dedupe: false,
      }),
    ])

    const todos = await listCeTodos(cwd)
    expect(todos).toHaveLength(3)
    expect(todos.map((todo) => todo.issueId)).toEqual(["001", "002", "003"])
  })
})
