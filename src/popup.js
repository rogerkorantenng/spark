const inputEl  = document.getElementById("input");
const outEl    = document.getElementById("out");
const statusEl = document.getElementById("status");
const platformEl = document.getElementById("platform");
const toneEl     = document.getElementById("tone");
const cleanEl    = document.getElementById("clean");
const counterEl  = document.getElementById("counter");
const agentEnabledEl   = document.getElementById("agentEnabled");
const agentFrequencyEl = document.getElementById("agentFrequency");
const agentTopicEl     = document.getElementById("agentTopic");

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
    counterEl.style.color = len > limit ? "#b91c1c" : "#444";
}

inputEl.addEventListener("input", () => updateCounter(inputEl.value));
platformEl.addEventListener("change", () => {
    saveSettings();
    updateCounter(outEl.textContent.trim() || inputEl.value);
});
toneEl.addEventListener("change", saveSettings);
cleanEl.addEventListener("change", saveSettings);

async function promptWithOutput(session, messagesOrText, opts = {}) {
    const base = { output: { language: "en" } };
    const options = { ...base, ...opts, output: { language: (opts.output && opts.output.language) || "en" } };
    return typeof messagesOrText === "string"
        ? session.prompt(messagesOrText, options)
        : session.prompt(messagesOrText, options);
}


async function ensurePromptSession(expectedInputs) {
    if (!("LanguageModel" in self)) throw new Error("Prompt API not found in this browser.");
    const avail = await LanguageModel.availability();
    statusEl.textContent = `Prompt API availability: ${avail}`;
    if (avail === "unavailable") throw new Error("Prompt API unavailable on this device.");

    return await LanguageModel.create({
        ...(expectedInputs ? { expectedInputs } : {}),
        monitor(m) {
            m.addEventListener("downloadprogress", (e) => {
                const pct = Math.round(e.loaded * 100);
                statusEl.textContent = `Downloading model… ${pct}%`;
            });
            m.addEventListener("downloadcomplete", () => {
                statusEl.textContent = "Model downloaded.";
            });
        }
    });
}

async function promptJSON(session, system, user, schema, language = "en") {
    const res = await promptWithOutput(
        session,
        [{ role: "system", content: system }, { role: "user", content: user }]
    );

    try { return JSON.parse(res); } catch { return res; }
}

// Init: capabilities + settings
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

    // Load saved settings
    chrome.storage?.local.get(
        ["platform","tone","clean","lastTranslateTarget","agentEnabled","agentFrequency","agentTopic"],
        (cfg) => {
            if (cfg?.platform) platformEl.value = cfg.platform;
            if (cfg?.tone) toneEl.value = cfg.tone;
            if (typeof cfg?.clean === "boolean") cleanEl.checked = cfg.clean;
            if (typeof cfg?.agentEnabled === "boolean") agentEnabledEl.checked = cfg.agentEnabled;
            if (cfg?.agentFrequency) agentFrequencyEl.value = String(cfg.agentFrequency);
            if (cfg?.agentTopic) agentTopicEl.value = cfg.agentTopic;
        }
    );
})();

function saveSettings(extra = {}) {
    const payload = {
        platform: platformEl.value,
        tone: toneEl.value,
        clean: cleanEl.checked,
        agentEnabled: agentEnabledEl.checked,
        agentFrequency: Number(agentFrequencyEl.value || 720),
        agentTopic: agentTopicEl.value.trim(),
        ...extra
    };
    chrome.storage?.local.set(payload);
}


function withLimit(text) {
    const { limit } = platformHints(platformEl.value);
    if ((text || "").length <= limit) return text;
    return text.slice(0, limit); // soft trim to stay within cap
}

function buildSystemPrompt(tone, hints, clean) {
    const cleanLine = clean
        ? "Ensure brand-safe, professional language; avoid profanity, slurs, sensitive claims, or misleading health/financial advice."
        : "";
    return `You are a social media copywriter. Write in ${tone} tone. Keep within ${hints.limit} characters. ${
        hints.addHashtags ? "Add relevant hashtags." : "Do not include hashtags."
    } Use ${hints.lineBreaks} line breaks. ${cleanLine} Output only the final caption.`;
}

// Buttons
document.getElementById("btn-generate").onclick = async () => {
    try {
        const platform = platformEl.value;
        const tone = toneEl.value;
        const clean = cleanEl.checked;

        let idea = inputEl.value.trim();
        if (!idea) { const sel = await getSelection(); idea = sel?.text || ""; }
        if (!idea) { outEl.textContent = "Type an idea or select text on the page."; return; }

        const hints = platformHints(platform);
        const session = await ensurePromptSession();

        const system = buildSystemPrompt(tone, hints, clean);
        const user = `Create a ${platform} post from this idea:\n"""${idea}"""`;

        const res = await promptWithOutput(
            session,
            [{ role: "system", content: system }, { role: "user", content: user }]
        );

        const finalText = withLimit(res);
        outEl.textContent = finalText;
        updateCounter(finalText);
        document.getElementById("variantsBar").style.display = "none";
    } catch (e) {
        console.error(e);
        outEl.textContent = `Error: ${e.message}`;
    }
};

