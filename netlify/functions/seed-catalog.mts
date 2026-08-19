// netlify/functions/seed-catalog.mts
//
// Run ONCE (or whenever you want to fully replace the catalog by hand) to load
// data/products.json into Netlify Blobs, which check-stock.mts updates
// automatically afterwards and get-products.mts serves to the site.
//
// How to run it after deploying:
//   curl -X POST https://TU-SITIO.netlify.app/.netlify/functions/seed-catalog \
//     -H "Content-Type: application/json" \
//     --data-binary @data/products.json

import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Usa POST con el JSON del catalogo en el body.", { status: 405 });
  }
  const body = await req.text();
  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed)) throw new Error("El JSON debe ser un array de productos");
  } catch (e) {
    return new Response("JSON invalido: " + e.message, { status: 400 });
  }

  const store = getStore("catalogo");
  await store.set("products.json", body);

  return new Response("Catalogo cargado en Blobs correctamente.", { status: 200 });
};
