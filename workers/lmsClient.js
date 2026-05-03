const DEFAULT_BASE_URL =
  process.env.LMS_BASE_URL || "http://framework-desktop.local:9247/lms";

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : "{}",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${url} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function startLmServer(baseUrl = DEFAULT_BASE_URL) {
  console.log("Starting LM server...");
  await postJson(`${baseUrl}/server/start`, null, 60_000);
}

async function loadModel(model, baseUrl = DEFAULT_BASE_URL) {
  console.log(`Loading model: ${model}`);
  await postJson(`${baseUrl}/load`, { model }, 300_000);
}

async function unloadModel(baseUrl = DEFAULT_BASE_URL) {
  console.log("Unloading model...");
  await postJson(`${baseUrl}/unload`, null, 60_000);
}

module.exports = {
  startLmServer,
  loadModel,
  unloadModel,
  DEFAULT_BASE_URL,
};
