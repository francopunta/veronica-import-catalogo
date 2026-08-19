import { getStore } from "@netlify/blobs";

function normalize(s = "") {
  return s
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchableText(p) {
  return normalize([
    p.nombre,
    p.categoria,
    p.descripcion,
    Array.isArray(p.specs) ? p.specs.join(" ") : p.specs,
    p.color,
    p.modelo,
    p.marca,
  ].filter(Boolean).join(" "));
}

const STOP = new Set([
  "TENEMOS","TENER","TIENE","HAY","ALGUN","ALGUNA","ALGUNOS","ALGUNAS","DE","DEL","LA","LAS","EL","LOS","UN","UNA","Y","O","EN","CON","PARA","QUE","ME","BUSCA","BUSCAME","QUIERO","NECESITO","DISPONIBLE","DISPONIBLES","STOCK"
]);

function rankProducts(products, question) {
  const q = normalize(question);
  const tokens = q.split(" ").filter(t => t.length > 1 && !STOP.has(t));
  const nums = tokens.filter(t => /^\d+$/.test(t));
  const words = tokens.filter(t => !/^\d+$/.test(t));

  return products
    .filter(p => !p.sinStock)
    .map(p => {
      const text = searchableText(p);
      let score = 0;
      for (const n of nums) if (text.includes(n)) score += 8;
      for (const w of words) {
        if (text.includes(w)) score += w.length >= 6 ? 4 : 2;
      }
      if (q && text.includes(q)) score += 15;
      return { p, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 24)
    .map(x => x.p);
}

function slimProduct(p) {
  return {
    nombre: p.nombre,
    categoria: p.categoria,
    contado: p.contado,
    precio3: p.precio3,
    precio6: p.precio6,
    sinStock: !!p.sinStock,
    descripcion: p.descripcion || "",
    specs: p.specs || [],
  };
}

async function callOpenAI({ question, mode, matches, lastCheck }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta configurar OPENAI_API_KEY en Netlify");

  const model = process.env.OPENAI_MODEL || "gpt-5.6";
  const isFlyer = mode === "flyer";

  const instructions = isFlyer
    ? `Sos el asistente creativo de Veronica Import. Escribís contenido breve para flyers de Instagram en español rioplatense, prolijo, comercial y natural. No inventes precios, stock, productos, medidas ni promociones. Si el pedido menciona un producto, usá solo los productos enviados como contexto. Devolvé SOLO JSON válido con estas claves: titulo, subtitulo, destacado, extra, cta. Cada campo debe ser corto. titulo máximo 5 palabras; subtitulo máximo 18; destacado máximo 10; extra máximo 12; cta máximo 12.`
    : `Sos el asistente interno de Veronica Import. Respondé en español rioplatense, claro y breve. Contestá solamente con información del catálogo que te doy. No inventes productos, medidas, colores, precios ni stock. Todos los productos del contexto están disponibles. Si no hay resultados suficientes para asegurar algo, decilo claramente. Cuando haya opciones, priorizá las más cercanas a lo pedido y podés mencionar contado y cuotas si ayuda.`;

  const payload = {
    model,
    store: false,
    instructions,
    input: JSON.stringify({
      pedido: question,
      modo: mode,
      ultima_actualizacion: lastCheck || null,
      productos_relevantes: matches.map(slimProduct),
    }),
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || "Error al consultar la IA");

  const text = (data.output || [])
    .flatMap(x => x.content || [])
    .filter(x => x.type === "output_text")
    .map(x => x.text)
    .join("")
    .trim();

  if (!isFlyer) return { text };

  try {
    return { flyer: JSON.parse(text) };
  } catch {
    return { flyer: { titulo: "", subtitulo: text, destacado: "", extra: "", cta: "" } };
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Usá POST" }), { status: 405, headers: jsonHeaders() });
  }

  try {
    const body = await req.json();
    const question = String(body?.pregunta || "").trim();
    const mode = body?.modo === "flyer" ? "flyer" : "catalogo";

    if (!question) {
      return new Response(JSON.stringify({ error: "Escribí una consulta" }), { status: 400, headers: jsonHeaders() });
    }

    const store = getStore("catalogo");
    const raw = await store.get("products.json");
    if (!raw) {
      return new Response(JSON.stringify({ error: "Catálogo no inicializado" }), { status: 503, headers: jsonHeaders() });
    }

    const products = JSON.parse(raw);
    const matches = rankProducts(products, question);

    let lastCheck = null;
    try {
      const lc = await store.get("last-check.json");
      if (lc) lastCheck = JSON.parse(lc);
    } catch {}

    const ai = await callOpenAI({ question, mode, matches, lastCheck });

    return new Response(JSON.stringify({
      ok: true,
      modo: mode,
      resultados: matches.length,
      productos: matches.slice(0, 8).map(slimProduct),
      ...ai,
    }), { status: 200, headers: jsonHeaders() });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || "Error inesperado" }), { status: 500, headers: jsonHeaders() });
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
  };
}

function jsonHeaders() {
  return {
    ...corsHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}
