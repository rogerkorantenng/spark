// MV3 service worker: schedules agent runs, triggers an offscreen document to use Prompt API,
// or (if offscreen not available) runs Prompt API right here as a fallback.
// Stores drafts and shows notifications.

const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen.html");

// ---------- Helpers ----------
function hasOffscreenAPI() {
    return !!(chrome.offscreen && chrome.offscreen.createDocument && chrome.offscreen.hasDocument);
}

async function hasOffscreenDoc() {
    if (!hasOffscreenAPI()) return false;
    try {
        return !!(await chrome.offscreen.hasDocument());
    } catch {
        return false;
    }
}

async function ensureOffscreen() {
    if (!hasOffscreenAPI()) return false;
    if (await hasOffscreenDoc()) return true;
    try {
        await chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            // "BLOBS" is the least-privileged reason that keeps the page alive for our JS.
            // (Other allowed reasons include DOM_PARSER/DOM_SCRAPING in newer docs; BLOBS works broadly.)
            reasons: ["BLOBS"],
            justification: "Run Prompt API in a stable context for scheduled agent generations."
        });
        return true;
    } catch (e) {
        console.warn("Offscreen create failed:", e);
        return false;
    }
}

async function destroyOffscreen() {
    if (!hasOffscreenAPI()) return;
    try {
        if (await hasOffscreenDoc()) await chrome.offscreen.closeDocument();
    } catch (e) {
        console.warn("Offscreen close failed:", e);
    }
}

// ---------- Prompt API fallback in the Service Worker ----------
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

async function ensureLM() {
    // Some Chrome versions expose Prompt API in workers; others don’t.
    if (typeof self === "undefined" || typeof self.LanguageModel === "undefined") {
        throw new Error("Prompt API not available in service worker.");
    }
    const avail = await self.LanguageModel.availability();
    if (avail === "unavailable") throw new Error("Prompt API unavailable on this device.");
    return await self.LanguageModel.create({
        monitor(m) {
            // quiet in SW
        }
    });
}

async function promptJSON_SW(session, system, user, schema, language = "en") {
    const res = await session.prompt(
        [{ role: "system", content: system }, { role: "user", content: user }],
        { output: { language }, responseConstraint: schema }
    );
    try { return JSON.parse(res); } catch { return res; }
}

// ---------- Scheduler ----------
async function reschedule() {
    const cfg = await chrome.storage.local.get(["agentEnabled","agentFrequency"]);
    await chrome.alarms.clear("spark_agent");
    if (cfg.agentEnabled) {
        const every = Math.max(1, Number(cfg.agentFrequency || 720)); // minutes
        await chrome.alarms.create("spark_agent", { periodInMinutes: every, delayInMinutes: 0.2 });
    }
}

chrome.runtime.onInstalled.addListener(reschedule);
chrome.runtime.onStartup.addListener(reschedule);

chrome.runtime.onMessage.addListener((msg, _sender, _send) => {
    if (msg?.type === "SPARK_AGENT_RESCHEDULE") reschedule();
});

// ---------- Alarm handler ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== "spark_agent") return;

    const cfg = await chrome.storage.local.get(["agentEnabled","agentTopic","platform","tone","clean"]);
    if (!cfg.agentEnabled) return;

    const topic = (cfg.agentTopic || "").trim();
    if (!topic) return;

    try {
        const hints = platformHints(cfg.platform || "twitter");
        const system = buildSystemPrompt(cfg.tone || "punchy", hints.limit, hints.addHashtags, hints.lineBreaks, !!cfg.clean);
        const user = `Create three diverse ${(cfg.platform || "twitter")} posts for this campaign topic:\n"""${topic}"""`;
        const schema = {
            type: "object",
            properties: { options: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 } },
            required: ["options"], additionalProperties: false
        };

        let options = [];

        // Preferred path: Offscreen page (more stable)
        let usedOffscreen = false;
        if (await ensureOffscreen()) {
            usedOffscreen = true;
            const response = await chrome.runtime.sendMessage({
                type: "SPARK_AGENT_GENERATE",
                payload: { topic, platform: cfg.platform || "twitter", tone: cfg.tone || "punchy", clean: !!cfg.clean }
            });
            options = Array.isArray(response?.options) ? response.options : [];
        }

        // Fallback: Try in the Service Worker with Prompt API
        if (!options.length) {
            const session = await ensureLM(); // throws if not supported here
            const json = await promptJSON_SW(session, system, user, schema, "en"); // <- language enforced
            options = Array.isArray(json?.options) ? json.options : String(json).split(/\n+/).filter(Boolean).slice(0,3);
        }

        // Trim & store
        options = (options || []).map(t => (t.length > hints.limit ? t.slice(0, hints.limit) : t));
        if (options.length) {
            const drafts = (await chrome.storage.local.get(["drafts"]))?.drafts || [];
            drafts.unshift({
                ts: Date.now(),
                topic,
                platform: cfg.platform,
                tone: cfg.tone,
                clean: !!cfg.clean,
                options
            });
            while (drafts.length > 50) drafts.pop();
            await chrome.storage.local.set({ drafts });

            // Build a safe icon URL for notifications (absolute, within the extension)
            const iconUrl = chrome.runtime.getURL("assets/icon-128.png");

            try {
                await chrome.notifications.create({
                    type: "basic",
                    iconUrl, // must be an absolute chrome-extension:// URL
                    title: "Spark drafts ready",
                    message: `3 new ${(cfg.platform || "post")} drafts generated for: ${topic}` + (usedOffscreen ? "" : " (SW fallback)"),
                    priority: 1
                });
            } catch (e) {
                // Some Chrome builds use runtime.lastError instead of throwing
                const msg = chrome.runtime.lastError?.message || e.message;
                console.warn("Notification failed:", msg);
            }

        }
    } catch (e) {
        console.error("Agent run failed:", e);
    } finally {
        // Keep offscreen for reuse, or close to save resources:
        // await destroyOffscreen();
    }
});
