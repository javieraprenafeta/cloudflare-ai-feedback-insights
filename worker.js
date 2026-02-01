export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // UI (homepage)
    if (url.pathname === "/") {
      return new Response(renderHTML(url.origin), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/products") {
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT product FROM feedback ORDER BY product ASC"
      ).all();
      return json({ products: results.map((r) => r.product) });
    }

    if (url.pathname === "/api/feedback") {
      const product = (url.searchParams.get("product") || "all").toLowerCase();

      let stmt;
      if (product === "all") {
        stmt = env.DB.prepare(
          "SELECT id, product, source, comment, created_at FROM feedback ORDER BY id DESC"
        );
      } else {
        stmt = env.DB.prepare(
          "SELECT id, product, source, comment, created_at FROM feedback WHERE lower(product)=? ORDER BY id DESC"
        ).bind(product);
      }

      const { results } = await stmt.all();
      return json({ product, count: results.length, results });
    }

    if (url.pathname === "/api/insights") {
      const product = (url.searchParams.get("product") || "all").toLowerCase();

      let stmt;
      if (product === "all") {
        stmt = env.DB.prepare(
          "SELECT product, source, comment FROM feedback ORDER BY id DESC"
        );
      } else {
        stmt = env.DB.prepare(
          "SELECT product, source, comment FROM feedback WHERE lower(product)=? ORDER BY id DESC"
        ).bind(product);
      }

      const { results } = await stmt.all();

      if (product === "all") {
        const grouped = groupBy(results, (r) => r.product);
        const insightsByProduct = {};

        for (const [prod, rows] of Object.entries(grouped)) {
          const items = rows.map((r) => ({ source: r.source, comment: r.comment }));
          insightsByProduct[prod] = await analyzeFeedback(env, prod, items);
        }

        return json({ scope: "all", insightsByProduct });
      }

      const items = results.map((r) => ({ source: r.source, comment: r.comment }));
      const analysis = await analyzeFeedback(env, product, items);
      return json({ scope: product, ...analysis });
    }

    return new Response("Not found", { status: 404 });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const key = keyFn(item);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

/**
 * Uses Workers AI to generate insights. Falls back to a simulated analyzer if:
 * - billing is required
 * - model access fails
 * - AI output isn't valid JSON
 */
