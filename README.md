# UnificAlly MCP server

[![npm](https://img.shields.io/npm/v/@unifically/mcp-server)](https://www.npmjs.com/package/@unifically/mcp-server)

An MCP server for the [UnificAlly API](https://docs.unifically.com). It lets an AI assistant generate video, images, music, speech and sound effects, transcribe audio and upscale media through 100+ models (Veo 3.1, Kling, Seedance, Hailuo, Grok Imagine, Nano Banana, Flux, GPT Image, Suno, ElevenLabs, Topaz) with one API key.

It works in any MCP client: Cursor, Claude Desktop, Claude Code, Cline, Windsurf, Zed, ChatGPT Desktop, Goose, n8n and your own code.

## Install

1. Create an API key at https://unifically.com/api-keys. A new account starts with $0.50 of balance to test with.
2. Add the server to your client config:

```json
{
  "mcpServers": {
    "unifically": {
      "command": "npx",
      "args": ["-y", "@unifically/mcp-server"],
      "env": { "UNIFICALLY_API_KEY": "sk-..." }
    }
  }
}
```

That block works as is for Cursor (`.cursor/mcp.json`), Claude Desktop (`claude_desktop_config.json`), Cline and Windsurf (`~/.codeium/windsurf/mcp_config.json`). Restart the client after saving.

Claude Code:

```bash
claude mcp add unifically -e UNIFICALLY_API_KEY=sk-... -- npx -y @unifically/mcp-server
```

<details>
<summary>Other clients</summary>

Zed (`~/.config/zed/settings.json`):

```json
{
  "context_servers": {
    "unifically": {
      "command": { "path": "npx", "args": ["-y", "@unifically/mcp-server"] },
      "env": { "UNIFICALLY_API_KEY": "sk-..." }
    }
  }
}
```

ChatGPT Desktop: Settings, Connectors, Add MCP server. Command `npx -y @unifically/mcp-server`, plus the `UNIFICALLY_API_KEY` variable.

Goose, n8n or anything else that speaks stdio:

```bash
UNIFICALLY_API_KEY=sk-... npx -y @unifically/mcp-server
```

On Windows, if the client says `npx not found`, use `"command": "cmd", "args": ["/c", "npx", "-y", "@unifically/mcp-server"]`.

</details>

There is also a hosted server at `https://mcp.unifically.com/mcp` for clients that take a URL. See [Remote server](#remote-server).

## Example

Ask the assistant for something:

> Make a 16:9 image of a lighthouse at dusk, then a 6 second video that starts from it.

It calls the tools in order:

```json
{ "name": "generate_image", "arguments": { "prompt": "a lighthouse at dusk, waves, warm light", "aspect_ratio": "16:9" } }
```

```text
Generated image with google/nano-banana-pro. Result: https://files.unifically.com/image/....png [task_id: 7f3c...]
```

```json
{ "name": "generate_video", "arguments": { "prompt": "slow push in, waves rolling", "image_url": "https://files.unifically.com/image/....png", "duration": 6 } }
```

Each generation tool waits for the job and returns the media URL. The structured result looks like this:

```ts
{
  task_id: string,
  status: "completed" | "pending" | "processing",
  output: { video_url?, image_url?, audio_url?, image_urls?, audio_urls?, text? },  // when completed
  model: string,
  cost_usd?: number
}
```

Under the hood each call is one request to the UnificAlly API (`POST /v1/tasks` with `{ model, input }`, then `GET /v1/tasks/{id}`), the same one shown in the [API docs](https://docs.unifically.com).

## Tools

| Tool | What it does | Spends balance |
| --- | --- | --- |
| `generate_video` | Text or image to video (Veo, Kling, Hailuo, Seedance, Grok and more). Optional start and end frames, reference images. | yes |
| `generate_image` | Text to image and image editing (Nano Banana, GPT Image, Flux, Qwen, Kling, Grok, SeeDream). | yes |
| `generate_audio` | Text to speech, sound effects, dialogue, transcription (`stt`), voice change (`voice-changer`), audio cleanup (`voice-isolation`). | yes |
| `generate_music` | Suno: make a song, or `cover`, `extend`, `add-vocals`, `add-instrumental` or `stems` an existing track. | yes |
| `edit_video` | Edit an existing clip from a prompt, or transfer motion onto a subject image (`motion-control`). | yes |
| `upscale_media` | Topaz for any image or video (`image_url` / `video_url`), or `task_id` for the Veo and Grok upscalers. | yes |
| `extend_video` | Extend a finished Veo (+8 s) or Grok Imagine generation. | yes |
| `upload_file` | Turn a URL, or a local file on a stdio server, into a public CDN URL. | no |
| `get_task` | Status and result of a task by id, optionally waiting for it. | no |
| `list_tasks` | Past tasks, newest first, filtered by status, model, category, provider or time. | no |
| `list_resources` | Voice lists for ElevenLabs (default), Kling and Veo. | no |
| `list_models` | The model catalog and aliases. | no |
| `dry_run_cost` | The price of a call without running it. | no |
| `check_balance` | Account balance in USD. | no |

Every tool sets all four MCP hints. The seven tools that spend balance are marked `destructiveHint: true` and `idempotentHint: false`, so a client that auto-approves read-only tools still asks before a paid run. Failed generations are not charged.

Supported models, each with its parameters, id and a browser playground:

- Video: [Veo 3.1](https://unifically.com/models/veo-3.1), [Kling](https://unifically.com/models/kling), [Seedance](https://unifically.com/models/seedance), [MiniMax Hailuo](https://unifically.com/models/minimax-hailuo), [Grok Imagine](https://unifically.com/models/grok-imagine), [Wan 3.0](https://unifically.com/models/wan-3.0), [Gemini Omni Flash 1.1](https://unifically.com/models/gemini-omni-flash-1.1)
- Image: [Nano Banana](https://unifically.com/models/nano-banana), [GPT Image 2](https://unifically.com/models/gpt-image-2), [Flux.2 Pro](https://unifically.com/models/flux-2-pro), [Qwen Image](https://unifically.com/models/qwen-image), [SeeDream](https://unifically.com/models/seedream)
- Music and audio: [Suno](https://unifically.com/models/suno), [ElevenLabs](https://unifically.com/models/elevenlabs)
- Upscaling: [Topaz Labs](https://unifically.com/models/topaz)

`list_models` returns the full live catalog.

## How it behaves

- Every generation tool works from a `prompt` alone. `model` is optional and takes short aliases (`veo`, `kling`, `flux`, `nano-banana-2`, `seedance`, `tts`, `sfx`, `stt`) or full ids such as `google/veo-3.1-fast`.
- Media fields (`image_url`, `image_urls`, `end_image_url`, `reference_image_urls`, `audio_url`, `video_url`) take public https URLs only. A local path or base64 string gets an error that says to upload first.
- Field names differ between models (Kling's `start_frame_url`, Veo's `start_image_url`, Seedance's `first_frame_url`). You pass `image_url` and the server renames it. Any field the server has no parameter for goes in `provider_options`, which also overrides the mapping.
- The server keeps no copy of each model's allowed durations, resolutions or aspect ratios. The API checks values and returns a 422 that names the fix, at no cost. The server instructions tell the assistant to read the model's page in [`docs.unifically.com/llms.txt`](https://docs.unifically.com/llms.txt) before running a model.
- Every generation tool also accepts `wait`, `callback_url`, `provider_options` and `confirm_cost`.
- Errors come back as one sentence: 401 for a missing or wrong key, 402 for low balance (with a top-up link), 422 with the API's validation message, and a timeout message that tells the assistant to resume with `get_task`. 429, 5xx and network errors are retried with backoff.

### Uploads

Models only read public URLs, so a local file goes to the UnificAlly CDN first.

1. `upload_file { content_type: "image/png" }` returns a one-time `upload_url` and the final `file_url`. The assistant sends the bytes with curl, without any API key in the shell:

   ```bash
   curl -X PUT '<upload_url>' --data-binary @photo.png
   ```

   The URL is signed, single use and expires in about 5 minutes. The file keeps full quality.
2. `upload_file { url }` imports a file that is already online.
3. `upload_file { file_path }` reads the file from disk, only when the server runs locally over stdio.

There is no base64 upload, and the instructions tell the assistant never to send a user's file to another host. Both rules come from real failures: with a base64 size limit, agents shrank users' images to fit, and one agent without a key in its shell uploaded a private photo to a public file host.

### Long jobs

High quality video and full songs can take minutes.

- `wait: false` returns `{ task_id, status: "pending" }` at once. Poll `get_task` until `status` is `"completed"`.
- `callback_url` returns at once too, and the API POSTs the result to your webhook.

Any task can be picked up later with `get_task`.

### Spend limits

All off by default. Set them per deployment:

- `UNIFICALLY_CONFIRM_COST_ABOVE=<usd>`: a call priced above this returns a quote, and runs only when the assistant retries with `confirm_cost: true`.
- `UNIFICALLY_MAX_COST_PER_TASK=<usd>`: a call priced above this is rejected. `confirm_cost` does not override it.
- `UNIFICALLY_BLOCKED_MODELS=veo-quality,suno` or `UNIFICALLY_ALLOWED_MODELS=nano-banana-2,flux,tts`: restrict which models can run.
- `UNIFICALLY_DISABLE_GENERATION=true`: read-only mode. Browsing, `dry_run_cost` and `check_balance` still work.

## Environment variables

| Variable | Required | Default |
| --- | --- | --- |
| `UNIFICALLY_API_KEY` | stdio only | none. HTTP callers send their own key. `UNIFICALLY_KEY`, `UNIFICALLY_TOKEN` and `UNIFICALLY_API_TOKEN` also work. |
| `UNIFICALLY_BASE_URL` | no | `https://api.unifically.com` |
| `UNIFICALLY_FILES_BASE_URL` | no | `https://files.unifically.com` |
| `UNIFICALLY_REQUEST_TIMEOUT_MS` | no | `60000` |
| `UNIFICALLY_MAX_RETRIES` | no | `3` |
| `UNIFICALLY_POLL_TIMEOUT_MS` | no | `600000` |
| `UNIFICALLY_POLL_START_MS` | no | `2000` |
| `UNIFICALLY_POLL_MAX_MS` | no | `10000` |
| `UNIFICALLY_CONFIRM_COST_ABOVE` | no | off |
| `UNIFICALLY_MAX_COST_PER_TASK` | no | off |
| `UNIFICALLY_BLOCKED_MODELS` | no | none |
| `UNIFICALLY_ALLOWED_MODELS` | no | none |
| `UNIFICALLY_DISABLE_GENERATION` | no | `false` |
| `MCP_TRANSPORT` | no | `stdio` (or `http`) |
| `UNIFICALLY_HTTP_WAIT_BUDGET_MS` | no | `85000`, the longest an HTTP call blocks before returning the task_id |
| `PORT` | no | set by the hosting platform |
| `UNIFICALLY_CORS_ORIGIN` | no | `*` |
| `UNIFICALLY_TRUSTED_PROXIES` | no | `loopback`. Also `private`, exact IPs or CIDRs allowed to send `X-Forwarded-For`. |
| `UNIFICALLY_TRUST_CF_CONNECTING_IP` | no | `false` |
| `UNIFICALLY_RATE_PER_MIN` | no | `120` requests per minute, per key and per account |
| `UNIFICALLY_RATE_BURST` | no | `40` |
| `UNIFICALLY_PUBLIC_DISCOVERY` | no | `true`. Lets keyless callers run `initialize`, `tools/list`, `resources/list` and `ping`. Set `0` to require a key for everything. |
| `UNIFICALLY_ANON_RATE_PER_MIN` | no | `30` keyless requests per minute, per IP |
| `UNIFICALLY_ANON_RATE_BURST` | no | `12` |

## Remote server

`MCP_TRANSPORT=http` serves Streamable HTTP on `/mcp` and legacy SSE on `GET /sse` + `POST /messages`. The hosted copy runs at `https://mcp.unifically.com/mcp`.

Each caller sends their own key, so one deployment serves many users and bills each one's own balance:

1. `Authorization: Bearer <key>` (recommended)
2. `X-API-Key: <key>`
3. `?api_key=<key>` for clients that only take a URL. Query strings can end up in proxy logs, so use a header when you can.

```json
{
  "mcpServers": {
    "unifically": {
      "url": "https://mcp.unifically.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

For claude.ai (Settings, Connectors, Add custom connector) put the key in the URL: `https://mcp.unifically.com/mcp?api_key=sk-...`. For stdio-only clients, bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "unifically": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.unifically.com/mcp", "--header", "Authorization: Bearer sk-..."]
    }
  }
}
```

Details of the HTTP mode:

- Streamable HTTP is stateless, so it scales behind any reverse proxy without sticky sessions.
- A caller without a key can run `initialize`, `tools/list`, `resources/list`, `prompts/list` and `ping`, so registries can read the tool list. Everything else returns 401. Keyless traffic is rate limited per IP and capped at 16 concurrent messages. `GET /.well-known/mcp-config` returns a JSON Schema for the one required setting (`api_key`), and `GET /.well-known/mcp/server-card.json` returns the tool list.
- Keys are checked against the API, with the result cached, and a per-IP budget limits failed checks. Rate limits apply per key and per account, so extra keys do not raise one account's limit. Batches are capped at 16 messages and bodies at 512 KB.
- Browser `Origin` headers are validated against DNS rebinding. MCP clients send none and are unaffected.
- `X-Forwarded-For` is trusted only from `UNIFICALLY_TRUSTED_PROXIES`. The shipped Compose file sets `private` for its isolated network; do not use that on a shared LAN.
- A key with zero balance can still check the balance, list and fetch tasks and price a job. It cannot start one (402).
- `GET /` returns connect instructions and `GET /health` is an unauthenticated health check.

### Self-hosting

The repo ships a `Dockerfile` and `docker-compose.yml` that run the HTTP transport with per-request keys. Put the container behind an HTTPS reverse proxy, point a domain at it and use `/health` as the health check. Nothing is required in the environment. `UNIFICALLY_CONFIRM_COST_ABOVE=1.00` is a sensible default for a shared deployment.

## Development

```bash
git clone https://github.com/unifically-dev/unifically-mcp.git
cd unifically-mcp
npm install
cp .env.example .env       # add your UNIFICALLY_API_KEY
npm run dev
```

Inspect the tools interactively:

```bash
npx @modelcontextprotocol/inspector npx -y tsx src/index.ts
```

Tests:

```bash
npm test               # build + smoke test
npm run test:vitest    # full suite
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `spawn npx ENOENT` | Node is not on PATH. Use absolute paths to `node` and `dist/index.js` in the client config. |
| `401 Unauthorized` | `UNIFICALLY_API_KEY` is missing from the client's `env` block. Restart the client after editing. |
| `402 Payment Required` | Top up at https://unifically.com/payments. |
| Tool calls hang | Long video or full songs: pass `wait: false` or a `callback_url`. |
| Client shows no tools | Run `npx @modelcontextprotocol/inspector npx -y @unifically/mcp-server`. If the tools show there, the client config JSON is malformed. |

## Links

- API docs: https://docs.unifically.com
- API keys: https://unifically.com/api-keys
- Models: https://unifically.com/models
- MCP page: https://unifically.com/mcp
- Support: support@unifically.com, [Discord](https://discord.com/invite/FsmJDQVXxF)

## License

MIT
