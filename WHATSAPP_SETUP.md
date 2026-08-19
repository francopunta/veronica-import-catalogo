# WhatsApp + IA — Veronica Import

El webhook ya está en:

`/.netlify/functions/whatsapp`

## Variables de entorno en Netlify

Agregar en **Site configuration → Environment variables**:

- `OPENAI_API_KEY` = clave de OpenAI
- `WHATSAPP_ACCESS_TOKEN` = token permanente de WhatsApp Cloud API
- `WHATSAPP_PHONE_NUMBER_ID` = Phone Number ID de Meta
- `WHATSAPP_VERIFY_TOKEN` = una frase secreta inventada por vos (ej: `veronica-import-2026-seguro`)
- `META_APP_SECRET` = App Secret de la app de Meta (recomendado)
- `WHATSAPP_PAYMENT_NUMBER` = número que se le muestra al cliente cuando quiere pagar
- `WHATSAPP_ADMIN_NUMBER` = opcional; número que recibe aviso cuando un cliente está listo para cerrar
- `META_GRAPH_VERSION` = opcional; si no se define usa `v23.0`

## Configurar el webhook en Meta

En Meta for Developers, dentro de la app con WhatsApp:

- Callback URL: `https://TU-SITIO-NETLIFY/.netlify/functions/whatsapp`
- Verify token: el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`
- Suscribirse al campo `messages`

## Qué hace el bot

- Lee el catálogo actualizado de Netlify Blobs.
- Solo recomienda productos con stock.
- Puede responder por producto, color, medida, presupuesto, etc.
- Usa OpenAI para redactar respuestas naturales.
- No toma pagos ni pide datos bancarios.
- Cuando detecta intención clara de compra/pago, envía al cliente al área de pagos.
- Opcionalmente avisa al número configurado en `WHATSAPP_ADMIN_NUMBER`.
- Después de derivar a humano, deja de responder en esa conversación.

## Nota importante

Para volver a activar el bot para un cliente que ya fue derivado, hay que borrar/resetear su sesión en Netlify Blobs (`whatsapp-sessions`). Esto se puede automatizar después con un panel o comando.
