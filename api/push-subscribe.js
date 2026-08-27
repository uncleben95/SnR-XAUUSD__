import webpush from "web-push";

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

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

    /*
     * Temporary:
     * verify subscription only.
     */

    return res.status(200).json({
      success: true,
      message: "Push subscription received"
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error: "Push subscription failed"
    });

  }
}
