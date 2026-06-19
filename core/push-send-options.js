// Pure push notification send options: high urgency for timely delivery on battery-conscious devices,
// 1800s TTL so undeliverable notifications don't linger and resurface stale.

export function pushSendOptions() {
  return {
    urgency: "high",
    TTL: 1800,
  }
}
