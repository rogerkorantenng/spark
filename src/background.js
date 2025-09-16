const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen.html");

const TOKEN_PROXY = "https://royal-scene-3cd4.rogerkorantenng.workers.dev";

// ==============================
// Offscreen helpers
// ==============================
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
            reasons: ["BLOBS"], // minimal reason; offscreen will handle Prompt API calls
            justification: "Run Prompt API in a stable context for scheduled agent generations."
        });
        return true;
    } catch (e) {
        console.warn("Offscreen create failed:", e);
        return false;
    }
}

// ==============================
// Service Worker Prompt API fallback
// ==============================
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
    if (typeof self === "undefined" || typeof self.LanguageModel === "undefined") {
        throw new Error("Prompt API not available in service worker.");
    }
    const avail = await self.LanguageModel.availability();
    if (avail === "unavailable") throw new Error("Prompt API unavailable on this device.");
    return await self.LanguageModel.create({});
}
async function promptJSON_SW(session, system, user, schema, language = "en") {
    const res = await session.prompt(
        [{ role: "system", content: system }, { role: "user", content: user }],
        { output: { language }, responseConstraint: schema }
    );
    try { return JSON.parse(res); } catch { return res; }
}

// ==============================
// Agent core
// ==============================
async function runAgentOnceInternal(reasonLabel = "") {
    const cfg = await chrome.storage.local.get([
        "agentEnabled","agentTopic","platform","tone","clean",
        "postMethod","autoPost","xAccessToken","xRefreshToken","xConnected","xExpiresAt"
    ]);
    if (!cfg.agentEnabled) return { ok:false, error:"Agent disabled" };

    const topic = (cfg.agentTopic || "").trim();
    if (!topic) return { ok:false, error:"No topic set" };

    const platform = cfg.platform || "twitter";
    const hints = platformHints(platform);
    const system = buildSystemPrompt(cfg.tone || "punchy", hints.limit, hints.addHashtags, hints.lineBreaks, !!cfg.clean);
    const user = `Create three diverse ${platform} posts for this campaign topic:\n"""${topic}"""`;

    const schema = {
        type: "object",
        properties: { options: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 } },
        required: ["options"], additionalProperties: false
    };

    let options = [];
    let usedOffscreen = false;

    // Prefer offscreen (more stable)
    if (await ensureOffscreen()) {
        usedOffscreen = true;
        try {
            const response = await chrome.runtime.sendMessage({
                type: "SPARK_AGENT_GENERATE",
                payload: { topic, platform, tone: (cfg.tone || "punchy"), clean: !!cfg.clean }
            });
            options = Array.isArray(response?.options) ? response.options : [];
        } catch (e) {
            console.warn("Offscreen prompt failed, will fallback:", e);
        }
    }

    // Fallback to SW Prompt API if needed
    if (!options.length) {
        const session = await ensureLM();
        const json = await promptJSON_SW(session, system, user, schema, "en");
        options = Array.isArray(json?.options) ? json.options : String(json).split(/\n+/).filter(Boolean).slice(0,3);
    }

    options = (options || []).map(t => (t.length > hints.limit ? t.slice(0, hints.limit) : t));
    if (!options.length) return { ok:false, error:"No options generated" };

    // Save drafts
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

    // Notify
    const iconUrl = chrome.runtime.getURL("assets/icon-128.png");
    try {
        await chrome.notifications.create({
            type: "basic",
            iconUrl,
            title: "Spark drafts ready",
            message: `3 new ${(platform || "post")} drafts: ${topic}` + (usedOffscreen ? "" : " (SW fallback)") + (cfg.autoPost === "first" && platform === "twitter" ? " • Posting 1…" : ""),
            priority: 1
        });
    } catch (e) {
        console.warn("Notification failed:", chrome.runtime.lastError?.message || e.message);
    }

    // Auto-post
    if (cfg.autoPost === "first" && platform === "twitter") {
        const text = options[0];
        const method = cfg.postMethod || "intent";
        if (method === "api" && cfg.xConnected) {
            const okToken = await ensureValidAccessToken();
            if (okToken.ok) {
                const r = await postTweetViaAPI(text);
                if (!r.ok) {
                    console.warn("API post failed, opening Web Intent:", r.error);
                    await openWebIntent(text);
                }
            } else {
                console.warn("No valid token, opening Web Intent:", okToken.error);
                await openWebIntent(text);
            }
        } else {
            await openWebIntent(text);
        }
    }

    return { ok:true };
}

