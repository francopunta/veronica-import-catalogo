// netlify/functions/get-products.mts
//
// Public, read-only endpoint the site calls on load: GET /.netlify/functions/get-products
// Returns whatever is currently stored in Blobs (kept fresh by check-stock.mts).

import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("catalogo");
  const raw = await store.get("products.json");

  if (!raw) {
    return new Response(JSON.stringify({ error: "catalogo no inicializado" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(raw, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
