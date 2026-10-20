# insta-pilot

**Instagram para Claude.** Servidor MCP + skill que le da a Claude Code control de tus cuentas de Instagram mediante la **API oficial** (sin scraping frágil ni riesgo de ban): exportar toda la cuenta, publicar reels/fotos/carruseles/historias, leer y responder comentarios, leer y contestar DMs, analítica y una bandeja unificada de "lo que falta por responder".

```
Tú:     responde a los comentarios de hoy
Claude: ig_inbox → 7 comentarios sin responder, 2 DMs
        [tabla con respuestas propuestas en tu tono]
        ¿Las publico?
Tú:     sí
Claude: ig_comment_reply ×7 ✓
```

## Qué incluye

| Área | Tools |
|---|---|
| Cuentas | `ig_accounts`, `ig_use_account` (multi-cuenta) |
| Perfil y scraping | `ig_profile`, `ig_media_list`, `ig_media_get`, `ig_export` (JSON + CSV de todo) |
| Métricas | `ig_media_insights`, `ig_account_insights` (+ demografía), `ig_analytics` (top posts, mejores horas) |
| Comentarios | `ig_comments`, `ig_comments_unanswered`, `ig_comment_reply`, `ig_comment_hide`, `ig_comment_delete`, `ig_comments_toggle` |
| Publicar | `ig_publish_reel`, `ig_publish_image`, `ig_publish_carousel`, `ig_publish_story`, `ig_publishing_limit` |
| DMs | `ig_conversations`, `ig_messages`, `ig_send_message` |
| Triage | `ig_inbox` — comentarios sin responder + DMs que esperan respuesta |

### Seguridad por diseño
- **Lista de bloqueo**: cuentas que la herramienta se niega a tocar aunque tengas su token (`insta-pilot block <usuario>` o `INSTA_PILOT_BLOCKLIST`).
- **`dry_run`** en todas las escrituras: Claude enseña lo que haría antes de hacerlo.
- **Modo solo lectura**: `INSTA_PILOT_READ_ONLY=1` oculta todas las tools de escritura.
- **Auditoría**: cada escritura queda en `~/.insta-pilot/audit.jsonl`.
- Tokens en local (`~/.insta-pilot/accounts.json`), renovación automática antes de que caduquen (60 días).
- Reintentos con backoff ante límites de la API.

## Instalación

Requisitos: Node 20+, una cuenta de Instagram **profesional** (Business o Creator, se cambia gratis en Ajustes → Tipo de cuenta).

```bash
git clone https://github.com/dfadify-web/insta-pilot && cd insta-pilot
npm install && npm link
insta-pilot install          # registra el MCP en Claude Code + instala la skill
```

### Conseguir el token (5 min, una vez por cuenta)
1. [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Crear app** → caso de uso *"Gestionar mensajes y contenido en Instagram"*.
2. En **API de Instagram → Configuración de la API con inicio de sesión de Instagram**, añade tu cuenta (en *Roles → Probadores de Instagram* si te lo pide y acepta la invitación en Instagram → Ajustes → Apps y sitios web).
3. Pulsa **Generar token** junto a la cuenta y concede los permisos `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_messages`, `instagram_business_manage_insights`.
4. ```bash
   insta-pilot add <TOKEN>
   insta-pilot doctor
   ```

En modo desarrollo de la app todo funciona para tus propias cuentas; no hace falta pasar la revisión de Meta.

### Subir archivos locales
La API solo acepta URLs públicas. Para subir un `.mp4` de tu disco, insta-pilot lo sube temporalmente a **tu** Vercel Blob y lo borra al publicar:

```bash
# Vercel → Storage → Blob → crear store → copiar el token read-write
setx INSTA_PILOT_BLOB_TOKEN "vercel_blob_rw_..."
```

Sin token, pasa una URL pública en `video` / `image`.

## CLI

```
insta-pilot add <TOKEN> [--secret APP_SECRET]   añadir cuenta (con --secret canjea un token corto por uno de 60 días)
insta-pilot list | use <u> | remove <u> | block <u>
insta-pilot refresh [u]       renovar token
insta-pilot doctor            comprobar tokens y permisos
insta-pilot inbox [u]         pendiente de responder
insta-pilot export [u] [--dms]
```

## Variables de entorno

| Variable | Uso |
|---|---|
| `INSTA_PILOT_HOME` | Carpeta de config (por defecto `~/.insta-pilot`) |
| `INSTA_PILOT_READ_ONLY` | `1` = sin escrituras |
| `INSTA_PILOT_BLOCKLIST` | Cuentas bloqueadas extra, separadas por comas |
| `INSTA_PILOT_BLOB_TOKEN` | Token Vercel Blob para subir archivos locales |
| `INSTA_PILOT_API_VERSION` | Versión Graph API (por defecto `v23.0`) |

## Límites (de Instagram, no de la herramienta)
- ~50 publicaciones por cuenta cada 24 h.
- DMs: solo responder a conversaciones que inició la otra persona, dentro de 24 h.
- No da acceso a la lista de seguidores ni a likes por usuario.

## Desarrollo

```bash
npm test     # node:test con fetch simulado, sin tocar Instagram
```

MIT © dfadify-web
