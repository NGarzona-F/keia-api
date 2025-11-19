// api/assessWriting.js
export default function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const { textSample, uid } = req.body || {};

  return res.status(200).json({
    ok: true,
    result: {
      level: "B1",
      confidence: 0.76,
      scores: { vocab: 72, grammar: 68, cohesion: 70 },
      explanation: "Mock: buena comprensión general con errores de gramática.",
      uid,
      textSample
    }
  });
}
