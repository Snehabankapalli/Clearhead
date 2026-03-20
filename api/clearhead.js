// ── RATE LIMITING ──────────────────────────────────────────────
const rateLimit = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const window = 60 * 1000;
  const limit = 20;
  if (!rateLimit.has(ip)) rateLimit.set(ip, []);
  const timestamps = rateLimit.get(ip).filter(t => now - t < window);
  if (timestamps.length >= limit) return true;
  timestamps.push(now);
  rateLimit.set(ip, timestamps);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of rateLimit.entries()) {
    const fresh = timestamps.filter(t => now - t < 60 * 1000);
    if (fresh.length === 0) rateLimit.delete(ip);
    else rateLimit.set(ip, fresh);
  }
}, 10 * 60 * 1000);

// ── HANDLER ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || "unknown";
  if (isRateLimited(ip)) {
    console.warn({ event: "rate_limited", ip, time: new Date().toISOString() });
    return res.status(429).json({ error: "Too many requests. Take a breath — try again in a minute." });
  }

  try {
    const { text, energy = "medium", aiMode = "direct" } = req.body || {};

    if (!text || typeof text !== "string") return res.status(400).json({ error: "Invalid input" });
    const trimmed = text.trim();
    if (trimmed.length < 8) return res.status(400).json({ error: "Too short — tell me more" });
    if (trimmed.length > 2000) return res.status(400).json({ error: "Too long — keep it under 2000 characters" });
    if (!["soft","direct","brutal","jobsearch"].includes(aiMode)) return res.status(400).json({ error: "Invalid aiMode" });
    if (!["low","medium","high"].includes(energy)) return res.status(400).json({ error: "Invalid energy" });

    console.log(JSON.stringify({ event:"dump_received", time:new Date().toISOString(), ip, length:trimmed.length, energy, aiMode }));

    // ── MODE INSTRUCTIONS ──
    const modeInstructions = {
      soft: "Tone: warm, compassionate, encouraging. Acknowledge emotions before tasks.",
      direct: "Tone: clear, honest, no-nonsense. State what matters without fluff.",
      brutal: "Tone: brutally honest. Call out avoidance directly. No coddling. Use their exact words.",
      jobsearch: `Tone: direct and focused on what actually gets interviews.
JOB SEARCH MODE — special rules:
- Prioritize actions that directly lead to interviews: applying, messaging recruiters, preparing for interviews
- Deprioritize passive actions: researching companies for hours, endlessly editing resume, watching career videos
- Call out avoidance patterns explicitly: "rewriting resume again instead of applying", "researching instead of reaching out"
- Max 1 resume task in now/today — if they mention resume more than once, the extras go to drop
- "Apply to 1 job" always beats "apply to 10 jobs" — scope down ruthlessly
- If they haven't applied anywhere: make that the Do Now, no exceptions`
    };

    const insightInstruction = aiMode === "brutal"
      ? "MUST start with: You are not overwhelmed. You are avoiding [name the specific thing from their dump]. Then: And it is costing you your day."
      : aiMode === "jobsearch"
      ? "Name the specific job search action they are avoiding. Be direct. If they are rewriting resume instead of applying, say that. If they are researching instead of reaching out, say that. Use their exact words."
      : aiMode === "soft"
      ? "Be warm but name the real issue. Acknowledge the feeling first. Do not be vague."
      : "Be direct. Name the exact thing they are avoiding. No hedging.";

    const system = `You are ClearHead, a productivity coach. Return ONLY valid raw JSON. No markdown. No code fences.`;

    const userPrompt = `Brain dump: "${trimmed}"
Energy: ${energy}
Mode: ${aiMode}
${modeInstructions[aiMode]}

Return this exact JSON:
{
  "insight": "1-2 sentences. ${insightInstruction} Never say might or maybe.",
  "startHere": { "task": "single most important action — concrete and specific", "time": "e.g. 2 min" },
  "tasks": [
    {
      "title": "concrete action from their dump",
      "time": "e.g. 15 min or this week",
      "reason": "why it matters or why it is being dropped",
      "priority": "now|today|later|drop",
      "dropReason": "only if drop: Too vague / Guilt-based / No clear next step / Not urgent / Unrealistic / Someone else's urgency / Avoidance disguised as work"
    }
  ]
}

Rules:
- now: max 3
- today: max 4  
- Extract ONLY what is in the dump
- Energy ${energy}: ${energy === "low" ? "now tasks under 10 min each" : energy === "high" ? "bigger tasks ok in now" : "mix of quick and medium"}
${aiMode === "jobsearch" ? "- Job search rule: active beats passive. Applying beats researching. Messaging beats scrolling." : ""}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system,
        messages: [{ role: "user", content: userPrompt }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error({ event:"anthropic_error", status:response.status });
      return res.status(500).json({ error: "AI request failed", details: errorText });
    }

    const data = await response.json();
    let raw = data.content?.find(b => b.type === "text")?.text || "";
    raw = raw.replace(/```json|```/g, "").trim();

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return res.status(500).json({ error: "AI returned invalid format", raw }); }

    console.log(JSON.stringify({
      event: "dump_completed", time: new Date().toISOString(), ip,
      now: parsed.tasks?.filter(t => t.priority === "now").length || 0,
      today: parsed.tasks?.filter(t => t.priority === "today").length || 0,
      drop: parsed.tasks?.filter(t => t.priority === "drop").length || 0
    }));

    return res.status(200).json(parsed);

  } catch (error) {
    console.error({ event:"server_error", message:error.message });
    return res.status(500).json({ error: "Server error", message: error.message });
  }
}
