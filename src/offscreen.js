function platformHints(platform) {
    switch (platform) {
        case "twitter":  return { limit: 280,  addHashtags: true,  lineBreaks: 0 };
        case "linkedin": return { limit: 2200, addHashtags: false, lineBreaks: 2 };
        case "instagram":return { limit: 2200, addHashtags: true,  lineBreaks: 3 };
        case "tiktok":   return { limit: 2200, addHashtags: true,  lineBreaks: 2 };
        default:         return { limit: 280,  addHashtags: true,  lineBreaks: 0 };
    }
}
function buildSystemPrompt(tone, limit, addHashtags, lineBreaks, clean) {
    const cleanLine = clean
        ? "Ensure brand-safe, professional language; avoid profanity, slurs, sensitive claims, or misleading advice."
        : "";
    return `You are a social media copywriter. Write in ${tone} tone. Keep within ${limit} characters. ${
        addHashtags ? "Add relevant hashtags." : "Do not include hashtags."
    } Use ${lineBreaks} line breaks. ${cleanLine} Output only the final caption(s).`;
}
async function ensureSession() {
    if (!("LanguageModel" in self)) throw new Error("Prompt API not found in offscreen.");
    const avail = await LanguageModel.availability();
    if (avail === "unavailable") throw new Error("Prompt API unavailable on this device.");
    return await LanguageModel.create({});
}
async function promptJSON(session, system, user, schema, language = "en") {
    const res = await session.prompt(
        [{ role: "system", content: system }, { role: "user", content: user }],
        { output: { language }, responseConstraint: schema }
    );
    try { return JSON.parse(res); } catch { return res; }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg?.type !== "SPARK_AGENT_GENERATE") return;

        const { topic, platform, tone, clean } = msg.payload || {};
        const hints = platformHints(platform || "twitter");
        const system = buildSystemPrompt(tone || "punchy", hints.limit, hints.addHashtags, hints.lineBreaks, !!clean);

        const session = await ensureSession();
        const schema = {
            type: "object",
            properties: { options: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 } },
            required: ["options"], additionalProperties: false
        };
        const user = `Create three diverse ${platform} posts for this campaign topic:\n"""${topic}"""`;

        let json = await promptJSON(session, system, user, schema, "en");
        let options = Array.isArray(json?.options) ? json.options : [];
        if (options.length !== 3) {
            options = String(json).split(/\n+/).filter(Boolean).slice(0,3);
            while (options.length < 3) options.push("—");
        }
        options = options.map((t) => t.length > hints.limit ? t.slice(0, hints.limit) : t);

        sendResponse({ ok: true, options });
    })().catch((e) => {
        console.error("Offscreen generation error:", e);
        sendResponse({ ok: false, error: e.message });
    });
    return true;
});
