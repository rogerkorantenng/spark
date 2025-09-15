// Capture selected text and provide a simple page text extractor.

let lastSelection = "";

document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    lastSelection = sel ? sel.toString().trim() : "";
});

function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
        const type = el.type?.toLowerCase();
        return !["button","checkbox","radio","submit","reset","file","image","range","color","date","datetime-local","month","time","week","hidden"].includes(type);
    }
    if (el.isContentEditable) return true;
    return false;
}

function insertAtCursor(el, text) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();

    if (tag === "textarea" || tag === "input") {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        const before = el.value.slice(0, start);
        const after  = el.value.slice(end);
        el.value = before + text + after;
        const caret = start + text.length;
        el.setSelectionRange(caret, caret);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
    }

    if (el.isContentEditable) {
        el.focus();
        const sel = window.getSelection();
        if (!sel.rangeCount) {
            el.textContent = (el.textContent || "") + text;
            return true;
        }
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
    }
    return false;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "GET_SELECTION") {
        sendResponse({ text: lastSelection });
        return true;
    }
    if (msg?.type === "GET_PAGE_TEXT") {
        const root = document.querySelector("article") || document.body;
        const text = root?.innerText?.trim() || "";
        sendResponse({ text });
        return true;
    }
    if (msg?.type === "INSERT_TEXT") {
        const active = document.activeElement;
        const ok = isEditable(active) ? insertAtCursor(active, msg.text || "") : false;
        sendResponse({ success: ok });
        return true;
    }
    return false;
});
