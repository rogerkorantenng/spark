// Detect full-page context and switch layout
// Detect full-page context ONLY when explicitly requested via hash
(function setFullpageIfNeeded(){
    const hash = (location.hash || "").toLowerCase();
    if (hash.includes("drafts") || hash.includes("full")) {
        document.documentElement.setAttribute("data-fullpage", "1");
    } else {
        document.documentElement.removeAttribute("data-fullpage");
    }
})();


// ===== Tabs =====
const tabs = [...document.querySelectorAll(".tab")];
const views = {
    compose:  document.getElementById("view-compose"),
    agent:    document.getElementById("view-agent"),
    drafts:   document.getElementById("view-drafts"),
    settings: document.getElementById("view-settings"),
};
function showView(name){
    Object.entries(views).forEach(([k,el]) => el.style.display = (k===name) ? "" : "none");
    tabs.forEach(t => t.classList.toggle("active", t.dataset.view===name));
    chrome.storage?.local.set({ lastView: name });
}
chrome.storage?.local.get(["lastView"], ({ lastView }) => {
    // If we landed with #drafts, force Drafts view (useful when agent opens in a tab)
    if (location.hash === "#drafts") return showView("drafts");
    showView(lastView || "compose");
});
tabs.forEach(t => t.addEventListener("click", () => showView(t.dataset.view)));

// ===== Theme =====
function applyTheme(t) {
    const html = document.documentElement;
    html.removeAttribute("data-theme");
    if (t === "light") html.setAttribute("data-theme","light");
    if (t === "dark")  html.setAttribute("data-theme","dark");
    chrome.storage?.local.set({ theme: t });
}
chrome.storage?.local.get(["theme"], ({ theme }) => applyTheme(theme || "auto"));
document.getElementById("themeAuto").onclick  = () => applyTheme("auto");
document.getElementById("themeLight").onclick = () => applyTheme("light");
document.getElementById("themeDark").onclick  = () => applyTheme("dark");

// ===== Compose refs =====
const inputEl     = document.getElementById("input");
const outEl       = document.getElementById("out");
const statusEl    = document.getElementById("status");
const platformEl  = document.getElementById("platform");
const toneEl      = document.getElementById("tone");
const cleanEl     = document.getElementById("clean");
const counterEl   = document.getElementById("counter");
const meterBarEl  = document.getElementById("meterBar");
const spinEl      = document.getElementById("spin");

// ===== Agent refs =====
const agentEnabledEl   = document.getElementById("agentEnabled");
const agentFrequencyEl = document.getElementById("agentFrequency");
const agentTopicEl     = document.getElementById("agentTopic");
const draftsEl         = document.getElementById("drafts");

// ===== Drafts page refs =====
const draftsListEl     = document.getElementById("draftsList");
const btnDeleteAll     = document.getElementById("btn-delete-all");

// ===== Post settings refs =====
const postMethodEl   = document.getElementById("postMethod");
const autoPostEl     = document.getElementById("autoPost");
const xStatusEl      = document.getElementById("xStatus");
const btnConnectX    = document.getElementById("btn-connect-x");
const btnDisconnectX = document.getElementById("btn-disconnect-x");

// ===== Spinner / buttons lock =====
const allButtons = [...document.querySelectorAll("button")];
function setLoading(on, msg = "") {
    statusEl.textContent = on ? (msg || "Working…") : (msg || "Ready");
    spinEl.style.display = on ? "inline-block" : "none";
    allButtons.forEach(b => {
        if (b.id?.startsWith("theme")) return;
        b.disabled = on;
    });
}

// ===== Toasts =====
const toastEl = document.getElementById("toast");
let toastTimer;
function toast(msg, ok=true) {
    toastEl.textContent = msg;
    toastEl.style.background = ok ? "var(--fg)" : "var(--warning)";
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>toastEl.classList.remove("show"), 1500);
}

// ===== Autosize & shortcuts =====
function autosize(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 280) + "px"; }
inputEl.addEventListener("input", (e)=> autosize(e.target));

