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

    const {
      title,
      body
    } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({
        error: "Missing title or body"
      });
    }

    const saved =
      await redis.get(
        "xau_push_subscription"
      );

    if (!saved) {
      return res.status(404).json({
        error: "No push subscription found"
      });
    }

    const subscription =
      typeof saved === "string"
        ? JSON.parse(saved)
        : saved;

    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title,
        body,
        icon: "/icon.png"
      })
    );

    return res.status(200).json({
      success: true,
      message: "Push sent"
    });

  } catch (error) {

    console.error(
      "Push error:",
      error
    );

    return res.status(500).json({
      error: "Push failed",
      details: error.message
    });

  }

}
