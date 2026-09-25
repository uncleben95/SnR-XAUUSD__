import { saveSubscription } from "./push-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const subscription = req.body;

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: "Invalid push subscription" });
    }

    await saveSubscription(subscription);

    return res.status(200).json({
      success: true,
      message: "Push subscription saved"
    });
  } catch (error) {
    console.error("Push subscribe error:", error);
    return res.status(500).json({
      error: "Failed to save push subscription"
    });
  }
}