document.addEventListener("keydown", (e) => {
    const mod = (e.ctrlKey || e.metaKey);
    if (mod && e.key === "Enter")                           { e.preventDefault(); document.getElementById("btn-generate").click(); }
    if (mod && e.shiftKey && e.key.toLowerCase()==="r")     { e.preventDefault(); document.getElementById("btn-rewrite").click(); }
    if (mod && e.key.toLowerCase()==="h")                   { e.preventDefault(); document.getElementById("btn-hashtags").click(); }
    if (mod && e.key.toLowerCase()==="b")                   { e.preventDefault(); document.getElementById("btn-copy").click(); }
    if (mod && e.key.toLowerCase()==="i")                   { e.preventDefault(); document.getElementById("btn-insert").click(); }
});

// ===== Messaging helpers =====
const getSelection = () =>
    new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (!tab?.id) return resolve({ text: "" });
            chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTION" }, resolve);
        });
    });
const getPageText = () =>
    new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (!tab?.id) return resolve({ text: "" });
            chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_TEXT" }, resolve);
        });
    });
const insertToPage = (text) =>
    new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
            if (!tab?.id) return resolve({ success: false });
            chrome.tabs.sendMessage(tab.id, { type: "INSERT_TEXT", text }, resolve);
        });
    });

// ===== Platform rules & counters =====
function platformHints(platform) {
    switch (platform) {
        case "twitter":  return { limit: 280,  addHashtags: true,  lineBreaks: 0 };
        case "linkedin": return { limit: 2200, addHashtags: false, lineBreaks: 2 };
        case "instagram":return { limit: 2200, addHashtags: true,  lineBreaks: 3 };
        case "tiktok":   return { limit: 2200, addHashtags: true,  lineBreaks: 2 };
        default:         return { limit: 280,  addHashtags: true,  lineBreaks: 0 };
    }
}
function updateCounter(text) {
    const { limit } = platformHints(platformEl.value);
    const len = (text || "").length;
    counterEl.textContent = `${len} / ${limit}`;
    const pct = Math.max(0, Math.min(100, Math.round((len/limit)*100)));
    meterBarEl.style.width = pct + "%";
    meterBarEl.style.background = (len > limit) ? "var(--warning)" : "linear-gradient(90deg,var(--accent),var(--btn))";
}
updateCounter(inputEl.value);
platformEl.addEventListener("change", () => { saveSettings(); updateCounter(outEl.textContent.trim() || inputEl.value); });
toneEl.addEventListener("change", saveSettings);
cleanEl.addEventListener("change", saveSettings);
inputEl.addEventListener("input", () => updateCounter(inputEl.value));

// ===== Prompt API helpers =====
async function ensurePromptSession(expectedInputs) {
    if (!("LanguageModel" in self)) throw new Error("Prompt API not found in this browser.");
    const avail = await LanguageModel.availability();
    statusEl.textContent = `Prompt API: ${avail}`;
    if (avail === "unavailable") throw new Error("Prompt API unavailable on this device.");
    return await LanguageModel.create({
        ...(expectedInputs ? { expectedInputs } : {}),
        monitor(m) {
            m.addEventListener("downloadprogress", (e) => {
                const pct = Math.round(e.loaded * 100);
                statusEl.textContent = `Downloading model… ${pct}%`;
            });
            m.addEventListener("downloadcomplete", () => { statusEl.textContent = "Model downloaded."; });
        }
    });
}
async function promptWithOutput(session, messagesOrText, opts = {}) {
    const safe = { ...opts, output: { language: (opts.output && opts.output.language) || "en" } };
    return typeof messagesOrText === "string"
        ? session.prompt(messagesOrText, safe)
        : session.prompt(messagesOrText, safe);
}
async function promptJSON(session, system, user, schema, language = "en") {
    const res = await session.prompt(
        [{ role: "system", content: system }, { role: "user", content: user }],
        { output: { language }, responseConstraint: schema }
    );
    try { return JSON.parse(res); } catch { return res; }
}

// ===== Settings (plus agent + posting) =====
function saveSettings(extra = {}) {
    const payload = {
        platform: platformEl.value,
        tone: toneEl.value,
        clean: cleanEl.checked,
        agentEnabled: agentEnabledEl?.checked ?? false,
        agentFrequency: Number(agentFrequencyEl?.value || 720),
        agentTopic: agentTopicEl?.value?.trim?.() || "",
        postMethod: postMethodEl?.value || "intent",
        autoPost: autoPostEl?.value || "off",
        ...extra
    };
    chrome.storage?.local.set(payload);
}

