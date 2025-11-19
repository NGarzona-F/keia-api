// api/assessSpeaking.js
import fetch from "node-fetch";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import formidable from "formidable-serverless";
import fs from "fs";

/**
 * Env vars required:
 * - ASSEMBLYAI_KEY
 * - GEMINI_API_KEY
 * - FIREBASE_SERVICE_ACCOUNT
 * - (optional) GEMINI_MODEL
 */

export const config = { api: { bodyParser: false } };

if (!global.__firebaseAdminInitialized) {
  const SA = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  initializeApp({ credential: cert(SA) });
  global.__firebaseAdminInitialized = true;
}
const db = getFirestore();

const ASSEMBLY_KEY = process.env.ASSEMBLYAI_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-pro";

async function parseForm(req) {
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

async function uploadToAssembly(filePath) {
  const data = fs.readFileSync(filePath);
  const r = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { authorization: ASSEMBLY_KEY, "transfer-encoding": "chunked" },
    body: data
  });
  const j = await r.json();
  return j.upload_url;
}

async function createTranscription(uploadUrl) {
  const r = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { authorization: ASSEMBLY_KEY, "content-type": "application/json" },
    body: JSON.stringify({ audio_url: uploadUrl })
  });
  const j = await r.json();
  return j.id;
}

async function pollTranscript(id) {
  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: ASSEMBLY_KEY }
    });
    const j = await r.json();
    if (j.status === "completed") return j.text;
    if (j.status === "error") throw new Error("Transcription error: " + (j.error || "unknown"));
  }
}

async function callGemini(prompt) {
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateText`;
  const body = { prompt: { text: prompt }, temperature: 0, maxOutputTokens: 512 };
  const r = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("Gemini error " + r.status);
  const j = await r.json();
  let raw = j?.candidates?.[0]?.content || j?.content || JSON.stringify(j);
  raw = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(raw); } catch (e) {
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { raw };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const { fields, files } = await parseForm(req);
    const uid = fields.uid;
    const file = files.file;
    if (!file) return res.status(400).json({ ok: false, error: "file required" });

    // upload to AssemblyAI
    const uploadUrl = await uploadToAssembly(file.filepath || file.path || file.path);
    const transcriptId = await createTranscription(uploadUrl);
    const transcriptText = await pollTranscript(transcriptId);

    // build prompt for Gemini
    const prompt = `
Eres un profesor experto de inglés. Analiza la siguiente transcripción y responde UNICAMENTE en JSON con este formato:
{
  "level": "A1|A2|B1|B2|C1|C2",
  "confidence": 0.00-1.00,
  "scores": { "vocab":0-100, "grammar":0-100, "cohesion":0-100 },
  "explanation": "breve explicación",
  "improvements": "sugerencias concretas"
}
Transcripción:
"""${transcriptText}"""
`;

    const parsed = await callGemini(prompt);

    // update firestore & streak
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    const { streak, todayISO } = (function computeNewStreak(prevISO, prevStreak = 0) {
      const today = new Date();
      const todayISO = today.toISOString().slice(0,10);
      if (!prevISO) return { streak: 1, todayISO };
      try {
        const prevDayStr = new Date(prevISO).toISOString().slice(0,10);
        const prevDate = new Date(prevDayStr);
        const tDate = new Date(todayISO);
        const diffDays = Math.round((tDate - prevDate)/(1000*60*60*24));
        if (diffDays === 0) return { streak: prevStreak || 1, todayISO };
        if (diffDays === 1) return { streak: (prevStreak || 0) + 1, todayISO };
        return { streak: 1, todayISO };
      } catch(e) { return { streak: 1, todayISO }; }
    })(userData.lastAssessmentDateISO, userData.streak);

    await userRef.set({
      level: parsed.level || "Unknown",
      levelConfidence: parsed.confidence ?? 0,
      lastAssessmentAt: new Date(),
      lastAssessmentDateISO: todayISO,
      streak
    }, { merge: true });

    await userRef.collection("assessments").add({
      type: "speaking",
      transcript: transcriptText,
      result: parsed,
      createdAt: new Date()
    });

    return res.status(200).json({ ok: true, result: parsed });
  } catch (err) {
    console.error("assessSpeaking error", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
