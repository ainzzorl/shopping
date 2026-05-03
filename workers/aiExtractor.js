const fs = require("fs").promises;

const PROMPT_VERSION = "v2";

const DEFAULTS = {
  baseUrl: process.env.AI_VISION_BASE_URL || "http://framework-desktop.local:1234/v1",
  apiKey: process.env.AI_VISION_API_KEY || "lm-studio",
  model: process.env.AI_VISION_MODEL || "qwen/qwen3-vl-4b",
  timeoutMs: parseInt(process.env.AI_VISION_TIMEOUT_MS, 10) || 120000,
  maxBytes: parseInt(process.env.AI_VISION_MAX_BYTES, 10) || 8 * 1024 * 1024,
  responseFormatMode: process.env.AI_VISION_RESPONSE_FORMAT || "json_schema",
};

const SYSTEM_PROMPT = `You are a precise data extractor for retail product page screenshots.
Return ONLY a JSON object matching this schema, no prose, no markdown:
{
  "price": number | null,
  "in_stock": boolean | null,
  "available": boolean | null
}
Field definitions:
- price: current selling price in the page's primary currency, as a decimal number (no currency symbol, no thousands separators). Use the sale/current price if both list and sale are shown. null if no price is visible or you are unsure.
- in_stock: false ONLY if the listing exists but says out of stock / sold out / temporarily unavailable / notify-me. true if buy/add-to-cart is visible or stock is implied. null if unclear.
- available: false ONLY if the product no longer exists in the catalog: 404, "no longer available", "discontinued", "page not found". true if the listing renders normally. null if unclear.
Rules:
- in_stock is temporary; available is permanent removal — never conflate them.
- If list and sale prices are shown, return what the customer pays now.
- Ignore prices for related/recommended items, shipping, taxes, and subscription tiers unless that is the only price shown.
- IGNORE installment / "buy now, pay later" amounts. Phrases like "4 interest-free payments of $X", "or 4 payments of $X", "as low as $X/mo", "from $X/month", "Afterpay", "Klarna", "Affirm", "Zip", "Sezzle", "Apple Pay Later", or "Pay in 4" indicate a financing breakdown — the $X there is one installment, NOT the product price. The full price is shown elsewhere on the page; use that. If the only price visible on the page is an installment amount, return null rather than guessing the total.
- Never invent a price. When unsure, use null.`;

const RESPONSE_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "product_extraction",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["price", "in_stock", "available"],
      properties: {
        price: { type: ["number", "null"] },
        in_stock: { type: ["boolean", "null"] },
        available: { type: ["boolean", "null"] },
      },
    },
  },
};

function buildPrompt({ url, itemName } = {}) {
  const lines = ["Extract from this product page screenshot."];
  if (url) lines.push(`URL: ${url}`);
  if (itemName) lines.push(`Item: ${itemName}`);
  lines.push("Return JSON only.");
  return lines.join("\n");
}

async function loadImage(input, maxBytes) {
  let buffer;
  if (Buffer.isBuffer(input)) {
    buffer = input;
  } else if (typeof input === "string") {
    buffer = await fs.readFile(input);
  } else {
    throw new Error("input must be a file path or Buffer");
  }
  if (buffer.length > maxBytes) {
    const err = new Error(
      `image_too_large: ${buffer.length} > ${maxBytes} bytes`
    );
    err.code = "image_too_large";
    throw err;
  }
  return buffer;
}

function coerceResult(parsed) {
  const out = { price: null, in_stock: null, available: null };
  if (!parsed || typeof parsed !== "object") return out;

  const p = parsed.price;
  if (typeof p === "number" && Number.isFinite(p)) {
    out.price = p;
  } else if (typeof p === "string") {
    const cleaned = p.replace(/[^\d.\-]/g, "");
    const num = parseFloat(cleaned);
    if (!isNaN(num)) out.price = num;
  }

  for (const key of ["in_stock", "available"]) {
    const v = parsed[key];
    if (typeof v === "boolean") {
      out[key] = v;
    } else if (typeof v === "string") {
      const lower = v.toLowerCase();
      if (lower === "true") out[key] = true;
      else if (lower === "false") out[key] = false;
    }
  }
  return out;
}

function parseResponse(raw) {
  try {
    return { parsed: JSON.parse(raw), error: null };
  } catch (_) {
    // attempt to salvage by slicing between first { and last }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return { parsed: JSON.parse(raw.slice(start, end + 1)), error: null };
      } catch (_) {
        // fall through
      }
    }
    return { parsed: null, error: "invalid_json" };
  }
}

