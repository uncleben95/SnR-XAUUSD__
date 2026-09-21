// api/gemini-test.js
// Safe Gemini connectivity test. Does NOT trigger XAUUSD signal logic or push notifications.

export default async function handler(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      gemini: false,
      status: "NO_API_KEY",
      model,
      error: "GEMINI_API_KEY belum diset di Vercel"
    });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: `You are testing an XAU/USD second-layer trading analyst connection.\n\nReturn ONLY valid JSON:\n{"connected":true,"message":"Gemini is working","testDecision":"WAIT_RETRACE"}`
          }]
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json"
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        gemini: false,
        status: "API_ERROR",
        model,
        httpStatus: response.status,
        error: data?.error?.message || `Gemini HTTP ${response.status}`
      });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || "").join("").trim();

    if (!text) {
      return res.status(502).json({
        ok: false,
        gemini: false,
        status: "EMPTY_RESPONSE",
        model,
        error: "Gemini returned an empty response"
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
      parsed = JSON.parse(cleaned);
    }

    return res.status(200).json({
      ok: true,
      gemini: true,
      status: "SUCCESS",
      model,
      connected: parsed?.connected === true,
      response: parsed,
      note: "Gemini connection test only. No XAUUSD signal or push notification was triggered."
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      gemini: false,
      status: "REQUEST_ERROR",
      model,
      error: error?.message || "Gemini request failed"
    });
  }
}
