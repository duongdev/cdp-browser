export const NOTIFICATION_FALLBACK_TAG = "cdp-fallback"

export type PushNotificationOptions = NotificationOptions & { data?: unknown; timestamp?: number }

export interface PushNotificationContent {
  title: string
  options: PushNotificationOptions
}

export function buildNotificationContent(data: any): PushNotificationContent {
  if (!data || typeof data !== "object") {
    return {
      title: "New message",
      options: {
        body: "",
        badge: "/icons/icon-192.png",
        tag: NOTIFICATION_FALLBACK_TAG,
        data: {},
      },
    }
  }

  const title = data.title || "CDP Browser"
  const options: PushNotificationOptions = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.id || undefined,
    timestamp: data.ts || Date.now(),
    data: data,
  }

  return { title, options }
}
