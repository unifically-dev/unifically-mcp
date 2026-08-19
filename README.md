# UnificAlly MCP Server

Official MCP (Model Context Protocol) server for [UnificAlly](https://unifically.com): one API for 100+ AI video, image, music, and speech models. Ask Claude, Cursor, or any MCP client to generate with Veo 3.1, Kling, SeeDance, Grok Imagine, Nano Banana, Suno, ElevenLabs, and more.

This is a **hosted remote server**. Nothing to install or run. Point your client at the endpoint and add your API key.

```
https://mcp.unifically.com/mcp
```

Get an API key at [unifically.com](https://unifically.com). Every account starts with a free balance.

## Config

Add this server to your MCP-compatible client using the configuration below.

```json
{
  "mcpServers": {
    "unifically": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.unifically.com/mcp",
        "--header",
        "Authorization: Bearer YOUR_API_KEY"
      ]
    }
  }
}
```

Remote clients that support Streamable HTTP can skip the bridge:

```json
{
  "mcpServers": {
    "unifically": {
      "type": "streamableHttp",
      "url": "https://mcp.unifically.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

## Tools

### `generate_video`
Text or image to video (Veo 3.1, Kling, SeeDance, Grok Imagine, Wan, and more).

### `generate_image`
Text or image to image (Nano Banana, Seedream, GPT Image, Qwen, FLUX, and more).

### `generate_music`
Music generation with Suno.

### `generate_audio`
Speech, dialogue, and sound effects with ElevenLabs.

### `edit_video`
Edit an existing video.

### `extend_video`
Extend an existing video.

### `upscale_media`
Upscale images and video (Topaz, Grok, Veo).

### `upload_file`
Upload a local file and get a CDN URL to use as a reference input.

### `get_task`
Check the status of a generation task.

### `list_tasks`
List recent generation tasks.

### `list_models`
Browse the model catalog.

### `list_resources`
Browse voices and other resources.

### `dry_run_cost`
Price any generation before running it. Never charges.

### `check_balance`
Show the current account balance.

## Quick start

### Claude Code

```bash
claude mcp add --transport http unifically https://mcp.unifically.com/mcp --header "Authorization: Bearer sk-..."
```

### Claude (web and desktop connectors)

Add a custom connector. Pasted connector URLs carry no headers, so put the key in the URL:

```
https://mcp.unifically.com/mcp?api_key=sk-...
```

### Cursor / Claude Desktop

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

## Example prompts

- Generate a 5 second video of a paper boat floating down a rainy street with Kling
- Make a product shot of a ceramic mug on linen with Seedream, then upscale it
- How much would 10 seconds of Veo 3.1 Fast cost?
- Turn this blog post into a 30 second narrated clip

## Links

- Website: https://unifically.com
- Model catalog and pricing: https://unifically.com/models
- API docs: https://docs.unifically.com
- MCP setup: https://unifically.com/mcp
- Official MCP Registry: `com.unifically/mcp`

## License

MIT. The hosted server and the UnificAlly API are commercial services. This repository is the public integration surface (docs, registry manifest, and examples).
