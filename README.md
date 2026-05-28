# ⚡ pi-service-tier

A [pi](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent)
extension that toggles fast mode and applies provider service tiers.

## 🚀 Installation

```sh
pi install npm:pi-service-tier
```

## ✨ What it does

- Adds service tier parameters to supported provider requests when a tier is
  configured
- Adds `/fast` to toggle the current model provider between fast mode and off
- Adds `/service-tier` to configure all supported providers from an interactive
  modal
- Adds an optional service tier widget when `pi-fancy-footer` is installed

## 🚀 Commands

- `/fast`: toggles the current model provider between its fast tier and off.
  OpenAI and Google providers use `priority` as the fast tier. Anthropic uses
  `fast`, which sends Anthropic [fast mode](https://docs.anthropic.com/) rather
  than a `service_tier`.

- `/service-tier`: opens an interactive editor. The current model provider
  appears first, followed by the remaining supported providers. Press Enter or
  Space to cycle through `off` and the provider-specific tiers.

## ⚙️ Configuration

Run `/service-tier` or create `~/.pi/agent/service-tier.json`:

```json
{
  "openai": "priority",
  "openai-codex": "flex",
  "anthropic": "fast",
  "google": "priority",
  "google-vertex": "flex"
}
```

### Supported providers

| Provider        | Tiers                | Fast tier  |
| --------------- | -------------------- | ---------- |
| `openai`        | `flex`, `priority`   | `priority` |
| `openai-codex`  | `flex`, `priority`   | `priority` |
| `anthropic`     | `fast`, `standard`   | `fast`     |
| `google`        | `flex`, `priority`   | `priority` |
| `google-vertex` | `flex`, `priority`   | `priority` |

To turn a provider off, omit its key. Only the values listed above are accepted.
Batch APIs are separate asynchronous APIs and are not configured by this
extension.

### Anthropic fast mode

Unlike the other providers (which set a `service_tier` field), Anthropic's `fast`
tier uses Anthropic **fast mode**. A fast request needs two things:

- a `speed: "fast"` body field — this extension adds it automatically, and
- the `anthropic-beta: fast-mode-2026-02-01` request header.

Any provider whose API is `anthropic-messages` (including proxied providers such
as `anthropic-new`) is treated as Anthropic.

#### Required: enable the beta header on your model

pi extensions can rewrite the request **body** but cannot add request
**headers**, so the `anthropic-beta` header must be configured on the provider
or model. Without it, Anthropic rejects the `speed` field with
`speed: Extra inputs are not permitted`.

Add the header to your Anthropic provider/model in `models.json` (it is
harmless when fast mode is off — the beta flag only enables the capability):

```json
{
  "providers": {
    "anthropic": {
      "headers": {
        "anthropic-beta": "fast-mode-2026-02-01"
      }
    }
  }
}
```

The header value is also available programmatically as the exported
`ANTHROPIC_FAST_MODE_BETA` constant, and `getRequiredBetaHeaders(config, model)`
returns the beta headers the active tier needs.

## 🧩 Footer widget

When [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer) is installed,
the widget appears only when the active model uses a supported provider/API pair
and that provider has a configured tier.

![pi-fancy-footer screenshot](screenshot.png)

The widget id is `pi-service-tier.service-tier`. It uses the current
`pi-fancy-footer` extension widget API, with row `1`, order `8`, right
alignment, and no grow behavior by default.

## 📝 TODO

- Account for service-tier pricing in pi usage metrics. The extension currently
  injects the tier into the provider request payload, but pi's OpenAI Codex cost
  calculation reads the requested tier from provider options. Until pi exposes a
  first-class extension path for that option, displayed usage costs can omit
  flex or priority multipliers.

## 🧹 Uninstall

```sh
pi remove npm:pi-service-tier
```

## 📄 License

[MIT](LICENSE)