chrome.storage?.local.get(
    ["platform","tone","clean","agentEnabled","agentFrequency","agentTopic","postMethod","autoPost","xConnected","xUser"],
    (cfg) => {
        if (cfg?.platform) platformEl.value = cfg.platform;
        if (cfg?.tone)     toneEl.value = cfg.tone;
        if (typeof cfg?.clean === "boolean") cleanEl.checked = cfg.clean;

        if (typeof cfg?.agentEnabled === "boolean") agentEnabledEl.checked = cfg.agentEnabled;
        if (cfg?.agentFrequency) agentFrequencyEl.value = String(cfg.agentFrequency);
        if (cfg?.agentTopic) agentTopicEl.value = cfg.agentTopic;

        if (cfg?.postMethod) postMethodEl.value = cfg.postMethod;
        if (cfg?.autoPost)   autoPostEl.value   = cfg.autoPost;

        xStatusEl.textContent = cfg?.xConnected ? `Connected${cfg.xUser ? " as @" + cfg.xUser : ""}` : "Not connected";

        updateCounter(inputEl.value);
        renderLatestDraft();
        renderDraftsList();
    }
);

// Capability ping (status footer)
(async () => {
    try {
        if ("LanguageModel" in self) {
            const a = await LanguageModel.availability();
            statusEl.textContent = `Prompt API: ${a}`;
        } else {
            statusEl.textContent = "Prompt API not detected.";
        }
        if ("Summarizer" in self) {
            const s = await Summarizer.availability?.();
            statusEl.textContent += ` | Summarizer: ${s}`;
        } else {
            statusEl.textContent += " | Summarizer not detected.";
        }
    } catch (e) { console.error(e); }
})();

// ===== Build prompt helpers =====
function buildSystemPrompt(tone, hints, clean) {
    const cleanLine = clean
        ? "Ensure brand-safe, professional language; avoid profanity, slurs, sensitive claims, or misleading advice."
        : "";
    return `You are a social media copywriter. Write in ${tone} tone. Keep within ${hints.limit} characters. ${
        hints.addHashtags ? "Add relevant hashtags." : "Do not include hashtags."
    } Use ${hints.lineBreaks} line breaks. ${cleanLine} Output only the final caption.`;
}
function withLimit(text) {
    const { limit } = platformHints(platformEl.value);
    if ((text || "").length <= limit) return text;
    return text.slice(0, limit);
}

// ===== Drafts (Agent panel preview) =====
async function renderLatestDraft() {
    const { drafts = [] } = await chrome.storage.local.get(["drafts"]);
    if (!drafts.length) { draftsEl.textContent = "No drafts yet."; return; }
    const d = drafts[0];
    const when = new Date(d.ts).toLocaleString();
    draftsEl.innerHTML = `<b>${d.topic}</b> — <span class="muted">${when}</span><br>1) ${d.options?.[0] || ""}<br>2) ${d.options?.[1] || ""}<br>3) ${d.options?.[2] || ""}`;
}

// ===== Drafts Manager (full list with actions) =====
async function renderDraftsList() {
    const { drafts = [] } = await chrome.storage.local.get(["drafts"]);
    if (!drafts.length) { draftsListEl.textContent = "No drafts yet."; return; }

    draftsListEl.classList.add("draft-grid");
    draftsListEl.innerHTML = drafts.map((d, idx) => {
        const when = new Date(d.ts).toLocaleString();
        const meta = `topic: “${escapeHtml(d.topic)}” • ${d.platform || "twitter"} • ${d.tone || "punchy"} • ${when}`;
        const variants = (d.options || []).map((t, vi) => `
      <div class="variant">
        <div>${escapeHtml(t)}</div>
        <div class="variant-actions">
          <button class="primary" data-action="post" data-index="${idx}" data-vi="${vi}">Post this</button>
          <button class="ghost" data-action="copy" data-index="${idx}" data-vi="${vi}">Copy</button>
        </div>
      </div>
    `).join("");

        return `
      <div class="draft-card" data-id="${d.id || ''}">
        <div class="draft-meta">${meta}</div>
        ${variants}
        <div class="variant-actions">
          <button class="ghost" data-action="delete" data-index="${idx}">Delete draft</button>
        </div>
      </div>
    `;
    }).join("");
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}

draftsListEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const action = btn.dataset.action;
    const idx = Number(btn.dataset.index);
    const vi  = Number(btn.dataset.vi || 0);

    const store = await chrome.storage.local.get(["drafts","postMethod"]);
    const drafts = store.drafts || [];
    const method = store.postMethod || "intent";

    if (action === "delete") {
        drafts.splice(idx, 1);
        await chrome.storage.local.set({ drafts });
        await renderDraftsList();
        await renderLatestDraft();
        toast("Draft deleted");
        return;
    }

    const d = drafts[idx];
    if (!d) return;

    if (action === "copy") {
        await navigator.clipboard.writeText(d.options[vi]);
        toast("Copied");
        return;
    }

    if (action === "post") {
        const text = d.options[vi];
        const res = await chrome.runtime.sendMessage({ type: "SPARK_POST_TEXT", text, method });
        toast(res?.ok ? "Posted (or composer opened)" : `Post failed: ${res?.error || "Unknown error"}`, !!res?.ok);
    }
});

// Delete all drafts
btnDeleteAll.addEventListener("click", async () => {
    const { drafts = [] } = await chrome.storage.local.get(["drafts"]);
    if (!drafts.length) return toast("No drafts to delete");
    if (!confirm("Delete all drafts?")) return;
    await chrome.storage.local.set({ drafts: [] });
    await renderDraftsList();
    await renderLatestDraft();
    toast("All drafts deleted");
});

// Update drafts live
chrome.storage.onChanged.addListener((changes) => {
    if (changes.drafts) { renderLatestDraft(); renderDraftsList(); }
});

// If we’re opened as a tab with #drafts, show drafts view immediately
if (location.hash === "#drafts") {
    showView("drafts");
}

// ===== Compose actions =====
document.getElementById("btn-generate").onclick = async () => {
    try {
        setLoading(true, "Generating…");
        const platform = platformEl.value;
        const tone = toneEl.value;           // <-- FIXED LINE
        const clean = cleanEl.checked;

        let idea = inputEl.value.trim();
        if (!idea) { const sel = await getSelection(); idea = sel?.text || ""; }
        if (!idea) { outEl.textContent = "Type an idea or select text on the page."; return; }

        const hints = platformHints(platform);
        const session = await ensurePromptSession();

        const system = buildSystemPrompt(tone, hints, clean);
        const user = `Create a ${platform} post from this idea:\n"""${idea}"""`;

        const res = await promptWithOutput(
            session, [{ role: "system", content: system }, { role: "user", content: user }]
        );
        const finalText = withLimit(res);
        outEl.textContent = finalText;
        updateCounter(finalText);
        document.getElementById("variantsBar").style.display = "none";
        toast("Caption ready");
    } catch (e) { console.error(e); outEl.textContent = `Error: ${e.message}`; toast(e.message, false); }
    finally { setLoading(false); }
};

