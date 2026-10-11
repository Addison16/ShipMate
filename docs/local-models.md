# Local models with Ollama

Shipmate can run entirely on your own hardware, with no API key and no cost per message, using
[Ollama](https://ollama.com). The `docker-compose.yml` ships an optional `ollama` service that
is off until you ask for it.

## One command

```bash
docker compose --profile local-ai up -d
```

This starts Shipmate, Postgres and Ollama, and a one-shot `ollama-pull` container downloads a
starter model (`qwen3:4b`, about 2.5 GB) into the `ollama-models` volume. Pick another with
`SHIPMATE_LOCAL_MODEL`:

```bash
SHIPMATE_LOCAL_MODEL=qwen3:8b docker compose --profile local-ai up -d
```

Then open Shipmate. On a new install, first-run setup offers the model right after you create
the owner account: press **Use this model** and it is set up as the Ollama provider and as the
default model. On an existing install, open **Providers → Local model (Ollama)** as the owner.
From there you can also download other models (with progress) without touching a terminal.

Leave out `--profile local-ai` on later `docker compose` commands and the Ollama containers
are left alone; `docker compose --profile local-ai down` stops them too.

## Which model

Crew call tools (files, the web, MCP servers), so pick a model that supports tool calling.
The Providers page suggests a few that run on an ordinary home server:

| Model | Download | Notes |
|---|---|---|
| `qwen3:4b` | ~2.5 GB | A good first pick; about 4 GB of free memory |
| `llama3.2:3b` | ~2.0 GB | The lightest; simpler answers |
| `qwen3:8b` | ~5.2 GB | Noticeably better; 8 GB or more of free memory |
| `gpt-oss:20b` | ~14 GB | The strongest here; 16 GB of memory or a GPU |

Small local models are slower and less capable than the big hosted ones. A useful mix: keep
the Captain on a hosted model and give simple, high-volume crew members (a note taker, a
scheduled watch) the local one by setting `model: ollama/qwen3:4b` in their crew.yaml.

## GPU

Ollama runs on the CPU by default. With an NVIDIA GPU and the NVIDIA Container Toolkit on the
host, uncomment the `deploy:` block under the `ollama` service in `docker-compose.yml`. See
Ollama's Docker docs for AMD (the `ollama/ollama:rocm` image).

## Ollama somewhere else

Already running Ollama on the host or another machine? Skip the profile and enter its address
on the Providers page (from inside the Shipmate container, the host is usually
`http://host.docker.internal:11434` on Docker Desktop, or the host's LAN IP on Linux; Ollama
must listen on more than localhost, `OLLAMA_HOST=0.0.0.0`). Set `SHIPMATE_OLLAMA_URL` to make
that the address Shipmate checks first.

## Cost page

Local models cost nothing per call, so the **Cost** page shows tokens and response times for
them, and opens its chart on tokens when a month ran only on free models.
