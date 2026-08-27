import webpush from "web-push";

export default function handler(req, res) {
  const keys = webpush.generateVAPIDKeys();

  res.status(200).json(keys);
}
