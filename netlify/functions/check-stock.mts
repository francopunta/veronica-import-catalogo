// netlify/functions/check-stock.mts
//
// SCHEDULED FUNCTION - runs automatically on the schedule set below.
//
// Matching requires ALL numeric tokens (sizes, dimensions, liters, watts,
// inches) to match EXACTLY between our product name and the supplier
// listing. Only the non-numeric words are allowed to fuzzy-match.
//
// v4: also scans Electro Quil's live catalog for products that do NOT exist
// in our own catalog at all, and adds them automatically - real photo,
// mapped to the right category, cost with the usual margin applied. These
// freshly-added products get a fechaAgregado timestamp so the site's "lo
// mas nuevo" section can show the real newest arrivals.

import { getStore } from "@netlify/blobs";

const FRANCHI_API = "https://franchi.com.ar/wp-json/wc/store/v1/products";
const ELECTROQUIL_API = "https://applestorequil.rosariosystem.com/catalogo/ajax/datatable-productos.ajax.php";
const ELECTROQUIL_IMG_BASE = "https://applestorequil.rosariosystem.com/backoffice/vistas/";

const CATEGORY_MAP = {
  "CAMPANAS Y EXTRACTORES": "Cocina",
  "COLCHONES Y SOMIERS": "Descanso",
  "INFORMATICA": "Hogar y Herramientas",
  "SILLONES COMPRIMIDOS": "Sillones",
  "CORTADORA DE CESPED JARDINERIA": "Jardin y Exterior",
  "CUIDADO PERSONAL": "Hogar y Herramientas",
  "MOVILIDAD ELECTRICA": "Bicicletas y Movilidad",
  "ALMOHADAS": "Descanso",
  "TABLET": "Hogar y Herramientas",
  "SOPORTE PARA TV": "Hogar y Herramientas",
  "PLANCHAS": "Hogar y Herramientas",
  "ASPIRADORA": "Hogar y Herramientas",
  "MUEBLES": "Hogar y Herramientas",
  "PANELES CALEFACTORES": "Aires y Ventilacion",
  "CAMPERAS": "Hogar y Herramientas",
  "LAVAVAJILLAS": "Cocina",
  "TOSTADORA SANDWICHERA": "Cocina",
  "JUGUETES": "Hogar y Herramientas",
  "FREIDORAS": "Cocina",
  "CAMPING": "Camping y Aire Libre",
  "PARLANTES": "Parlantes y Audio",
  "GAMING": "Hogar y Herramientas",
  "REPOSERAS": "Camping y Aire Libre",
  "PILETAS": "Camping y Aire Libre",
  "BICICLETAS": "Bicicletas y Movilidad",
  "PEQUENOS": "Cocina",
  "LICUADORAS": "Cocina",
  "EXHIBIDORAS": "Heladeras y Freezers",
  "SECARROPAS": "Lavado",
  "BALANZAS": "Hogar y Herramientas",
  "HORNOS ELECTRICOS": "Cocina",
  "JARRA ELECTRICA": "Cocina",
  "HERRAMIENTAS": "Herramientas y Ferreteria",
  "CAFETERAS": "Cocina",
  "VENTILADORES": "Aires y Ventilacion",
  "FREEZER": "Heladeras y Freezers",
  "COCINAS": "Cocina",
  "MICROONDAS": "Cocina",
  "HELADERAS": "Heladeras y Freezers",
  "TERMOTANQUES": "Termotanques",
  "AIRES": "Aires y Ventilacion",
  "LAVARROPAS": "Lavado",
  "TELEVISORES": "Televisores",
};