async function analyzeFeedback(env, product, items) {
  if (!items.length) {
    return {
      analysis_mode: "empty",
      positive_count: 0,
      negative_count: 0,
      positive_keywords: [],
      negative_keywords: [],
      positive_summary: ["No feedback found."],
      negative_summary: ["No feedback found."],
    };
  }

  const commentsBlock = items
    .map((x, i) => `${i + 1}. [source=${x.source}] ${x.comment}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You analyze user feedback about a Cloudflare product and return structured insights.",
    },
    {
      role: "user",
      content: `
Product: ${product}

Return structured insights following the JSON schema. Use ONLY the feedback provided.

Feedback:
${commentsBlock}
`.trim(),
    },
  ];

  const schema = {
    type: "object",
    properties: {
      positive_summary: { type: "array", items: { type: "string" } },
      negative_summary: { type: "array", items: { type: "string" } },
      positive_keywords: { type: "array", items: { type: "string" } },
      negative_keywords: { type: "array", items: { type: "string" } },
    },
    required: [
      "positive_summary",
      "negative_summary",
      "positive_keywords",
      "negative_keywords",
    ],
  };

  try {
    const result = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
      messages,
      response_format: {
        type: "json_schema",
        json_schema: schema,
      },
      max_tokens: 500,
      temperature: 0,
    });

    const payload =
      (result && result.response) ||
      (typeof result === "string" ? safeJsonParse(result) : null);

    if (!payload) throw new Error("Workers AI returned no JSON payload.");

    return {
      analysis_mode: "workers_ai",
      positive_summary: payload.positive_summary || [],
      negative_summary: payload.negative_summary || [],
      positive_keywords: payload.positive_keywords || [],
      negative_keywords: payload.negative_keywords || [],
    };
  } catch (err) {
    const simulated = simulateAnalysis(items.map((x) => x.comment));
    return {
      analysis_mode: "simulated_fallback",
      fallback_reason: String(err && err.message ? err.message : err),
      ...simulated,
    };
  }
}

function safeJsonParse(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const unfenced = text
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {}

  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = unfenced.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

function simulateAnalysis(comments) {
  const POS = [
    "fast","easy","love","great","helpful","impressed","clear",
    "scalable","affordable","useful","transparent","responsive","smooth","good",
  ];
  const NEG = [
    "confusing","unclear","bug","slow","hard","lacking","limited",
    "outdated","missing","inconsistent","expensive","unexpected","difficult","vague",
  ];

  const positive = [];
  const negative = [];

  for (const c of comments) {
    const t = c.toLowerCase();
    const posScore = POS.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    const negScore = NEG.reduce((s, w) => s + (t.includes(w) ? 1 : 0), 0);
    if (negScore > posScore) negative.push(c);
    else positive.push(c);
  }

  const positive_keywords = topKeywords(positive.join(" "));
  const negative_keywords = topKeywords(negative.join(" "));

  return {
    positive_count: positive.length,
    negative_count: negative.length,
    positive_keywords,
    negative_keywords,
    positive_summary: [
      "Users highlight strengths and positive experiences.",
      "Top themes: " + (positive_keywords.slice(0, 5).join(", ") || "none"),
    ],
    negative_summary: [
      "Users mention pain points and areas for improvement.",
      "Top themes: " + (negative_keywords.slice(0, 5).join(", ") || "none"),
    ],
  };
}

function topKeywords(text) {
  const STOP = new Set([
    "the","and","is","are","to","of","a","in","it","for","with","how","i",
    "was","be","very","not","this","that","as","on","at","by","an","or",
    "from","they","we","you","my","our","your","their","sometimes",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w.length >= 4 && !STOP.has(w));

  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);
}

function renderHTML(origin) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Feedback Insights</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, Arial; margin: 24px; line-height: 1.4; }
    .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; max-width: 980px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    button {
      padding: 10px 14px;
      border-radius: 10px;
      border: none;
      background: #374151;   /* gris oscuro */
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover {
      background: #1f2933;
    }
    button:disabled {
      background: #9ca3af;
      cursor: not-allowed;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    h1 { margin: 0 0 12px 0; font-size: 22px; }
    h2 { margin: 0 0 8px 0; font-size: 16px; }
    ul { margin: 8px 0 0 18px; }
    .muted { color: #6b7280; font-size: 13px; }
    pre { background: #0b1020; color: #e5e7eb; padding: 12px; border-radius: 12px; overflow: auto; }
    .pill { display:inline-block; padding: 4px 10px; border-radius: 999px; border: 1px solid #e5e7eb; margin: 6px 6px 0 0; }
    a { color: inherit; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="card">
    <h1>Feedback Insights Agent</h1>
    <div class="muted">D1 provides the feedback data. Workers AI generates structured insights.</div>

    <div class="row" style="margin-top: 14px;">
      <label for="product"><strong>Product</strong></label>
      <select id="product"></select>
      <button id="run">Generate insights</button>
      <span id="status" class="muted"></span>
    </div>

    <div id="result" class="grid" style="margin-top: 10px;"></div>


    <div class="muted" style="margin-top:12px;">
      Quick links:
      <a href="${origin}/health">/health</a> |
      <a href="${origin}/api/products">/api/products</a> |
      <a href="${origin}/api/insights?product=workers">/api/insights?product=workers</a>
    </div>
  </div>

<script>
  const $product = document.getElementById('product');
  const $run = document.getElementById('run');
  const $status = document.getElementById('status');
  const $result = document.getElementById('result');

  async function loadProducts() {
    const res = await fetch('/api/products');
    const data = await res.json();
    $product.innerHTML = (data.products || [])
      .map(p => \`<option value="\${p}">\${p}</option>\`)
      .join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function renderInsights(data) {
    const pos = (data.positive_summary || []).map(x => \`<li>\${escapeHtml(x)}</li>\`).join('');
    const neg = (data.negative_summary || []).map(x => \`<li>\${escapeHtml(x)}</li>\`).join('');

    const posKw = (data.positive_keywords || []).map(k => \`<span class="pill">\${escapeHtml(k)}</span>\`).join('');
    const negKw = (data.negative_keywords || []).map(k => \`<span class="pill">\${escapeHtml(k)}</span>\`).join('');

    $result.innerHTML = \`
      <div class="card" style="border-radius:12px;">
        <h2>Positive</h2>
        <div>\${posKw || '<span class="muted">No keywords</span>'}</div>
        <ul>\${pos || '<li class="muted">No positive summary</li>'}</ul>
      </div>
      <div class="card" style="border-radius:12px;">
        <h2>Negative</h2>
        <div>\${negKw || '<span class="muted">No keywords</span>'}</div>
        <ul>\${neg || '<li class="muted">No negative summary</li>'}</ul>
      </div>
    \`;
  }

  async function run() {
    const product = $product.value;
    $status.textContent = 'Running...';
    $run.disabled = true;

    try {
      const res = await fetch(\`/api/insights?product=\${encodeURIComponent(product)}\`);
      const data = await res.json();
      renderInsights(data);
      $status.textContent = \`Done (\${data.analysis_mode || 'unknown'})\`;
    } catch (e) {
      $status.textContent = 'Error';
    } finally {
      $run.disabled = false;
    }
  }

  $run.addEventListener('click', run);

  loadProducts().then(() => {
    if ($product.value) run();
  });
</script>
</body>
</html>`;
}
