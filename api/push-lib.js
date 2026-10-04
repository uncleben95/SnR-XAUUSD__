import webpush from "web-push";
import { Redis } from "@upstash/redis";

/* =========================================================
   VAPID CONFIG
========================================================= */

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/* =========================================================
   REDIS
========================================================= */

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN
});

/* =========================================================
   KEYS
========================================================= */

const SUBSCRIPTIONS_KEY = "xau_push_subscriptions";
const LEGACY_KEY = "xau_push_subscription";

const MAX_SUBSCRIPTION_BYTES = 16_384;

/* =========================================================
   HELPERS
========================================================= */

function parseSubscription(value) {
  if (!value) return null;

  try {
    return typeof value === "string"
      ? JSON.parse(value)
      : value;
  } catch {
    return null;
  }
}

function normalizeSubscription(subscription) {
  if (!subscription?.endpoint) return null;

  if (typeof subscription.endpoint !== "string" || subscription.endpoint.length > 4096) {
    return null;
  }

  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: subscription.keys?.p256dh,
      auth: subscription.keys?.auth
    }
  };
}

/* =========================================================
   SAVE SUBSCRIPTION
========================================================= */

export async function saveSubscription(subscription) {
  const rawSize = Buffer.byteLength(JSON.stringify(subscription ?? {}), "utf8");
  if (rawSize > MAX_SUBSCRIPTION_BYTES) {
    throw new Error("Push subscription payload terlalu besar");
  }

  const normalized = normalizeSubscription(subscription);

  if (
    !normalized?.endpoint ||
    !normalized?.keys?.p256dh ||
    !normalized?.keys?.auth
  ) {
    throw new Error("Invalid push subscription");
  }

  const value = JSON.stringify(normalized);

  await redis.sadd(
    SUBSCRIPTIONS_KEY,
    value
  );

  // Keep legacy key for compatibility.
  await redis.set(
    LEGACY_KEY,
    value
  );

  return {
    ok: true,
    endpoint: normalized.endpoint
  };
}

/* =========================================================
   GET ALL SUBSCRIPTIONS
========================================================= */

export async function getSubscriptions() {
  let raw = [];

  try {
    raw = await redis.smembers(SUBSCRIPTIONS_KEY);
  } catch (error) {
    console.error(
      "Redis subscription read error:",
      error?.message || error
    );
  }

  let subscriptions = (raw || [])
    .map(parseSubscription)
    .map(normalizeSubscription)
    .filter(
      subscription =>
        subscription?.endpoint &&
        subscription?.keys?.p256dh &&
        subscription?.keys?.auth
    );

  /* -------------------------------------------------------
     LEGACY FALLBACK
  ------------------------------------------------------- */

  if (!subscriptions.length) {
    try {
      const legacyRaw = await redis.get(LEGACY_KEY);
      const legacy = normalizeSubscription(
        parseSubscription(legacyRaw)
      );

      if (
        legacy?.endpoint &&
        legacy?.keys?.p256dh &&
        legacy?.keys?.auth
      ) {
        try {
          await redis.sadd(
            SUBSCRIPTIONS_KEY,
            JSON.stringify(legacy)
          );
        } catch (error) {
          console.error(
            "Legacy subscription migration error:",
            error?.message || error
          );
        }

        subscriptions = [legacy];
      }
    } catch (error) {
      console.error(
        "Legacy subscription read error:",
        error?.message || error
      );
    }
  }

  return subscriptions;
}

/* =========================================================
   SEND PUSH TO ALL SUBSCRIPTIONS
========================================================= */

export async function sendPushToAll(payload) {
  const subscriptions = await getSubscriptions();

  if (!subscriptions.length) {
    console.log(
      "Push: no subscriptions found"
    );

    return {
      sent: 0,
      removed: 0,
      failed: 0,
      total: 0,
      details: []
    };
  }

  let sent = 0;
  let removed = 0;
  let failed = 0;

  const details = [];

  for (const subscription of subscriptions) {
    const endpoint = subscription.endpoint;

    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({
          title: payload?.title || "XAU/USD Signal",
          body: payload?.body || "",
          icon: payload?.icon || "/icon.png",
          badge: payload?.badge || "/icon.png",
          tag: payload?.tag || "xau-signal",
          data: {
            url: payload?.url || "/"
          }
        })
      );

      sent++;

      details.push({
        endpoint: endpoint
          ? endpoint.slice(0, 80)
          : null,
        status: "SENT"
      });

      console.log(
        "Push sent:",
        endpoint?.slice(0, 80)
      );

    } catch (error) {
      const statusCode = error?.statusCode;

      /* ---------------------------------------------------
         EXPIRED / INVALID SUBSCRIPTION
         404 / 410
      --------------------------------------------------- */

      if (
        statusCode === 404 ||
        statusCode === 410
      ) {
        try {
          await redis.srem(
            SUBSCRIPTIONS_KEY,
            JSON.stringify(subscription)
          );
        } catch (redisError) {
          console.error(
            "Failed removing expired subscription:",
            redisError?.message || redisError
          );
        }

        removed++;

        details.push({
          endpoint: endpoint
            ? endpoint.slice(0, 80)
            : null,
          status: "REMOVED",
          statusCode
        });

        console.log(
          "Push subscription removed:",
          statusCode,
          endpoint?.slice(0, 80)
        );

        continue;
      }

      /* ---------------------------------------------------
         OTHER PUSH ERROR
      --------------------------------------------------- */

      failed++;

      details.push({
        endpoint: endpoint
          ? endpoint.slice(0, 80)
          : null,
        status: "FAILED",
        statusCode: statusCode || null,
        error: error?.message || String(error)
      });

      console.error(
        "Push delivery error:",
        {
          statusCode,
          message: error?.message || String(error),
          endpoint: endpoint?.slice(0, 80)
        }
      );
    }
  }

  return {
    sent,
    removed,
    failed,
    total: subscriptions.length,
    details
  };
}

/* =========================================================
   EXPORT REDIS
========================================================= */

export { redis };