// ==============================
// Posting helpers
// ==============================
async function openWebIntent(text) {
    // Opens a popup to twitter.com/intent/tweet with prefilled text; user clicks Tweet.
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
    await chrome.windows.create({ url, type: "popup", width: 600, height: 650, focused: true });
}

async function postTweetViaAPI(text) {
    try {
        const { xAccessToken } = await chrome.storage.local.get(["xAccessToken"]);
        if (!xAccessToken) return { ok:false, error:"Not connected" };

        const resp = await fetch("https://api.x.com/2/tweets", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${xAccessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ text })
        });
        if (!resp.ok) {
            const err = await safeJson(resp);
            return { ok:false, error: err?.title || resp.statusText };
        }
        return { ok:true };
    } catch (e) {
        return { ok:false, error:e.message };
    }
}

async function safeJson(resp) {
    try { return await resp.json(); } catch { return null; }
}

// ==============================
// OAuth (X) — PKCE flow with chrome.identity (uses server token proxy)
// ==============================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "SPARK_AGENT_RESCHEDULE") {
        reschedule();
    }
    if (msg?.type === "SPARK_AGENT_RUN_ONCE") {
        runAgentOnceInternal("manual run").then(sendResponse);
        return true; // async
    }
    if (msg?.type === "X_OAUTH_CONNECT") {
        xOAuthConnect_PKCE().then(sendResponse);
        return true; // async
    }
});

// Build a base64url string from bytes
function base64url(bytes) {
    let bin = "";
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Helpful log once so you can copy the exact redirect for the X portal.
(function logRedirectForPortal() {
    try {
        const r = chrome.identity.getRedirectURL();
        console.log("[Spark] OAuth redirect to allowlist in X portal:", r);
    } catch {}
})();

// Refresh token via proxy if needed
async function ensureValidAccessToken() {
    const { xAccessToken, xRefreshToken, xExpiresAt } = await chrome.storage.local.get(["xAccessToken","xRefreshToken","xExpiresAt"]);
    const now = Date.now();

    if (xAccessToken && xExpiresAt && now < (xExpiresAt - 120000)) { // >2min left
        return { ok:true, accessToken: xAccessToken };
    }

    if (!xRefreshToken) return { ok:false, error:"No refresh token" };
    if (!TOKEN_PROXY)   return { ok:false, error:"Token proxy not configured" };

    try {
        const resp = await fetch(TOKEN_PROXY, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                grant_type: "refresh_token",
                refresh_token: xRefreshToken
            })
        });

        if (!resp.ok) {
            const err = await resp.text();
            return { ok:false, error: "Refresh failed: " + err };
        }

        const tokens = await resp.json();
        const expiresAt = tokens.expires_in ? (Date.now() + (Number(tokens.expires_in) * 1000)) : 0;

        await chrome.storage.local.set({
            xAccessToken: tokens.access_token,
            xRefreshToken: tokens.refresh_token || xRefreshToken,
            xConnected: true,
            xExpiresAt: expiresAt
        });

        return { ok:true, accessToken: tokens.access_token };
    } catch (e) {
        return { ok:false, error: e.message };
    }
}

function getClientId() {
    // Client ID is safe to expose (public). Secret stays on server.
    return "Z0c3Ymp0bjlROWtucHR0MTlZYUE6MTpjaQ"; // <-- replace with YOUR real Client ID
}

