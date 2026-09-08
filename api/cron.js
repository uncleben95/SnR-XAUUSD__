import scalpHandler from "./scalp.js";

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  const expected = process.env.CRON_SECRET;

  if (expected && auth !== `Bearer ${expected}`) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  try {
    await scalpHandler(req, res);
  } catch (error) {
    console.error("CRON SCALP ERROR", error);

    return res.status(500).json({
      ok: false,
      error: error?.message || "Cron execution failed"
    });
  }
}
