import webpush from "web-push";
import { Redis } from "@upstash/redis";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

const SUBSCRIPTIONS_KEY = "xau_push_subscriptions";
const LEGACY_KEY = "xau_push_subscription";

function parseSubscription(value) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

export async function saveSubscription(subscription) {
  if (!subscription?.endpoint) throw new Error("Invalid subscription");
  await redis.sadd(SUBSCRIPTIONS_KEY, JSON.stringify(subscription));
  await redis.set(LEGACY_KEY, JSON.stringify(subscription));
}

export async function getSubscriptions() {
  const raw = await redis.smembers(SUBSCRIPTIONS_KEY);
  const list = (raw || []).map(parseSubscription).filter(x => x?.endpoint);

  // Automatically migrate the old single-subscription key.
  if (!list.length) {
    const legacy = parseSubscription(await redis.get(LEGACY_KEY));
    if (legacy?.endpoint) {
      await saveSubscription(legacy);
      return [legacy];
    }
  }

  return list;
}

export async function sendPushToAll(payload) {
  const subscriptions = await getSubscriptions();
  if (!subscriptions.length) return { sent: 0, removed: 0, total: 0 };

  let sent = 0;
  let removed = 0;

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({
          title: payload.title,
          body: payload.body,
          icon: payload.icon || "/icon.png",
          badge: payload.badge || "/icon.png",
          tag: payload.tag || "xau-signal",
          data: { url: payload.url || "/" }
        })
      );
      sent++;
    } catch (error) {
      // 404/410 = expired/removed browser subscription.
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await redis.srem(SUBSCRIPTIONS_KEY, JSON.stringify(subscription));
        removed++;
      } else {
        console.error("Push delivery error:", error?.message || error);
      }
    }
  }

  return { sent, removed, total: subscriptions.length };
}

export { redis };