async function xOAuthConnect_PKCE() {
    try {
        if (!TOKEN_PROXY || TOKEN_PROXY.startsWith("https://YOUR_")) {
            throw new Error("Set TOKEN_PROXY in background.js to your token proxy URL.");
        }

        const CLIENT_ID = getClientId();
        if (!CLIENT_ID || CLIENT_ID.startsWith("<YOUR_")) {
            throw new Error("Set your X Client ID in background.js (getClientId()).");
        }

        const REDIRECT = chrome.identity.getRedirectURL(); // exact chromiumapp.org URL

        // ===== State & PKCE (S256) =====
        const STATE_BYTES = new Uint8Array(16); crypto.getRandomValues(STATE_BYTES);
        const STATE = base64url(STATE_BYTES);

        const VERIFIER_BYTES = new Uint8Array(32); crypto.getRandomValues(VERIFIER_BYTES);
        const VERIFIER = base64url(VERIFIER_BYTES);

        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
        const CHALLENGE = base64url(new Uint8Array(digest));

        // ===== Authorize URL (correct endpoint) =====
        const auth = new URL("https://twitter.com/i/oauth2/authorize");
        auth.searchParams.set("response_type", "code");
        auth.searchParams.set("client_id", CLIENT_ID);
        auth.searchParams.set("redirect_uri", REDIRECT);
        auth.searchParams.set("scope", "tweet.write tweet.read users.read");
        auth.searchParams.set("state", STATE);
        auth.searchParams.set("code_challenge", CHALLENGE);
        auth.searchParams.set("code_challenge_method", "S256");

        const responseUrl = await chrome.identity.launchWebAuthFlow({
            url: auth.toString(),
            interactive: true
        });

        // ===== Robust error handling (query OR hash) =====
        const final = new URL(responseUrl);
        const q = final.searchParams;
        const h = new URLSearchParams(final.hash.startsWith("#") ? final.hash.slice(1) : final.hash);
        const errQ = q.get("error") || h.get("error");
        const errDesc = q.get("error_description") || h.get("error_description");
        if (errQ) {
            if (errQ === "access_denied") {
                throw new Error("Access denied: you may have cancelled, or the app lacks write permission / redirect URL doesn’t match.");
            }
            throw new Error(`OAuth error: ${errQ}${errDesc ? " — " + errDesc : ""}`);
        }

        // ===== Parse ?code & state =====
        const returnedState = q.get("state");
        const code = q.get("code");
        if (!code || returnedState !== STATE) throw new Error("Bad auth response (missing code/state).");

        // ===== Token exchange via your proxy =====
        const tokenResp = await fetch(TOKEN_PROXY, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                grant_type: "authorization_code",
                code,
                code_verifier: VERIFIER,
                redirect_uri: REDIRECT
            })
        });
        if (!tokenResp.ok) throw new Error("Token exchange failed: " + (await tokenResp.text()));

        const tokens = await tokenResp.json(); // { access_token, refresh_token?, expires_in, ...}
        const expiresAt = tokens.expires_in ? (Date.now() + (Number(tokens.expires_in) * 1000)) : 0;

        await chrome.storage.local.set({
            xAccessToken: tokens.access_token,
            xRefreshToken: tokens.refresh_token || "",
            xConnected: true,
            xExpiresAt: expiresAt
        });

        // Optional: fetch @handle for UI
        try {
            const me = await fetch("https://api.x.com/2/users/me", { headers: { "Authorization": `Bearer ${tokens.access_token}` } });
            const mj = await me.json();
            await chrome.storage.local.set({ xUser: mj?.data?.username || "" });
        } catch {}

        return { ok:true, user: (await chrome.storage.local.get(["xUser"]))?.xUser || "" };
    } catch (e) {
        console.error("xOAuthConnect_PKCE error:", e);
        return { ok:false, error: e.message };
    }
}

// ==============================
// Scheduler
// ==============================
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

// ==============================
// Alarm handler
// ==============================
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== "spark_agent") return;
    try {
        await runAgentOnceInternal("scheduled");
    } catch (e) {
        console.error("Agent run failed:", e);
    }
});
