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

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {

    const subscription = req.body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({
        error: "Invalid subscription"
      });
    }

    await redis.set(
      "xau_push_subscription",
      JSON.stringify(subscription)
    );

    return res.status(200).json({
      success: true,
      message: "Push subscription saved"
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: "Failed to save push subscription"
    });

  }

}
