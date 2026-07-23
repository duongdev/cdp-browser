import { describe, expect, it } from "vitest"
import { formatBodyNames } from "./body-names"

const FIRST = { mode: "first" as const }
const FULL = { mode: "full" as const }

describe("formatBodyNames", () => {
  it("shortens a mention pill and stamps data-fullname", () => {
    const out = formatBodyNames(
      '<span class="mention">@Glory Nguyen - Group Office [C]</span>',
      FIRST,
    )
    expect(out).toContain(">@Glory</span>")
    expect(out).toContain('data-fullname="Glory Nguyen - Group Office [C]"')
  })

  it("shortens a reply-quote author and keeps its other attrs", () => {
    const out = formatBodyNames(
      '<strong itemprop="mri" itemid="8:orgid:abc">Careen Tan - Group Office</strong>',
      FIRST,
    )
    expect(out).toContain(">Careen</strong>")
    expect(out).toContain('itemprop="mri"')
    expect(out).toContain('itemid="8:orgid:abc"')
    expect(out).toContain('data-fullname="Careen Tan - Group Office"')
  })

  it("leaves the body byte-identical when the preference shortens nothing", () => {
    const body = '<span class="mention">@Bob</span> hi <strong itemprop="mri">Bob</strong>'
    expect(formatBodyNames(body, FULL)).toBe(body)
    expect(formatBodyNames(body, FIRST)).toBe(body)
  })

  it("preserves the mention-self class and re-escapes the name", () => {
    const out = formatBodyNames(
      '<span class="mention mention-self">@A &amp; B - Group Office</span>',
      FIRST,
    )
    expect(out).toContain('class="mention mention-self"')
    expect(out).toContain(">@A</span>")
  })

  it("ignores a non-mri strong (not a quote author)", () => {
    const body = "<strong>Bold text - Group Office</strong>"
    expect(formatBodyNames(body, FIRST)).toBe(body)
  })
})
