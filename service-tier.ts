import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SettingsList,
  Text,
  type SettingItem,
} from "@earendil-works/pi-tui";
import {
  ANTHROPIC_BETA_HEADER,
  DEFAULT_SERVICE_TIER_CONFIG,
  SERVICE_TIER_PROVIDER_DEFINITIONS,
  applyServiceTierToPayload,
  createServiceTierSections,
  getManagedBetaHeaders,
  getRequiredBetaHeaders,
  getServiceTierConfigPath,
  isServiceTierProvider,
  loadServiceTierConfig,
  resolveEffectiveServiceTier,
  setProviderServiceTier,
  toggleFastServiceTier,
  writeServiceTierConfigSnapshot,
  type ServiceTierName,
  type ServiceTierConfigSnapshot,
} from "./shared.ts";

export const SERVICE_TIER_WIDGET_ID = "pi-service-tier.service-tier";

const FANCY_FOOTER_DISCOVER_WIDGETS_EVENT =
  "pi-fancy-footer:discover-widgets";
const FANCY_FOOTER_REQUEST_WIDGET_REFRESH_EVENT =
  "pi-fancy-footer:request-widget-refresh";

function contributeFancyFooterWidget(
  pi: ExtensionAPI,
  widget: Record<string, unknown>,
): void {
  pi.events.on(FANCY_FOOTER_DISCOVER_WIDGETS_EVENT, (payload) => {
    const request = payload as
      | { registerWidget?: (widget: Record<string, unknown>) => void }
      | undefined;
    if (typeof request?.registerWidget !== "function") return;
    request.registerWidget(widget);
  });
}

function requestFancyFooterRefresh(pi: ExtensionAPI): void {
  pi.events.emit(FANCY_FOOTER_REQUEST_WIDGET_REFRESH_EVENT, {});
}

function warnOnce(message: string, lastWarning: string): string {
  if (message !== lastWarning) console.warn(`pi-service-tier: ${message}`);
  return message;
}

function formatModel(model: ExtensionContext["model"]): string {
  if (!model) return "the current model";
  return `${model.provider}/${model.id}`;
}

function notifyConfigWriteError(ctx: ExtensionCommandContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`Failed to save service tier config: ${message}`, "error");
}

function createServiceTierSettingItems(
  config: ServiceTierConfigSnapshot,
  model: ExtensionContext["model"],
): SettingItem[] {
  return createServiceTierSections(config, model).flatMap((section) =>
    section.items.map((item) => ({
      id: item.id,
      label: section.id === "current" ? `Current: ${item.label}` : item.label,
      description: item.description,
      currentValue: item.currentValue,
      values: [...item.values],
    })),
  );
}