document.getElementById("btn-variants").onclick = async () => {
    try {
        setLoading(true, "Generating variants…");
        const platform = platformEl.value;
        const tone = toneEl.value;
        const clean = cleanEl.checked;

        let idea = inputEl.value.trim();
        if (!idea) { const sel = await getSelection(); idea = sel?.text || ""; }
        if (!idea) { outEl.textContent = "Type an idea or select text on the page."; return; }

        const hints = platformHints(platform);
        const session = await ensurePromptSession();

        const system = buildSystemPrompt(tone, hints, clean);
        const user = `Create three diverse ${platform} posts from this idea:\n"""${idea}"""`;

        const schema = {
            type: "object",
            properties: { options: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 } },
            required: ["options"], additionalProperties: false
        };

        const json = await promptJSON(session, system, user, schema, "en");
        let opts = Array.isArray(json?.options) ? json.options : String(json).split(/\n+/).filter(Boolean).slice(0,3);
        while (opts.length < 3) opts.push("—");
        opts = opts.map(withLimit);

        window.__spark_variants = opts;

        outEl.textContent = `1) ${opts[0]}\n\n2) ${opts[1]}\n\n3) ${opts[2]}`;
        updateCounter(outEl.textContent.replace(/^1\)\s*/,"").split("\n\n")[0] || "");
        document.getElementById("variantsBar").style.display = "flex";
        toast("3 variants ready");
    } catch (e) { console.error(e); outEl.textContent = `Error: ${e.message}`; toast(e.message, false); document.getElementById("variantsBar").style.display = "none"; }
    finally { setLoading(false); }
};
["pick1","pick2","pick3"].forEach((id, idx) => {
    document.getElementById(id).onclick = () => {
        const opts = window.__spark_variants || [];
        const chosen = opts[idx] || "";
        outEl.textContent = chosen;
        updateCounter(chosen);
        document.getElementById("variantsBar").style.display = "none";
    };
});

document.getElementById("btn-rewrite").onclick = async () => {
    try {
        setLoading(true, "Rewriting…");
        const platform = platformEl.value;
        const tone = toneEl.value;
        const clean = cleanEl.checked;

        const text = inputEl.value.trim() || outEl.textContent.trim();
        if (!text) { outEl.textContent = "Nothing to rewrite."; return; }
        const hints = platformHints(platform);
        const session = await ensurePromptSession();

        const system = buildSystemPrompt(tone, hints, clean);
        const user = `Rewrite the following text for ${platform} while preserving meaning:\n${text}`;

        const res = await promptWithOutput(
            session, [{ role: "system", content: system }, { role: "user", content: user }]
        );
        const finalText = withLimit(res);
        outEl.textContent = finalText;
        updateCounter(finalText);
        document.getElementById("variantsBar").style.display = "none";
        toast("Rewritten");
    } catch (e) { console.error(e); outEl.textContent = `Error: ${e.message}`; toast(e.message, false); }
    finally { setLoading(false); }
};

document.getElementById("btn-hashtags").onclick = async () => {
    try {
        setLoading(true, "Finding hashtags…");
        const platform = platformEl.value;
        const base = inputEl.value.trim() || outEl.textContent.trim();
        if (!base) { outEl.textContent = "Generate a caption first, then add hashtags."; return; }
        const session = await ensurePromptSession();
        const schema = { type: "object", properties: { tags: { type: "array", items: { type: "string" }, maxItems: 10 } }, required: ["tags"], additionalProperties: false };
        const system = `Return compact JSON only with a 'tags' array of up to 10 platform-appropriate hashtags. No explanations.`;
        const user = `Suggest hashtags for ${platform} for this text:\n${base}`;

        const json = await promptJSON(session, system, user, schema, "en");
        const tags = Array.isArray(json?.tags) ? json.tags.map(t => `#${t.replace(/^#/, "")}`) : [];
        outEl.textContent = tags.length ? tags.join(" ") : String(json);
        updateCounter(outEl.textContent);
        document.getElementById("variantsBar").style.display = "none";
        toast("Hashtags added");
    } catch (e) { console.error(e); outEl.textContent = `Error: ${e.message}`; toast(e.message, false); }
    finally { setLoading(false); }
};

document.getElementById("btn-summarize").onclick = async () => {
    try {
        setLoading(true, "Summarizing…");
        if (!("Summarizer" in self)) { outEl.textContent = "Summarizer API not available in this browser."; return; }
        const { text } = await getPageText();
        if (!text) { outEl.textContent = "No readable text detected on this page."; return; }

        const availability = await Summarizer.availability();
        if (availability === "unavailable") { outEl.textContent = "Summarizer unavailable on this device."; return; }

        const head = await Summarizer.create({ type: "headline", length: "short" });
        const headline = await head.summarize(text);
        const teaserSummarizer = await Summarizer.create({ type: "teaser", length: "short" });
        const teaser = await teaserSummarizer.summarize(text);

        const combo = `Headline: ${headline}\n\nTeaser: ${teaser}`;
        outEl.textContent = combo;
        updateCounter(combo);
        document.getElementById("variantsBar").style.display = "none";
        toast("Summary ready");
    } catch (e) { console.error(e); outEl.textContent = `Error: ${e.message}`; toast(e.message, false); }
    finally { setLoading(false); }
};

