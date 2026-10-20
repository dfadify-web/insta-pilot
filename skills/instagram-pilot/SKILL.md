---
name: instagram-pilot
description: Gestiona cuentas de Instagram con el MCP insta-pilot (tools ig_*) — bandeja de comentarios y DMs sin responder, responder en el tono de la cuenta, publicar reels/fotos/carruseles/historias, analítica y export completo. Úsala cuando el usuario diga "mira mi Instagram", "responde los comentarios", "contesta los DMs", "sube este reel", "qué tal van mis reels", "scrapea mi cuenta" o "cuándo publico".
---

# Instagram Pilot

Usa las tools `ig_*` del MCP **insta-pilot** (API oficial de Instagram). Si no aparecen, dile al usuario que ejecute `insta-pilot install` y reinicie Claude Code.

## Reglas duras

1. **Nunca operes con @fabregueees_** ni con ninguna cuenta de `ig_accounts → blocklist`. El servidor ya lo bloquea; tú no intentes rodearlo (ni con Chrome ni de otra forma).
2. Antes de cualquier acción, llama a `ig_accounts` y confirma con qué cuenta estás (`active`). Si el usuario nombra otra, pasa `account`.
3. Escrituras públicas (publicar, responder, DM, borrar, ocultar): primero ejecuta con `dry_run: true`, enseña al usuario el texto exacto y la cuenta, y espera su "sí". Si el usuario ya aprobó un lote concreto ("responde a todos con esto"), ese lote vale; no lo extiendas a otros.
4. `ig_comment_delete` es irreversible: pide confirmación siempre, uno a uno.
5. Los DMs solo se pueden contestar dentro de 24 h desde el último mensaje del usuario. Si falla con ese error, díselo y no reintentes.

## Flujos

### "Responde a todo" / triage diario
1. `ig_inbox` → comentarios sin responder + DMs esperando respuesta.
2. Clasifica: preguntas (repo, precio, cómo se hizo) · elogios · spam/odio · colaboraciones.
3. Redacta respuestas cortas en el tono de la cuenta (lee 3–5 respuestas previas suyas con `ig_comments` para imitarlo; mismo idioma que el comentario; sin hashtags; máx. 1 emoji).
4. Propón spam/odio para `ig_comment_hide`, nunca borrar por defecto.
5. Enseña la tabla (usuario · mensaje · respuesta propuesta) → tras aprobación, `ig_comment_reply` / `ig_send_message`.

### Publicar un reel
1. `ig_publishing_limit` (máx. ~50 publicaciones/24 h).
2. El vídeo debe ser MP4 H.264 vertical 9:16, ≤15 min, ≤300 MB. Ruta local → necesita `INSTA_PILOT_BLOB_TOKEN`; si no está, usa una URL pública o la skill `instagram-reel-upload` (Chrome).
3. Caption: gancho en la 1ª línea, cuerpo, CTA, 3–8 hashtags del idioma del vídeo.
4. `ig_publish_reel` con `dry_run: true` → confirmar → sin dry_run. Devuelve el permalink: compártelo.

### Analítica
- `ig_analytics` → top/peores posts, mejores días y horas (Europe/Madrid). Da 3 conclusiones accionables, no una tabla muda.
- `ig_media_insights` para un post concreto; `ig_account_insights` (con `breakdown` para demografía).

### Scrapear toda la cuenta
- `ig_export` (añade `with_dms: true` solo si lo piden). Devuelve la carpeta con `profile.json`, `media.json`, `media.csv`, `account_insights_28d.json`, `summary.json`.

## Límites de la API oficial
- Solo cuentas **profesionales** (Business o Creator).
- No hay acceso a seguidores individuales, a stories de otros ni a likes por usuario.
- Mensajes: solo conversaciones iniciadas por la otra persona y dentro de la ventana de 24 h.