document.getElementById("btn-save-agent").onclick = async () => {
    saveSettings();
    // Let background reschedule alarms
    chrome.runtime.sendMessage({ type: "SPARK_AGENT_RESCHEDULE" });
    statusEl.textContent = "Agent settings saved.";
    setTimeout(() => (statusEl.textContent = ""), 1200);
};

agentEnabledEl.addEventListener("change", () => {
    saveSettings();
    chrome.runtime.sendMessage({ type: "SPARK_AGENT_RESCHEDULE" });
});
agentFrequencyEl.addEventListener("change", () => {
    saveSettings();
    chrome.runtime.sendMessage({ type: "SPARK_AGENT_RESCHEDULE" });
});
agentTopicEl.addEventListener("change", saveSettings);


document.getElementById("btn-variants").onclick = async () => {
    try {
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
            properties: {
                options: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 }
            },
            required: ["options"],
            additionalProperties: false
        };

        const json = await promptJSON(session, system, user, schema, "en");
        let opts = Array.isArray(json?.options) ? json.options : [];
        if (opts.length !== 3) {
            // Fallback: try to split by newline
            opts = String(json).split(/\n+/).filter(Boolean).slice(0,3);
            while (opts.length < 3) opts.push("—");
        }
        // Trim to limits
        opts = opts.map(withLimit);

        // Stash on window for pickers
        window.__spark_variants = opts;

        outEl.textContent = `1) ${opts[0]}\n\n2) ${opts[1]}\n\n3) ${opts[2]}`;
        updateCounter(outEl.textContent.replace(/^1\)\s*/,"").split("\n\n")[0] || "");
        document.getElementById("variantsBar").style.display = "flex";
    } catch (e) {
        console.error(e);
        outEl.textContent = `Error: ${e.message}`;
        document.getElementById("variantsBar").style.display = "none";
    }
};

// Variant pickers
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
            session,
            [{ role: "system", content: system }, { role: "user", content: user }]
        );

        const finalText = withLimit(res);
        outEl.textContent = finalText;
        updateCounter(finalText);
        document.getElementById("variantsBar").style.display = "none";
    } catch (e) {
        console.error(e);
        outEl.textContent = `Error: ${e.message}`;
    }
};

document.getElementById("btn-hashtags").onclick = async () => {
    try {
        const platform = platformEl.value;
        const base = inputEl.value.trim() || outEl.textContent.trim();
        if (!base) { outEl.textContent = "Generate a caption first, then add hashtags."; return; }
        const session = await ensurePromptSession();
        const schema = {
            type: "object",
            properties: { tags: { type: "array", items: { type: "string" }, maxItems: 10 } },
            required: ["tags"], additionalProperties: false
        };
        const system = `Return compact JSON only with a 'tags' array of up to 10 platform-appropriate hashtags. No explanations.`;
        const user = `Suggest hashtags for ${platform} for this text:\n${base}`;

        const json = await promptJSON(session, system, user, schema, "en");
        const tags = Array.isArray(json?.tags) ? json.tags.map(t => `#${t.replace(/^#/, "")}`) : [];
        outEl.textContent = tags.length ? tags.join(" ") : String(json);
        updateCounter(outEl.textContent);
        document.getElementById("variantsBar").style.display = "none";
    } catch (e) {
        console.error(e);
        outEl.textContent = `Error: ${e.message}`;
    }
};

document.getElementById("btn-summarize").onclick = async () => {
    try {
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
    } catch (e) {
        console.error(e);
        outEl.textContent = `Error: ${e.message}`;
    }
};

document.getElementById("btn-translate").onclick = async () => {
    try {
        const last = (await new Promise(r => chrome.storage?.local.get(["lastTranslateTarget"], r)))?.lastTranslateTarget || "fr";
        const target = prompt("Translate to (e.g., en, es, ja, fr, de, zh):", last) || last;
        saveSettings({ lastTranslateTarget: target });

        const text = inputEl.value.trim() || outEl.textContent.trim();
        if (!text) { outEl.textContent = "Nothing to translate."; return; }

        const session = await ensurePromptSession();
        const res = await promptWithOutput(
            session,
            `Translate this:\n${text}`,
            { output: { language: target } }
        );
        outEl.textContent = res;
        updateCounter(res);
        document.getElementById("variantsBar").style.display = "none";
    } catch (e) {
        console.error(e);
        outEl.textContent = `Error: ${e.message}`;
    }
};

document.getElementById("btn-copy").onclick = async () => {
    try {
        const text = outEl.textContent.trim();
        if (!text) { statusEl.textContent = "Nothing to copy."; return; }
        await navigator.clipboard.writeText(text);
        statusEl.textContent = "Copied to clipboard.";
        setTimeout(() => (statusEl.textContent = ""), 1200);
    } catch (e) {
        console.error(e);
        statusEl.textContent = `Copy failed: ${e.message}`;
    }
};

document.getElementById("btn-insert").onclick = async () => {
    try {
        const text = outEl.textContent.trim();
        if (!text) { statusEl.textContent = "Nothing to insert."; return; }
        const { success } = await insertToPage(text);
        statusEl.textContent = success ? "Inserted into page." : "Focus a text field first, then try again.";
        setTimeout(() => (statusEl.textContent = ""), 1500);
    } catch (e) {
        console.error(e);
        statusEl.textContent = `Insert failed: ${e.message}`;
    }
};
