// api/assessSpeaking.js
export default function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  return res.status(200).json({
    ok: true,
    result: {
      level: "A2",
      confidence: 0.62,
      scores: { vocab: 55, grammar: 50, fluency: 60 },
      explanation: "Mock: pronunciación básica y pausas frecuentes."
    }
  });
}