export default function (pi: ExtensionAPI) {
  let currentServiceTier: ServiceTierName | "" = "";
  let lastConfigWarning = "";
  let syncingModelHeaders = false;

  /**
   * Some tiers (Anthropic fast mode) require a beta request header. Request
   * payloads cannot carry headers, so we inject them onto the active model via
   * `pi.setModel`. We only touch the `anthropic-beta` header values this
   * extension manages, preserving any other headers and beta flags.
   */
  const syncModelBetaHeaders = async (
    ctx: { model?: ExtensionContext["model"] },
    config: ServiceTierConfigSnapshot,
  ): Promise<void> => {
    const model = ctx.model;
    if (!model || syncingModelHeaders) return;

    const required = getRequiredBetaHeaders(config, model);
    const managed = getManagedBetaHeaders();
    const headers: Record<string, string> = { ...(model.headers ?? {}) };
    const previousValue = headers[ANTHROPIC_BETA_HEADER] ?? "";

    const tokens = previousValue
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => !managed.includes(token));
    for (const token of required) {
      if (!tokens.includes(token)) tokens.push(token);
    }

    const nextValue = tokens.join(",");
    if (nextValue === previousValue) return;

    if (nextValue) headers[ANTHROPIC_BETA_HEADER] = nextValue;
    else delete headers[ANTHROPIC_BETA_HEADER];

    syncingModelHeaders = true;
    try {
      await pi.setModel({ ...model, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastConfigWarning = warnOnce(
        `failed to apply request headers: ${message}`,
        lastConfigWarning,
      );
    } finally {
      syncingModelHeaders = false;
    }
  };

  const loadConfigOrDefault = (): ServiceTierConfigSnapshot => {
    try {
      const config = loadServiceTierConfig();
      lastConfigWarning = "";
      return config;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastConfigWarning = warnOnce(message, lastConfigWarning);
      return { ...DEFAULT_SERVICE_TIER_CONFIG };
    }
  };

  const loadConfigForCommand = (
    ctx: ExtensionCommandContext,
  ): ServiceTierConfigSnapshot | undefined => {
    try {
      const config = loadServiceTierConfig();
      lastConfigWarning = "";
      return config;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastConfigWarning = warnOnce(message, lastConfigWarning);
      ctx.ui.notify(`Invalid service tier config: ${message}`, "error");
      return undefined;
    }
  };

  const refreshServiceTier = (
    ctx: ExtensionContext,
    config = loadConfigOrDefault(),
    forceRefresh = false,
  ): ServiceTierName | "" => {
    const nextServiceTier = resolveEffectiveServiceTier(config, ctx.model);
    if (currentServiceTier === nextServiceTier && !forceRefresh) {
      return currentServiceTier;
    }

    currentServiceTier = nextServiceTier;
    requestFancyFooterRefresh(pi);
    return currentServiceTier;
  };

  const writeAndRefresh = (
    ctx: ExtensionCommandContext,
    config: ServiceTierConfigSnapshot,
  ): boolean => {
    try {
      writeServiceTierConfigSnapshot(config);
      refreshServiceTier(ctx, config, true);
      void syncModelBetaHeaders(ctx, config);
      return true;
    } catch (error) {
      notifyConfigWriteError(ctx, error);
      return false;
    }
  };

  contributeFancyFooterWidget(pi, {
    id: SERVICE_TIER_WIDGET_ID,
    label: "Service tier",
    description: "Shows the configured provider service tier when active.",
    row: 1,
    order: 8,
    align: "right",
    grow: false,
    icon: {
      nerd: "",
      emoji: "⚡",
      unicode: "⚡",
      ascii: "!",
    },
    visible: () => currentServiceTier !== "",
    render: () => currentServiceTier || undefined,
  });

  pi.registerCommand("fast", {
    description: "Toggle fast service tier for the current model provider.",
    handler: async (_args, ctx) => {
      const config = loadConfigForCommand(ctx);
      if (!config) return;

      const result = toggleFastServiceTier(config, ctx.model);
      if (!result) {
        ctx.ui.notify(
          `Service tier is not supported for ${formatModel(ctx.model)}.`,
          "warning",
        );
        return;
      }

      if (!writeAndRefresh(ctx, result.config)) return;

      const providerLabel =
        SERVICE_TIER_PROVIDER_DEFINITIONS[result.provider].label;
      ctx.ui.notify(
        `${providerLabel} service tier: ${result.serviceTier || "off"}`,
        "info",
      );
    },
  });

  pi.registerCommand("service-tier", {
    description: "Configure provider service tiers.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/service-tier requires interactive UI mode", "warning");
        return;
      }

      const config = loadConfigForCommand(ctx);
      if (!config) return;

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        let currentConfig = config;
        const items = createServiceTierSettingItems(currentConfig, ctx.model);
        const container = new Container();
        container.addChild(
          new Text(
            `${theme.fg("accent", theme.bold("Service Tier"))}\n${theme.fg(
              "dim",
              getServiceTierConfigPath(),
            )}`,
            0,
            0,
          ),
        );

        let settingsList: SettingsList;
        settingsList = new SettingsList(
          items,
          Math.min(items.length, 12),
          getSettingsListTheme(),
          (id, newValue) => {
            if (!isServiceTierProvider(id)) return;

            const previousValue = currentConfig[id] ?? "off";
            const nextConfig = setProviderServiceTier(
              currentConfig,
              id,
              newValue === "off" ? "" : (newValue as ServiceTierName),
            );
            if (!writeAndRefresh(ctx, nextConfig)) {
              settingsList.updateValue(id, previousValue);
              return;
            }

            currentConfig = nextConfig;
          },
          () => done(undefined),
        );
        container.addChild(settingsList);

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data: string) {
            settingsList.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfigOrDefault();
    refreshServiceTier(ctx, config);
    await syncModelBetaHeaders(ctx, config);
  });

  pi.on("model_select", async (_event, ctx) => {
    const config = loadConfigOrDefault();
    refreshServiceTier(ctx, config);
    await syncModelBetaHeaders(ctx, config);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    const config = loadConfigOrDefault();
    refreshServiceTier(ctx, config);
    return applyServiceTierToPayload(event.payload, config, ctx.model);
  });

  pi.on("session_shutdown", async () => {
    if (!currentServiceTier) return;
    currentServiceTier = "";
    requestFancyFooterRefresh(pi);
  });
}
