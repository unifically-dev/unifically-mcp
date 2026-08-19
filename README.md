# Unifically MCP Server

Official MCP (Model Context Protocol) server for [Unifically](https://unifically.com): one API for 100+ AI models. Ask Claude, Cursor, or any MCP client to generate video, images, music, and speech with Veo 3.1, Kling, SeeDance, Grok Imagine, Nano Banana, Suno, ElevenLabs, and more.

This is a **hosted remote server**. There is nothing to install or run: point your client at the endpoint and add your API key.

```
https://mcp.unifically.com/mcp
```

Get an API key at [unifically.com](https://unifically.com). Every account starts with a free balance, so you can try any model before paying.

## Quick start

### Claude Code

```bash
claude mcp add --transport http unifically https://mcp.unifically.com/mcp --header "Authorization: Bearer sk-..."
```

### Claude (web and desktop connectors)

Add a custom connector with the key in the URL, since pasted connector URLs carry no headers:

```
https://mcp.unifically.com/mcp?api_key=sk-...
```

### Cursor / Claude Desktop / standard JSON config

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

### VS Code (Copilot)

```json
{
  "servers": {
    "unifically": {
      "type": "http",
      "url": "https://mcp.unifically.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

### Windsurf

```json
{
  "mcpServers": {
    "unifically": {
      "serverUrl": "https://mcp.unifically.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

### Cline

```json
{
  "mcpServers": {
    "unifically": {
      "type": "streamableHttp",
      "url": "https://mcp.unifically.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.unifically]
url = "https://mcp.unifically.com/mcp"
http_headers = { "Authorization" = "Bearer sk-..." }
```

### Gemini CLI

```json
{
  "mcpServers": {
    "unifically": {
      "httpUrl": "https://mcp.unifically.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

### Clients that only support stdio servers

Bridge stdio to the remote server with [mcp-remote](https://www.npmjs.com/package/mcp-remote):

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

Ready-to-paste config files for every client are in [examples/clients](./examples/clients/), and example prompts in [examples/prompts.md](./examples/prompts.md).

## Tools

| Tool | What it does |
|---|---|
| `generate_video` | Text or image to video (Veo 3.1, Kling, SeeDance, Grok Imagine, Wan, and more) |
| `generate_image` | Text or image to image (Nano Banana, Seedream, GPT Image, Qwen, FLUX, and more) |
| `generate_music` | Music generation with Suno |
| `generate_audio` | Speech, dialogue, and sound effects with ElevenLabs |
| `edit_video` / `extend_video` | Edit or extend existing videos |
| `upscale_media` | Upscale images and video (Topaz, Grok, Veo) |
| `upload_file` | Upload a local file and get a CDN URL to use as a reference input |
| `get_task` / `list_tasks` | Check generation status and history |
| `list_models` / `list_resources` | Browse the model catalog and voices |
| `dry_run_cost` | Price any generation before running it, never charges |
| `check_balance` | Current account balance |

## Example prompts

- "Generate a 5 second video of a paper boat floating down a rainy street with Kling"
- "Make a product shot of a ceramic mug on linen with Seedream, then upscale it"
- "How much would 10 seconds of Veo 3.1 Fast cost?" (uses `dry_run_cost`, free)
- "Turn this blog post into a 30 second narrated clip"

## Links

- Website: https://unifically.com
- Model catalog and pricing: https://unifically.com/models
- API docs: https://docs.unifically.com
- MCP setup page with all clients: https://unifically.com/mcp

## License

MIT. The hosted server and the Unifically API are commercial services; this repository contains the public integration surface (docs, registry manifest, and examples).
