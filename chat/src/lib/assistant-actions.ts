// Pure prompt-seed builders for the assistant quick actions (t176). Each action is a canned user
// prompt riding the normal session model — visible in history, compactable, no hidden
// side-channel call. Draft tone guidance is the user-editable `voice` blob from the BFF prefs
// (DB-stored, never committed — OSS boundary); empty = no extra guidance.

export function summarizePrompt(convTitle: string): string {
  return `Summarize the conversation "${convTitle}" I attached: the key points, decisions, and any open questions. Cite the key messages.`
}

export function catchUpPrompt(): string {
  return "What did I miss? Use get_unread_overview, then give me a short digest grouped by conversation — who said what, what needs my attention first. Cite messages."
}

export function draftReplyPrompt(voice: string): string {
  const guidance = voice.trim() ? `\nTone guidance: ${voice.trim()}` : ""
  return `Draft a reply to the message I attached. Match the thread's dominant language (mirror Vietnamese with Vietnamese) and its register. Give ONLY the reply text, no preamble.${guidance}`
}

export function actionItemsPrompt(): string {
  return "Scan my recent messages and mentions for asks, tasks, and deadlines directed at me. Return a short cited checklist. If there are none, say so plainly."
}
