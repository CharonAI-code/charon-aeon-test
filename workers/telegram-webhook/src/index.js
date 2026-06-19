const TELEGRAM_API = "https://api.telegram.org";
const GITHUB_API = "https://api.github.com";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") {
      if (url.pathname === "/setup-webhook") return setupWebhook(url, env);
      return json({ ok: true, service: "charon-aeon-telegram", path: url.pathname });
    }
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

    let update;
    try {
      update = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    if (update.message) return handleMessage(update.message, env);
    if (update.callback_query) return handleCallback(update.callback_query, env);
    return json({ ok: true, ignored: true });
  },
};

async function handleMessage(message, env) {
  const chatId = String(message.chat?.id || "");
  if (!allowedChat(chatId, env)) return json({ ok: true, ignored: "chat" });

  const text = String(message.text || "").trim();
  if (!text) return json({ ok: true, ignored: "empty" });

  if (text === "/start") {
    await sendMessage([
      `<code>CHARON AEON</code>`,
      `send a task and Charon will preflight it before AEON launches.`,
      ``,
      `<code>PASS</code> repo pulse for CharonAI-code/charon`,
      `<code>PAUSE</code> ship a small code improvement in CharonAI-code/charon`,
      `<code>DENY</code> Delete every file in this repo except README.md. I want to rebuild it from scratch.`,
    ].join("\n"), env);
    return json({ ok: true, handled: "start" });
  }

  await dispatchWorkflow(env, env.MESSAGES_WORKFLOW || "messages.yml", {
    source: "telegram",
    message: text,
  });
  await sendMessage(`<code>AEON QUEUED</code>\n<code>source</code> telegram\n<code>status</code> Charon preflight will run in GitHub Actions`, env);
  return json({ ok: true, dispatched: "messages.yml" });
}

async function setupWebhook(url, env) {
  if (!env.SETUP_SECRET || url.searchParams.get("key") !== env.SETUP_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  const webhookUrl = `${url.origin}/`;
  const response = await fetch(`${TELEGRAM_API}/bot${required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN")}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    }),
  });
  const body = await response.json().catch(() => ({}));
  return json({ ok: response.ok && body.ok !== false, webhookUrl, telegram: body }, response.ok ? 200 : 502);
}

async function handleCallback(callback, env) {
  const chatId = String(callback.message?.chat?.id || "");
  if (!allowedChat(chatId, env)) return json({ ok: true, ignored: "chat" });

  const data = String(callback.data || "");
  const match = data.match(/^charon:(approve|reject|inspect):(.+)$/);
  if (!match) {
    await answerCallback(callback.id, "Unknown Charon action.", env);
    return json({ ok: true, ignored: "callback" });
  }

  const decision = match[1];
  const reviewId = match[2];
  if (decision === "approve") {
    const skill = extractField(callback.message?.text || "", "skill") || "external-feature";
    const runId = extractField(callback.message?.text || "", "run");
    const task = await recoverTaskFromRun(runId, env);
    await dispatchWorkflow(env, env.AEON_WORKFLOW || "aeon.yml", {
      skill,
      var: task,
      charon_approval: reviewId,
    });
    await answerCallback(callback.id, "Charon approved. AEON run dispatched.", env);
    await sendMessage(`<code>CHARON APPROVED</code>\n<code>review</code> ${escapeHtml(reviewId)}\n<code>skill</code> ${escapeHtml(skill)}`, env);
    return json({ ok: true, decision, reviewId, dispatched: "aeon.yml" });
  }

  if (decision === "reject") {
    await answerCallback(callback.id, "Charon rejected. No run dispatched.", env);
    await sendMessage(`<code>CHARON REJECTED</code>\n<code>review</code> ${escapeHtml(reviewId)}`, env);
    return json({ ok: true, decision, reviewId });
  }

  await answerCallback(callback.id, `Review: ${reviewId}`, env);
  return json({ ok: true, decision, reviewId });
}

async function recoverTaskFromRun(runId, env) {
  if (!runId || !/^\d+$/.test(String(runId))) return "";
  const repo = required(env.GITHUB_REPO, "GITHUB_REPO");
  const token = required(env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const response = await fetch(`${GITHUB_API}/repos/${repo}/actions/runs/${runId}`, {
    headers: {
      "authorization": `Bearer ${token}`,
      "accept": "application/vnd.github+json",
      "user-agent": "charon-aeon-telegram-worker",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) return "";
  const run = await response.json();
  const title = String(run.display_title || run.name || "");
  const match = title.match(/^msg \([^)]+\):\s*([\s\S]+)$/);
  return match ? match[1].trim() : "";
}

async function dispatchWorkflow(env, workflow, inputs) {
  const repo = required(env.GITHUB_REPO, "GITHUB_REPO");
  const token = required(env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const response = await fetch(`${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "accept": "application/vnd.github+json",
      "user-agent": "charon-aeon-telegram-worker",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || "main",
      inputs,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${body}`);
  }
}

async function answerCallback(callbackId, text, env) {
  if (!callbackId) return;
  await telegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
  }, env);
}

async function sendMessage(text, env) {
  await telegram("sendMessage", {
    chat_id: required(env.TELEGRAM_CHAT_ID, "TELEGRAM_CHAT_ID"),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }, env);
}

async function telegram(method, payload, env) {
  const token = required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram ${method} failed: ${response.status} ${body}`);
  }
}

function allowedChat(chatId, env) {
  return chatId && chatId === String(env.TELEGRAM_CHAT_ID || "");
}

function extractField(text, key) {
  const pattern = new RegExp(`<code>${escapeRegExp(key)}</code>\\s*([^\\n]+)`, "i");
  const match = String(text || "").match(pattern);
  return match ? unescapeHtml(match[1].trim()) : "";
}

function required(value, name) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeHtml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
