// api/english-test.js
import fetch from "node-fetch";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-pro";
const FIREBASE_SA = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_ADMIN_KEY || null;

// init firebase admin safely
let adminInited = false;
try {
  if (!adminInited) {
    const sa = FIREBASE_SA ? JSON.parse(FIREBASE_SA) : null;
    if (sa) initializeApp({ credential: cert(sa) });
    else initializeApp(); // if running in GCP environment (rare for Vercel)
    adminInited = true;
  }
} catch (e) {
  console.warn("Firebase admin init warning:", e.message || e);
}
const db = getFirestore();

// helpers
function gradeMCQs(questions, answersByIndex) {
  let correct = 0;
  const details = [];
  questions.forEach((q, idx) => {
    if (q.type === "mcq") {
      const selected = answersByIndex[idx]?.selected;
      const isCorrect = selected !== undefined && selected === q.answer;
      if (isCorrect) correct++;
      details.push({ id: q.id, expected: q.answer, selected, isCorrect });
    }
  });
  return { correct, total: questions.filter(q => q.type === "mcq").length, details };
}

async function callGeminiEvaluate(text) {
  if (!GEMINI_KEY) return { ok:false, error: "No GEMINI_KEY in env" };
  const prompt = `
You are an expert English teacher. Analyze the writing sample and return JSON exactly as:
{ "scores": {"vocab":0,"grammar":0,"cohesion":0}, "analysis":"short text", "confidence":0.00 }
Text:
"""${text}"""
`;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateText`;
  const body = { prompt: { text: prompt }, temperature: 0, maxOutputTokens: 512 };
  const r = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type":"application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Gemini error ${r.status}: ${txt}`);
  }
  const j = await r.json();
  // extract candidate content robustly
  let raw = j?.candidates?.[0]?.content || j?.content || JSON.stringify(j);
  raw = String(raw).replace(/```json/gi,"").replace(/```/g,"").trim();
  try {
    const parsed = JSON.parse(raw);
    return { ok:true, parsed };
  } catch (err) {
    // try to extract object substring
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return { ok:true, parsed: JSON.parse(m[0]) };
    throw new Error("Gemini returned unparsable JSON");
  }
}

function mapScoresToLevel(scores) {
  const vocab = Number(scores.vocab || 0);
  const grammar = Number(scores.grammar || 0);
  const cohesion = Number(scores.cohesion || 0);
  const overall = 0.4*vocab + 0.4*grammar + 0.2*cohesion;
  let level = "A1";
  if (overall <= 20) level = "A1";
  else if (overall <= 35) level = "A2";
  else if (overall <= 55) level = "B1";
  else if (overall <= 75) level = "B2";
  else if (overall <= 90) level = "C1";
  else level = "C2";
  return { level, overall };
}

// serverless handler
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ ok:false, error: "Method not allowed" });

    const body = req.body || {};
    const { uid, claimedLevel, answers } = body;
    if (!answers || !Array.isArray(answers)) return res.status(400).json({ ok:false, error: "answers required" });

    // server-side canonical questions (must match client)
    const QUESTIONS = [
      { id:"q1", type:"mcq", answer:"went" },
      { id:"q2", type:"mcq", answer:"study" },
      { id:"q3", type:"mcq", answer:"In a restaurant" },
      { id:"q4", type:"mcq", answer:"He doesn't like pizza" },
      { id:"q5", type:"mcq", answer:"Verb is incorrect" },
      { id:"q6", type:"writing", answer:null },
      { id:"q7", type:"mcq", answer:"had arrived" },
      { id:"q8", type:"mcq", answer:"The project will be finished next week" },
      { id:"q9", type:"mcq", answer:"should have" },
      { id:"q10", type:"mcq", answer:"He said he was busy" },
      { id:"q11", type:"mcq", answer:"turn off" }
    ];

    const answersByIndex = answers.reduce((acc,item,idx) => { acc[idx] = item; return acc; }, {});
    const grading = gradeMCQs(QUESTIONS, answersByIndex);
    const mcqPercent = Math.round((grading.correct / Math.max(grading.total,1)) * 100);

    const writingEntry = answers.find(a => a.type === "writing" && a.writingSample && a.writingSample.trim().length >= 20);
    let geminiParsed = null;
    if (writingEntry) {
      try {
        const g = await callGeminiEvaluate(writingEntry.writingSample);
        if (g.ok) geminiParsed = g.parsed;
      } catch (e) {
        console.error("Gemini error:", e.message || e);
      }
    }

    const scores = {
      vocab: geminiParsed?.scores?.vocab ?? mcqPercent,
      grammar: geminiParsed?.scores?.grammar ?? mcqPercent,
      cohesion: geminiParsed?.scores?.cohesion ?? mcqPercent
    };

    const mapping = mapScoresToLevel(scores);
    const finalLevel = mapping.level;
    const finalConfidence = geminiParsed?.confidence ?? (mcqPercent/100);

    const result = {
      level: finalLevel,
      confidence: Number(finalConfidence) || 0,
      scores,
      explanation: geminiParsed?.analysis || `MCQ accuracy ${grading.correct}/${grading.total}`,
      details: { mcq: grading.details, geminiRaw: geminiParsed }
    };

    // update firestore if uid provided
    if (uid && db) {
      const userRef = db.collection("users").doc(uid);
      const usnap = await userRef.get();
      const userData = usnap.exists ? usnap.data() : {};

      const todayISO = new Date().toISOString().slice(0,10);
      let streak = (userData.streak || 0);
      if (userData.lastAssessmentDateISO === todayISO) {
        // same day: nothing
      } else {
        const prev = userData.lastAssessmentDateISO;
        if (prev) {
          const prevDate = new Date(prev);
          const diff = Math.round((new Date(todayISO) - new Date(prevDate.toISOString().slice(0,10))) / (1000*60*60*24));
          if (diff === 1) streak = (streak || 0) + 1;
          else streak = 1;
        } else streak = 1;
      }

      const currentAvatars = userData.avatars || [];
      if (streak >= 3 && !currentAvatars.includes("starter")) currentAvatars.push("starter");
      if (streak >= 7 && !currentAvatars.includes("bronze")) currentAvatars.push("bronze");
      if (streak >= 14 && !currentAvatars.includes("silver")) currentAvatars.push("silver");
      if (streak >= 30 && !currentAvatars.includes("gold")) currentAvatars.push("gold");

      await userRef.set({
        level: result.level,
        levelConfidence: result.confidence,
        lastAssessmentAt: new Date(),
        lastAssessmentDateISO: todayISO,
        streak,
        avatars: currentAvatars
      }, { merge: true });

      const assRef = userRef.collection("assessments").doc();
      await assRef.set({ type:"placement", payload:{ claimedLevel, answers }, result, createdAt: new Date() });
    }

    return res.status(200).json({ ok:true, result });
  } catch (err) {
    console.error("english-test error:", err);
    return res.status(500).json({ ok:false, error: err.message || String(err) });
  }
}
