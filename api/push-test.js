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

export default async function handler(req, res) {

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const key = req.query.key;

  if (key !== process.env.PUSH_TEST_KEY) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  try {

    const saved = await redis.get(
      "xau_push_subscription"
    );

    if (!saved) {
      return res.status(404).json({
        error: "No subscription found"
      });
    }

    const subscription =
      typeof saved === "string"
        ? JSON.parse(saved)
        : saved;

    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: "🟢 XAU/USD TEST",
        body: "Push notification berjaya!",
        icon: "/icon.png"
      })
    );

    return res.status(200).json({
      success: true,
      message: "Test push sent"
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: "Push failed",
      details: error.message
    });

  }
}
