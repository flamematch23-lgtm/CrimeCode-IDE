<p align="center">
  <h1 align="center">OpenWorm</h1>
</p>
<p align="center">The uncensored AI coding agent by WormGPT. No restrictions. No limits.</p>
<p align="center">
  <a href="https://github.com/hunters-sec/opencode"><img alt="GitHub" src="https://img.shields.io/badge/github-hunters--sec%2Fopencode-black?style=flat-square&logo=github" /></a>
  <a href="https://wrmgpt.com"><img alt="WormGPT" src="https://img.shields.io/badge/powered%20by-WormGPT-red?style=flat-square" /></a>
</p>

---

**OpenWorm** is a powerful AI coding agent built on [CrimeCode](https://github.com/anomalyco/opencode) with WormGPT's uncensored models built in. Use WormGPT, Claude, Grok, and 15+ other providers from a single terminal or web interface.

## Features

- **WormGPT Models Built-In** — V8, V8 Lite, and V7 pre-configured and ready to use
- **Uncensored AI** — No content filters, no refusals, no restrictions on WormGPT models
- **Multi-Provider** — Connect Claude (Anthropic), Grok (xAI), GPT (OpenAI), Gemini (Google), and more with your own API keys
- **TUI + Web + Desktop** — Rich terminal interface, web UI, and native desktop app
- **Full Agent Capabilities** — File editing, shell commands, code analysis, and multi-step automation
- **Provider Agnostic** — Switch between models mid-conversation

## Quick Start

### Installation

```bash
# Clone and install
git clone https://github.com/hunters-sec/opencode.git
cd opencode
bun install

# Run the TUI
bun dev

# Or run the web UI (two terminals)
bun run --cwd packages/opencode --conditions=browser src/index.ts serve  # Terminal 1: backend
bun dev:web                                                               # Terminal 2: frontend
```

> Requires [Bun](https://bun.sh) 1.3+

### Connect Your Providers

Open Settings (`Ctrl+,`) → **Providers** tab:

| Provider      | Models                           | How to Connect                                   |
| ------------- | -------------------------------- | ------------------------------------------------ |
| **WormGPT**   | V8, V8 Lite, V7                  | Enter your WormGPT API key (`sk-wrmgpt.com-...`) |
| **Anthropic** | Claude Opus, Sonnet, Haiku       | Enter your Anthropic API key                     |
| **xAI**       | Grok 3, Grok 3 Mini              | Enter your xAI API key                           |
| **OpenAI**    | GPT-5, GPT-4.1, o3, o4-mini      | Enter your OpenAI API key                        |
| **Google**    | Gemini 2.5 Pro, Flash            | Enter your Google API key                        |
| **+ 15 more** | OpenRouter, Azure, Bedrock, etc. | See full provider list in Settings               |

You can also set API keys via environment variables:

```bash
export WORMGPT_API_KEY=sk-wrmgpt.com-your-key
export ANTHROPIC_API_KEY=sk-ant-...
export XAI_API_KEY=xai-...
```

## WormGPT Models

| Model               | Description                | Best For                                |
| ------------------- | -------------------------- | --------------------------------------- |
| **WormGPT V8**      | Flagship uncensored model  | Complex coding, unrestricted generation |
| **WormGPT V8 Lite** | Fast uncensored model      | Quick iterations, general coding        |
| **WormGPT V7**      | Lightweight with reasoning | Fast responses, simple tasks            |

All WormGPT models support:

- Streaming responses
- Tool calling / function execution
- Reasoning mode (V7, V8)
- 32K context window

## Agents

Switch between agents with the `Tab` key:

- **build** — Default full-access agent for development
- **plan** — Read-only agent for analysis and code exploration

## Architecture

OpenWorm uses a client/server architecture:

- **Backend** (port 4096) — Handles AI providers, sessions, file operations
- **Frontend** — TUI, Web UI (port 3000), or Desktop app
- **Provider System** — Connects to any OpenAI-compatible API

## Get a WormGPT API Key

Visit [wrmgpt.com](https://wrmgpt.com) to create an account and get your API key.

## Credits

OpenWorm is built on [OpenCode](https://github.com/anomalyco/opencode) by [Anomaly](https://anomaly.co). All original OpenCode features and providers are fully supported.

## License

MIT
