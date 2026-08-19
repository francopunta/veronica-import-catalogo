import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";

function normalize(s = "") {
  return String(s)
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
  "HOLA","BUENAS","BUEN","DIA","TARDE","NOCHE","TENEMOS","TENER","TIENE","HAY","ALGUN","ALGUNA","ALGUNOS","ALGUNAS","DE","DEL","LA","LAS","EL","LOS","UN","UNA","Y","O","EN","CON","PARA","QUE","ME","BUSCA","BUSCAME","QUIERO","NECESITO","DISPONIBLE","DISPONIBLES","STOCK","PRECIO","CUANTO","SALE","VALE"
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
      for (const w of words) if (text.includes(w)) score += w.length >= 6 ? 4 : 2;
      if (q && text.includes(q)) score += 15;
      return { p, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 18)
    .map(x => x.p);
}

function slimProduct(p) {
  return {
    nombre: p.nombre,
    categoria: p.categoria,
    contado: p.contado,
    precio3: p.precio3,
    precio6: p.precio6,
    descripcion: p.descripcion || "",
    specs: p.specs || [],
  };
}

function wantsHuman(text) {
  const t = normalize(text);
  return [
    "QUIERO COMPRAR", "LO QUIERO", "ME LO LLEVO", "QUIERO PAGAR", "COMO PAGO",
    "FORMA DE PAGO", "DATOS PARA PAGAR", "ALIAS", "TRANSFERENCIA", "RESERVAR",
    "CERRAR COMPRA", "FINALIZAR COMPRA", "SEÑA", "SENA"
  ].some(x => t.includes(x));
}

function verifySignature(rawBody, signature) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true; // Permite probar primero; en producción conviene configurarlo.
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function sendText(to, body) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error("Faltan credenciales de WhatsApp en Netlify");

  const resp = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || "No se pudo enviar el mensaje por WhatsApp");
  return data;
}

async function notifyAdmin(customer, summary) {
  const admin = String(process.env.WHATSAPP_ADMIN_NUMBER || "").replace(/\D/g, "");
  if (!admin) return;
  await sendText(admin, `🟢 Cliente listo para cerrar\nWhatsApp: ${customer}\n${summary}`);
}

async function askAI(question, matches, history) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY en Netlify");
  const model = process.env.OPENAI_MODEL || "gpt-5.6";

  const instructions = `Sos el vendedor virtual de Veronica Import por WhatsApp. Hablás en español rioplatense, cálido, breve y profesional. Tu objetivo es ayudar a elegir un producto y avanzar la venta, sin presionar. Usá solamente la información del catálogo enviada. Todos los productos del contexto están disponibles. No inventes stock, medidas, colores, precios, cuotas ni características. Si no encontrás una coincidencia clara, pedí UN dato concreto para afinar la búsqueda (por ejemplo medida, presupuesto, marca o color). Si hay buenas opciones, mostrales máximo 3. Podés mencionar precio contado y, si existen, 3 y 6 cuotas. No pidas datos de tarjeta, CBU, claves, códigos ni información bancaria. Si el cliente manifiesta intención clara de comprar o pagar, no cierres el pago: indicá que lo vas a pasar al área de pagos.`;

  const payload = {
    model,
    store: false,
    instructions,
    input: JSON.stringify({
      mensaje_actual: question,
      historial_reciente: history || [],
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
  return (data.output || [])
    .flatMap(x => x.content || [])
    .filter(x => x.type === "output_text")
    .map(x => x.text)
    .join("")
    .trim();
}

function getIncomingText(payload) {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg) return null;
  const from = msg.from;
  let text = "";
  if (msg.type === "text") text = msg.text?.body || "";
  else if (msg.type === "button") text = msg.button?.text || msg.button?.payload || "";
  else if (msg.type === "interactive") {
    text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
  }
  return text ? { from, text, messageId: msg.id } : null;
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      return new Response(challenge || "", { status: 200 });
    }
    return new Response("Verification failed", { status: 403 });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await req.text();
  if (!verifySignature(rawBody, req.headers.get("x-hub-signature-256"))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return new Response("Bad JSON", { status: 400 }); }

  const incoming = getIncomingText(payload);
  if (!incoming) return new Response("EVENT_RECEIVED", { status: 200 });

  try {
    const store = getStore("catalogo");
    const sessions = getStore("whatsapp-sessions");
    const rawCatalog = await store.get("products.json");
    if (!rawCatalog) throw new Error("Catálogo no inicializado");
    const products = JSON.parse(rawCatalog);

    const sessionKey = `session-${incoming.from}.json`;
    let session = { history: [], human: false };
    try {
      const rawSession = await sessions.get(sessionKey);
      if (rawSession) session = { ...session, ...JSON.parse(rawSession) };
    } catch {}

    // Si ya fue derivado a una persona, el bot queda en silencio.
    if (session.human) return new Response("EVENT_RECEIVED", { status: 200 });

    if (wantsHuman(incoming.text)) {
      const paymentNumber = String(process.env.WHATSAPP_PAYMENT_NUMBER || "").trim();
      const paymentLine = paymentNumber
        ? `\n\nPara finalizar, escribinos al área de pagos: ${paymentNumber}`
        : "\n\nTe paso con el área de pagos para finalizar la compra.";
      const reply = `Perfecto 🙌 Ya estás para cerrar la compra.${paymentLine}`;
      await sendText(incoming.from, reply);

      const summary = `Último mensaje: ${incoming.text}${session.history?.length ? `\nContexto: ${session.history.slice(-4).map(x => `${x.role}: ${x.text}`).join(" | ")}` : ""}`;
      await notifyAdmin(incoming.from, summary).catch(() => {});
      session.human = true;
      session.history = [...(session.history || []), { role: "cliente", text: incoming.text }, { role: "bot", text: reply }].slice(-10);
      await sessions.set(sessionKey, JSON.stringify(session));
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    const matches = rankProducts(products, incoming.text);
    const answer = await askAI(incoming.text, matches, session.history || []);
    await sendText(incoming.from, answer);

    session.history = [...(session.history || []), { role: "cliente", text: incoming.text }, { role: "bot", text: answer }].slice(-10);
    await sessions.set(sessionKey, JSON.stringify(session));

    return new Response("EVENT_RECEIVED", { status: 200 });
  } catch (err) {
    console.error("WhatsApp bot error:", err);
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
};
