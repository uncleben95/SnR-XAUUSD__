import handler from "./push-send.js";

export default async function test(req, res) {
  req.method = "POST";
  req.body = {
    title: "🟢 XAU/USD Pro Sniper",
    body: "Test push notification berjaya!"
  };

  return handler(req, res);
}
