export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  return res.status(200).json({
    publicKey: process.env.VAPID_PUBLIC_KEY || null
  });
}
