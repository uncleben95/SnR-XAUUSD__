import { sendPushToAll } from "./push-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.PUSH_API_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "PUSH_API_SECRET belum diset" });
  }

  const supplied =
    req.headers["x-push-secret"] ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "");

  if (supplied !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { title, body, tag, url } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({ error: "Missing title or body" });
    }

    const result = await sendPushToAll({ title, body, tag, url });

    if (!result.total) {
      return res.status(404).json({ error: "No push subscriptions found" });
    }

    return res.status(200).json({
      success: true,
      message: "Push sent",
      ...result
    });
  } catch (error) {
    console.error("Push error:", error);
    return res.status(500).json({
      error: "Push failed",
      details: error.message
    });
  }
}
