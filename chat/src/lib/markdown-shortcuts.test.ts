import { describe, expect, it } from "vitest"
import { matchBlockShortcut, matchInlineShortcut } from "./markdown-shortcuts"

describe("matchInlineShortcut", () => {
  it("matches bold before italic", () => {
    expect(matchInlineShortcut("**hi**")).toEqual({
      start: 0,
      raw: "**hi**",
      tag: "b",
      inner: "hi",
    })
  })
  it("matches italic with *", () => {
    expect(matchInlineShortcut("say *hi*")).toEqual({
      start: 4,
      raw: "*hi*",
      tag: "i",
      inner: "hi",
    })
  })
  it("matches italic with _ at a word boundary", () => {
    expect(matchInlineShortcut("a _hi_")).toEqual({ start: 2, raw: "_hi_", tag: "i", inner: "hi" })
  })
  it("does not convert snake_case", () => {
    expect(matchInlineShortcut("foo_bar_")).toBeNull()
  })
  it("matches strike", () => {
    expect(matchInlineShortcut("~~no~~")).toEqual({
      start: 0,
      raw: "~~no~~",
      tag: "s",
      inner: "no",
    })
  })
  it("matches inline code and suppresses other markers inside", () => {
    expect(matchInlineShortcut("`a*b*`")).toEqual({
      start: 0,
      raw: "`a*b*`",
      tag: "code",
      inner: "a*b*",
    })
  })
  it("does not fire italic on a half-typed bold", () => {
    expect(matchInlineShortcut("**bold*")).toBeNull()
  })
  it("returns null with no closing marker", () => {
    expect(matchInlineShortcut("**hi")).toBeNull()
    expect(matchInlineShortcut("plain text")).toBeNull()
  })
  it("ignores an empty/whitespace span", () => {
    expect(matchInlineShortcut("** **")).toBeNull()
    expect(matchInlineShortcut("``")).toBeNull()
  })
  it("only takes the span nearest the caret", () => {
    expect(matchInlineShortcut("**a** and **b**")).toEqual({
      start: 10,
      raw: "**b**",
      tag: "b",
      inner: "b",
    })
  })
})

describe("matchBlockShortcut", () => {
  it("matches a quote prefix", () => {
    expect(matchBlockShortcut("> ")).toEqual({ kind: "quote", raw: "> " })
  })
  it("matches bullet prefixes", () => {
    expect(matchBlockShortcut("- ")).toEqual({ kind: "ul", raw: "- " })
    expect(matchBlockShortcut("* ")).toEqual({ kind: "ul", raw: "* " })
  })
  it("matches a numbered prefix", () => {
    expect(matchBlockShortcut("1. ")).toEqual({ kind: "ol", raw: "1. " })
    expect(matchBlockShortcut("42. ")).toEqual({ kind: "ol", raw: "42. " })
  })
  it("matches a code fence", () => {
    expect(matchBlockShortcut("```")).toEqual({ kind: "code", raw: "```" })
  })
  it("does not trigger mid-line", () => {
    expect(matchBlockShortcut("text - ")).toBeNull()
    expect(matchBlockShortcut("done 1. ")).toBeNull()
    expect(matchBlockShortcut("")).toBeNull()
  })
})