document.getElementById("btn-translate").onclick = async () => {
    try {
        const last = (await new Promise(r => chrome.storage?.local.get(["lastTranslateTarget"], r)))?.lastTranslateTarget || "fr";
        const target = prompt("Translate to (e.g., en, es, ja, fr, de, zh):", last) || last;
        chrome.storage?.local.set({ lastTranslateTarget: target });

        setLoading(true, `Translating → ${target}…`);
        const text = inputEl.value.trim() || outEl.textContent.trim();
        if (!text) { outEl.textContent = "Nothing to translate."; return; }

        const session = await ensurePromptSession();
        const res = await promptWithOutput(
            session,
            `Translate the following text. Output only the translation with no extra commentary:\n${text}`,
            { output: { language: target } }
        );
        outEl.textContent = res;
        updateCounter(res);
        document.getElementById("variantsBar").style.display = "none";
        toast("Translated");
    } catch (e) { console.error(e); outEl.textContent = `Error: ${e.message}`; toast(e.message, false); }
    finally { setLoading(false); }
};

document.getElementById("btn-copy").onclick = async () => {
    try { const text = outEl.textContent.trim(); if (!text) return toast("Nothing to copy", false); await navigator.clipboard.writeText(text); toast("Copied"); }
    catch (e) { console.error(e); toast("Copy failed", false); }
};

document.getElementById("btn-insert").onclick = async () => {
    try { const text = outEl.textContent.trim(); if (!text) return toast("Nothing to insert", false); const { success } = await insertToPage(text); toast(success ? "Inserted into page" : "Focus a text field first", success); }
    catch (e) { console.error(e); toast("Insert failed", false); }
};

// ===== Agent controls =====
document.getElementById("btn-save-agent").onclick = async () => {
    saveSettings();
    chrome.runtime.sendMessage({ type: "SPARK_AGENT_RESCHEDULE" });
    toast("Agent settings saved");
};
document.getElementById("btn-run-agent").onclick = async () => {
    // Show spinner + status
    setLoading(true, "Running agent…");

    chrome.runtime.sendMessage({ type: "SPARK_AGENT_RUN_ONCE" }, (resp) => {
        if (resp?.ok) {
            toast("Agent run completed");
            statusEl.textContent = "Agent running in background…";
        } else {
            toast(resp?.error || "Agent run failed", false);
            statusEl.textContent = "Error running agent";
        }
        // Restore spinner/buttons
        setLoading(false, "Ready");
    });
};

agentEnabledEl.addEventListener("change", () => { saveSettings(); chrome.runtime.sendMessage({ type: "SPARK_AGENT_RESCHEDULE" }); });
agentFrequencyEl.addEventListener("change", () => { saveSettings(); chrome.runtime.sendMessage({ type: "SPARK_AGENT_RESCHEDULE" }); });
agentTopicEl.addEventListener("change", saveSettings);

// ===== Post settings + connect/disconnect =====
postMethodEl.addEventListener("change", saveSettings);
autoPostEl.addEventListener("change", saveSettings);

btnConnectX.onclick = () => {
    chrome.runtime.sendMessage({ type: "X_OAUTH_CONNECT" }, (resp) => {
        if (resp?.ok) {
            chrome.storage.local.set({ xConnected: true, xUser: resp.user || "" });
            xStatusEl.textContent = `Connected${resp.user ? " as @" + resp.user : ""}`;
            toast("Connected to X");
        } else {
            toast(resp?.error || "Connect failed", false);
        }
    });
};
btnDisconnectX.onclick = () => {
    chrome.storage.local.remove(["xAccessToken","xRefreshToken","xConnected","xUser"], () => {
        xStatusEl.textContent = "Not connected";
        toast("Disconnected");
    });
};

// Keep drafts UI in sync
chrome.storage.onChanged.addListener((changes) => {
    if (changes.drafts) { renderLatestDraft(); renderDraftsList(); }
});
