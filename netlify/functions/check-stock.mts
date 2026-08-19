// netlify/functions/check-stock.mts
//
// SCHEDULED FUNCTION - runs automatically on the schedule set below.
//
// v2: also marks a product as sinStock=true when it is not found at all in
// either supplier's current live catalog (covers discontinued items that
// simply vanished from the supplier's site instead of showing quantity 0).
// Matching uses exact normalized name first, then a fuzzy token-overlap
// match to survive small wording differences between our stored names and
// the supplier's current listing text.

import { getStore } from "@netlify/blobs";

const FRANCHI_API = "https://franchi.com.ar/wp-json/wc/store/v1/products";
const ELECTROQUIL_API = "https://applestorequil.rosariosystem.com/catalogo/ajax/datatable-productos.ajax.php";

function normalize(s) {
  return s
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findMatch(key, map) {
  if (map.has(key)) return map.get(key);
  const keyTokens = new Set(key.split(" "));
  if (keyTokens.size < 3) return null;
  let best = null;
  let bestOverlap = 0;
  for (const [name, val] of map) {
    const nameTokens = new Set(name.split(" "));
    const shorter = keyTokens.size <= nameTokens.size ? keyTokens : nameTokens;
    const longer = keyTokens.size <= nameTokens.size ? nameTokens : keyTokens;
    if (shorter.size === 0) continue;
    let inter = 0;
    for (const t of shorter) if (longer.has(t)) inter++;
    const overlap = inter / shorter.size;
    if (overlap >= 0.85 && overlap > bestOverlap) {
      best = val;
      bestOverlap = overlap;
    }
  }
  return best;
}

async function fetchFranchiStock() {
  const result = new Map();
  let page = 1;
  while (true) {
    const resp = await fetch(`${FRANCHI_API}?per_page=100&page=${page}`);
    if (!resp.ok) break;
    const items = await resp.json();
    if (!Array.isArray(items) || items.length === 0) break;
    for (const it of items) {
      const key = normalize(it.name);
      result.set(key, {
        inStock: !!it.is_in_stock,
        price: Number(it.prices?.price || 0),
      });
    }
    if (items.length < 100) break;
    page++;
    if (page > 40) break;
  }
  return result;
}

async function fetchElectroQuilStock() {
  const result = new Map();
  const resp = await fetch(ELECTROQUIL_API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "draw=1&start=0&length=1000",
  });
  if (!resp.ok) return result;
  const items = await resp.json();
  if (!Array.isArray(items)) return result;
  for (const it of items) {
    const key = normalize(it.name);
    result.set(key, {
      inStock: Number(it.quantity) > 0,
      price: Number(it.price || 0),
    });
  }
  return result;
}

export default async () => {
  const store = getStore("catalogo");
  const raw = await store.get("products.json");
  if (!raw) {
    return new Response("No hay catalogo guardado todavia en Blobs.", { status: 400 });
  }
  const catalog = JSON.parse(raw);

  const [franchiMap, electroQuilMap] = await Promise.all([
    fetchFranchiStock().catch(() => new Map()),
    fetchElectroQuilStock().catch(() => new Map()),
  ]);

  let updated = 0;
  let notFound = 0;
  for (const p of catalog) {
    const key = normalize(p.nombre);
    const hit = findMatch(key, franchiMap) || findMatch(key, electroQuilMap);
    const wasSinStock = !!p.sinStock;

    if (!hit) {
      p.sinStock = true;
      notFound++;
      if (wasSinStock !== p.sinStock) updated++;
      continue;
    }

    p.sinStock = !hit.inStock;

    if (hit.price > 0 && p.costoProveedor && Math.abs(hit.price - p.costoProveedor) > 1) {
      const margin = p.nuevo ? 1.10 : 1.20;
      p.costoProveedor = hit.price;
      p.contado = Math.round(hit.price * margin);
      p.precio3 = Math.round(p.contado * 1.20);
      p.precio6 = Math.round(p.contado * 1.40);
    }

    if (wasSinStock !== p.sinStock) updated++;
  }

  await store.set("products.json", JSON.stringify(catalog));
  await store.set("last-check.json", JSON.stringify({ checkedAt: new Date().toISOString(), changed: updated, notFound }));

  return new Response(`OK. Cambios: ${updated}. No encontrados: ${notFound}. Total: ${catalog.length}.`, { status: 200 });
};

export const config = {
  schedule: "0 */12 * * *",
};
