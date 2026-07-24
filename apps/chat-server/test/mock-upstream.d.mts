// Types for the plain-Node mock-upstream harness (mock-upstream.mjs is JS-with-JSDoc by design,
// mirroring the test/e2e/ harness style — see PSN-93 WS-B).
import type { MockProvider } from "../src/providers/mock-provider.ts"

export interface MockUpstream {
  url: string
  secret: string
  provider: MockProvider
  close(): Promise<void>
}

export function startMockUpstream(opts?: {
  secret?: string
  provider?: MockProvider
}): Promise<MockUpstream>