function buildBody({ model, messages, responseFormatMode }) {
  const body = {
    model,
    messages,
    temperature: 0,
    max_tokens: 256,
  };
  if (responseFormatMode === "json_schema") {
    body.response_format = RESPONSE_SCHEMA;
  } else if (responseFormatMode === "json_object") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

function collectErrorCodes(err) {
  const codes = new Set();
  const visit = (e) => {
    if (!e) return;
    if (e.code) codes.add(e.code);
    if (Array.isArray(e.errors)) e.errors.forEach(visit);
    if (e.cause) visit(e.cause);
  };
  visit(err);
  return codes;
}

async function callApi({ baseUrl, apiKey, body, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function extractFromScreenshot(input, opts = {}) {
  const cfg = {
    baseUrl: opts.baseUrl || DEFAULTS.baseUrl,
    apiKey: opts.apiKey || DEFAULTS.apiKey,
    model: opts.model || DEFAULTS.model,
    timeoutMs: opts.timeoutMs || DEFAULTS.timeoutMs,
    maxBytes: opts.maxBytes || DEFAULTS.maxBytes,
    responseFormatMode:
      opts.responseFormatMode || DEFAULTS.responseFormatMode,
  };

  const t0 = Date.now();
  const baseResult = {
    price: null,
    in_stock: null,
    available: null,
    raw: "",
    model: cfg.model,
    latency_ms: 0,
  };

  let buffer;
  try {
    buffer = await loadImage(input, cfg.maxBytes);
  } catch (e) {
    if (e.code === "image_too_large") {
      return {
        ...baseResult,
        latency_ms: Date.now() - t0,
        error: "image_too_large",
      };
    }
    throw e;
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: buildPrompt(opts) },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${buffer.toString("base64")}`,
          },
        },
      ],
    },
  ];

  let responseFormatMode = cfg.responseFormatMode;
  let fellBack = false;
  let apiResp;

  for (let attempt = 0; attempt < 2; attempt++) {
    const body = buildBody({ model: cfg.model, messages, responseFormatMode });
    try {
      apiResp = await callApi({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        body,
        timeoutMs: cfg.timeoutMs,
        signal: opts.signal,
      });
    } catch (e) {
      const latency_ms = Date.now() - t0;
      if (e.name === "AbortError") {
        return { ...baseResult, latency_ms, error: "timeout" };
      }
      const codes = collectErrorCodes(e);
      if (codes.has("ECONNREFUSED")) {
        return { ...baseResult, latency_ms, error: "connection_refused" };
      }
      if (codes.has("ENOTFOUND")) {
        return { ...baseResult, latency_ms, error: "dns_not_found" };
      }
      return {
        ...baseResult,
        latency_ms,
        error: `fetch_error: ${e.message}`,
      };
    }

    if (apiResp.status >= 200 && apiResp.status < 300) break;

    const looksLikeSchemaIssue =
      apiResp.status === 400 &&
      responseFormatMode === "json_schema" &&
      /response_format|json_schema/i.test(apiResp.text);

    if (looksLikeSchemaIssue && attempt === 0) {
      responseFormatMode = "json_object";
      fellBack = true;
      continue;
    }

    return {
      ...baseResult,
      raw: apiResp.text,
      latency_ms: Date.now() - t0,
      error: `http_${apiResp.status}`,
    };
  }

  let payload;
  try {
    payload = JSON.parse(apiResp.text);
  } catch (e) {
    return {
      ...baseResult,
      raw: apiResp.text,
      latency_ms: Date.now() - t0,
      error: "invalid_envelope_json",
    };
  }

  const content = payload?.choices?.[0]?.message?.content ?? "";
  const rawText = typeof content === "string" ? content : JSON.stringify(content);

  const { parsed, error: parseError } = parseResponse(rawText);
  const coerced = coerceResult(parsed);

  return {
    ...coerced,
    raw: rawText,
    model: cfg.model,
    latency_ms: Date.now() - t0,
    ...(parseError ? { error: parseError } : {}),
    ...(fellBack && !parseError ? { error: "fallback_json_object" } : {}),
  };
}

module.exports = {
  extractFromScreenshot,
  buildPrompt,
  PROMPT_VERSION,
};
