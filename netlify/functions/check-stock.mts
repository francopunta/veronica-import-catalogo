// netlify/functions/check-stock.mts
//
// SCHEDULED FUNCTION - runs automatically on the schedule set below.
// Both suppliers expose plain JSON endpoints, so this is just fetch() calls,
// no browser needed.
//
// What it does:
//  1. Downloads the current catalog (products.json) from Netlify Blobs.
//  2. Fetches live stock/price data from Casa Franchi (WooCommerce Store API)
//     and Electro Quil (their internal datatable endpoint).
//  3. Matches each supplier product to our catalog by normalized name.
//  4. Updates sinStock (and contado/precio3/precio6 when the cost changed)
//     for every match, leaving everything else untouched.
//  5. Saves the updated catalog back to Blobs, where get-products.mts serves
//     it to the live site.

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
        img: it.images?.[0]?.src,
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
    const img = it.thumbImage?.[0]
      ? `https://applestorequil.rosariosystem.com/backoffice/vistas/${it.thumbImage[0].replace(/^\.\.\//, "")}`
      : undefined;
    result.set(key, {
      inStock: Number(it.quantity) > 0,
      price: Number(it.price || 0),
      img,
    });
  }
  return result;
}

export default async () => {
  const store = getStore("catalogo");
  const raw = await store.get("products.json");
  if (!raw) {
    return new Response("No hay catalogo guardado todavia en Blobs. Subi products.json primero.", { status: 400 });
  }
  const catalog = JSON.parse(raw);

  const [franchiMap, electroQuilMap] = await Promise.all([
    fetchFranchiStock().catch(() => new Map()),
    fetchElectroQuilStock().catch(() => new Map()),
  ]);

  let updated = 0;
  for (const p of catalog) {
    const key = normalize(p.nombre);
    const hit = franchiMap.get(key) || electroQuilMap.get(key);
    if (!hit) continue;

    const wasSinStock = !!p.sinStock;
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
  await store.set("last-check.json", JSON.stringify({ checkedAt: new Date().toISOString(), changed: updated }));

  return new Response(`OK. Productos con cambio de stock: ${updated}. Total revisado: ${catalog.length}.`, { status: 200 });
};

export const config = {
  schedule: "0 */12 * * *",
};
