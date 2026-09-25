import { sendPushToAll } from "./push-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.PUSH_TEST_SECRET;
  const supplied = req.headers["x-push-test-secret"];
  if (!secret || supplied !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await sendPushToAll({
      title: "🧪 XAUUSDSNIPER TEST",
      body: "Push notification berfungsi. Phone boleh menerima notification walaupun dashboard ditutup.",
      tag: "xau-push-test",
      url: req.body?.url || "/"
    });

    if (!result.total) {
      return res.status(404).json({
        error: "Tiada push subscription. Tekan ENABLE dahulu."
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Test push sent",
      ...result
    });

  } catch (error) {
    console.error("Push test error:", error);

    return res.status(500).json({
      error: "Push test failed",
      details: error.message
    });
  }
}
