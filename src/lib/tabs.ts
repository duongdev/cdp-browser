export interface Tab {
  id: string;
  title: string;
  url: string;
  faviconUrl?: string;
  type: string;
}

/**
 * The stable-ordering rule: tab order is owned locally, not by the Remote Browser
 * (CDP's `/json` reorders by activity — we ignore that). Tabs keep their current
 * order; tabs gone from the Remote Browser drop out; newly-seen tabs append at the end.
 */
export function reconcile(order: string[], remoteTabs: Tab[]): Tab[] {
  const byId = new Map(remoteTabs.map((t) => [t.id, t]));
  const kept = order.filter((id) => byId.has(id));
  const keptSet = new Set(kept);
  for (const t of remoteTabs) {
    if (!keptSet.has(t.id)) kept.push(t.id);
  }
  return kept.map((id) => byId.get(id)!);
}

export function nextTab(tabs: Tab[], activeId: string | null): string {
  const i = tabs.findIndex((t) => t.id === activeId);
  return tabs[(i + 1) % tabs.length].id;
}

export function prevTab(tabs: Tab[], activeId: string | null): string {
  const i = tabs.findIndex((t) => t.id === activeId);
  return tabs[(i - 1 + tabs.length) % tabs.length].id;
}

export interface ClosedTabStack {
  push(url: string): void;
  popLast(): string | undefined;
}

/** Tracks closed tab urls so the most recently closed can be reopened (Cmd+Shift+T). */
export function createClosedTabStack(): ClosedTabStack {
  const urls: string[] = [];
  return {
    push: (url) => void urls.push(url),
    popLast: () => urls.pop(),
  };
}
