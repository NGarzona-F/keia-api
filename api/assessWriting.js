// api/assessWriting.js
import fetch from "node-fetch";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Requisitos env vars:
 * - GEMINI_API_KEY
 * - GEMINI_MODEL (opcional) (ej: "gemini-1.5-pro")
 * - FIREBASE_SERVICE_ACCOUNT (JSON string)
 */

if (!global.__firebaseAdminInitialized) {
  const SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(SA) });
  global.__firebaseAdminInitialized = true;
}
const db = getFirestore();

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-pro";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const { textSample, uid } = req.body || {};
    if (!textSample || !uid) return res.status(400).json({ ok: false, error: "textSample & uid required" });

    // Prompt: pedimos JSON estricto al modelo
    const prompt = `
Eres un profesor experto de inglés. Analiza el siguiente texto y responde UNICAMENTE en JSON con este formato exacto:
{
  "level": "A1|A2|B1|B2|C1|C2",
  "confidence": 0.00-1.00,
  "scores": { "vocab":0-100, "grammar":0-100, "cohesion":0-100 },
  "explanation": "breve explicación",
  "improvements": "sugerencias concretas"
}
Texto:
"""${textSample}"""
`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateText`;
    const body = {
      prompt: { text: prompt },
      temperature: 0,
      maxOutputTokens: 512
    };

    const r = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_KEY
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error("Gemini error", r.status, txt);
      return res.status(502).json({ ok: false, error: "Gemini error", status: r.status, body: txt });
    }

    const apiJson = await r.json();
    // extraer texto candidato: la estructura puede variar
    let raw = apiJson?.candidates?.[0]?.content || apiJson?.content || JSON.stringify(apiJson);
    raw = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { raw };
    }

    // Guardar en Firestore + actualizar streak y historial
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    // compute streak
    const { streak, todayISO, updated } = computeNewStreak(userData.lastAssessmentDateISO, userData.streak);

    await userRef.set({
      level: parsed.level || "Unknown",
      levelConfidence: parsed.confidence ?? 0,
      lastAssessmentAt: new Date(),
      lastAssessmentDateISO: todayISO,
      streak: streak
    }, { merge: true });

    await userRef.collection("assessments").add({
      type: "writing",
      textSample,
      result: parsed,
      createdAt: new Date()
    });

    return res.status(200).json({ ok: true, result: parsed });
  } catch (err) {
    console.error("assessWriting error", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}

function computeNewStreak(prevISO, prevStreak = 0) {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  if (!prevISO) return { streak: 1, todayISO, updated: true };
  try {
    const prevDayStr = new Date(prevISO).toISOString().slice(0, 10);
    const prevDate = new Date(prevDayStr);
    const tDate = new Date(todayISO);
    const diffDays = Math.round((tDate - prevDate) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return { streak: prevStreak || 1, todayISO, updated: false };
    if (diffDays === 1) return { streak: (prevStreak || 0) + 1, todayISO, updated: true };
    return { streak: 1, todayISO, updated: true };
  } catch (e) {
    return { streak: 1, todayISO, updated: true };
  }
}