function normalize(s) {
  return s
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleClean(s) {
  const words = s.split(" ");
  return words.map(function (w) {
    if (/\d/.test(w)) return w;
    if (w.toUpperCase() === w && w.length > 1) {
      return w.charAt(0) + w.slice(1).toLowerCase();
    }
    return w;
  }).join(" ");
}

function splitTokens(key) {
  const tokens = key.split(" ").filter(Boolean);
  const nums = new Set(tokens.filter(t => /^\d+$/.test(t)));
  const words = new Set(tokens.filter(t => !/^\d+$/.test(t)));
  return { nums, words };
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function findMatch(key, map) {
  if (map.has(key)) return map.get(key);
  const parsed = splitTokens(key);
  const keyNums = parsed.nums;
  const keyWords = parsed.words;
  if (keyWords.size < 3) return null;

  let best = null;
  let bestOverlap = 0;
  for (const entry of map) {
    const name = entry[0];
    const val = entry[1];
    const nParsed = splitTokens(name);
    const nNums = nParsed.nums;
    const nWords = nParsed.words;

    if (!sameSet(keyNums, nNums)) continue;

    const shorter = keyWords.size <= nWords.size ? keyWords : nWords;
    const longer = keyWords.size <= nWords.size ? nWords : keyWords;
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
    const resp = await fetch(FRANCHI_API + "?per_page=100&page=" + page);
    if (!resp.ok) break;
    const items = await resp.json();
    if (!Array.isArray(items) || items.length === 0) break;
    for (const it of items) {
      const key = normalize(it.name);
      result.set(key, {
        inStock: !!it.is_in_stock,
        price: Number((it.prices && it.prices.price) || 0),
      });
    }
    if (items.length < 100) break;
    page++;
    if (page > 40) break;
  }
  return result;
}

async function fetchElectroQuilRaw() {
  const resp = await fetch(ELECTROQUIL_API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "draw=1&start=0&length=1000",
  });
  if (!resp.ok) return [];
  const items = await resp.json();
  return Array.isArray(items) ? items : [];
}

function electroQuilImageUrl(it) {
  if (it.thumbImage && it.thumbImage[0]) {
    return ELECTROQUIL_IMG_BASE + it.thumbImage[0].replace(/^\.\.\//, "");
  }
  return null;
}

export default async () => {
  const store = getStore("catalogo");
  const raw = await store.get("products.json");
  if (!raw) {
    return new Response("No hay catalogo guardado todavia en Blobs.", { status: 400 });
  }
  const catalog = JSON.parse(raw);

  const electroQuilRaw = await fetchElectroQuilRaw().catch(function () { return []; });
  const electroQuilMap = new Map();
  for (const it of electroQuilRaw) {
    const key = normalize(it.name);
    electroQuilMap.set(key, {
      inStock: Number(it.quantity) > 0,
      price: Number(it.price || 0),
    });
  }

  const franchiMap = await fetchFranchiStock().catch(function () { return new Map(); });

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

  const existingKeys = new Set(catalog.map(function (p) { return normalize(p.nombre); }));
  const existingCatalogMap = new Map(catalog.map(function (p) { return [normalize(p.nombre), p]; }));
  let nextId = catalog.reduce(function (max, p) { return Math.max(max, p.id); }, 0) + 1;
  let added = 0;
  const nowIso = new Date().toISOString();

  for (const it of electroQuilRaw) {
    const key = normalize(it.name);
    if (existingKeys.has(key)) continue;
    if (findMatch(key, existingCatalogMap)) continue;

    const costo = Number(it.price || 0);
    if (costo <= 0) continue;
    const contado = Math.round(costo * 1.20);
    const rawCat = (it.type || it.category || "").toUpperCase().trim();
    const categoria = CATEGORY_MAP[rawCat] || "Hogar y Herramientas";
    const img = electroQuilImageUrl(it);

    catalog.push({
      id: nextId++,
      nombre: titleClean(it.name),
      categoria: categoria,
      costoProveedor: costo,
      contado: contado,
      precio3: Math.round(contado * 1.20),
      precio6: Math.round(contado * 1.40),
      img: img || "",
      nuevo: true,
      fechaAgregado: nowIso,
      descripcion: "Producto nuevo de nuestro proveedor Electro Quil. Precio de contado con descuento, con la opcion de pagarlo en 3 o 6 cuotas sin necesidad de banco, solo con recibo de sueldo.",
      specs: [],
      sinStock: Number(it.quantity) > 0 ? false : true,
    });
    existingKeys.add(key);
    added++;
  }

  await store.set("products.json", JSON.stringify(catalog));
  await store.set("last-check.json", JSON.stringify({
    checkedAt: nowIso,
    changed: updated,
    notFound: notFound,
    added: added,
    total: catalog.length,
  }));

  return new Response(
    "OK. Cambios: " + updated + ". No encontrados: " + notFound + ". Nuevos agregados: " + added + ". Total: " + catalog.length + ".",
    { status: 200 }
  );
};

export const config = {
  schedule: "0 */12 * * *",
};
