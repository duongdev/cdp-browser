// Phone Shell gate (t076, ADR-0012). The shell is a *layout* decision keyed on
// viewport width only — never pointer-coarseness (an iPad is coarse but wide) and
// never a caps flag (caps gate build capabilities, not layout).

export type ShellMode = "phone" | "wide"

// Below this width the app runs the Phone Shell (Inbox-rooted). Matches the
// matchMedia query in use-shell-mode.ts: (max-width: 767px).
export const PHONE_SHELL_MAX_WIDTH = 767

export function shellModeFor(width: number): ShellMode {
  return width <= PHONE_SHELL_MAX_WIDTH ? "phone" : "wide"
}

// The Phone Shell never resizes the Remote Page: a ~390px override would break
// non-responsive sites (Slack) and the override mutates the Remote Browser globally
// (ADR-0002). The screencast renders fit-to-screen instead; zooming is local (t079).
export function shouldApplyAdaptive(setting: boolean, mode: ShellMode): boolean {
  return setting && mode !== "phone"
}
