import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const SERVICE_TIER_CONFIG_FILE = "service-tier.json";

export const SERVICE_TIER_PROVIDERS = [
  "openai",
  "openai-codex",
  "anthropic",
  "google",
  "google-vertex",
] as const;
export type ServiceTierProvider = (typeof SERVICE_TIER_PROVIDERS)[number];

export type ServiceTierName = "flex" | "priority" | "standard" | "fast";
export type ServiceTierConfigSnapshot = Partial<
  Record<ServiceTierProvider, ServiceTierName>
>;

/**
 * How a tier is applied to the provider request.
 * - "service_tier": top-level `service_tier` body field (OpenAI/Anthropic) or
 *   nested `config.serviceTier` (Google).
 * - "speed": Anthropic fast mode, applied as a top-level `speed` body field and
 *   gated behind a beta header (see `betaHeader`).
 */
export type ServiceTierMechanism = "service_tier" | "speed";

/** Anthropic fast mode beta header value (sent via `anthropic-beta`). */
export const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";

/** Request header used to opt into Anthropic beta features. */
export const ANTHROPIC_BETA_HEADER = "anthropic-beta";

export interface ServiceTier {
  name: ServiceTierName;
  value: string;
  /** Defaults to "service_tier" when omitted. */
  mechanism?: ServiceTierMechanism;
  /** Beta header value that must be present for this tier to work. */
  betaHeader?: string;
}

export const DEFAULT_SERVICE_TIER_CONFIG: ServiceTierConfigSnapshot = {};

export interface ServiceTierProviderDefinition {
  label: string;
  api: string;
  tiers: readonly ServiceTier[];
  fastTier?: ServiceTierName;
  /**
   * When true, any model using this provider's `api` is treated as this
   * provider regardless of its provider id. This lets proxied Anthropic
   * endpoints (e.g. `anthropic-new`) pick up the configured tier.
   */
  matchByApi?: boolean;
}

function tier(
  name: ServiceTierName,
  value = name,
  extra?: Pick<ServiceTier, "mechanism" | "betaHeader">,
): ServiceTier {
  return { name, value, ...extra };
}

export const SERVICE_TIER_PROVIDER_DEFINITIONS: Record<
  ServiceTierProvider,
  ServiceTierProviderDefinition
> = {
  openai: {
    label: "OpenAI",
    api: "openai-responses",
    tiers: [tier("flex"), tier("priority")],
    fastTier: "priority",
  },
  "openai-codex": {
    label: "OpenAI Codex",
    api: "openai-codex-responses",
    tiers: [tier("flex"), tier("priority")],
    fastTier: "priority",
  },
  anthropic: {
    label: "Anthropic",
    api: "anthropic-messages",
    // Treat any anthropic-messages model (incl. proxied ones like
    // `anthropic-new`) as Anthropic.
    matchByApi: true,
    tiers: [
      // Anthropic fast mode: `speed: "fast"` body field + beta header.
      tier("fast", "fast", {
        mechanism: "speed",
        betaHeader: ANTHROPIC_FAST_MODE_BETA,
      }),
      tier("standard", "standard_only"),
    ],
    fastTier: "fast",
  },
  google: {
    label: "Google Gemini",
    api: "google-generative-ai",
    tiers: [tier("flex"), tier("priority")],
    fastTier: "priority",
  },
  "google-vertex": {
    label: "Google Vertex AI",
    api: "google-vertex",
    tiers: [tier("flex"), tier("priority")],
    fastTier: "priority",
  },
};

function serviceTierNames(provider: ServiceTierProvider): ServiceTierName[] {
  return SERVICE_TIER_PROVIDER_DEFINITIONS[provider].tiers.map(
    (serviceTier) => serviceTier.name,
  );
}

function literalUnion(values: readonly ServiceTierName[]) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

const serviceTierConfigSchema = Type.Object(
  {
    openai: Type.Optional(literalUnion(serviceTierNames("openai"))),
    "openai-codex": Type.Optional(
      literalUnion(serviceTierNames("openai-codex")),
    ),
    anthropic: Type.Optional(literalUnion(serviceTierNames("anthropic"))),
    google: Type.Optional(literalUnion(serviceTierNames("google"))),
    "google-vertex": Type.Optional(
      literalUnion(serviceTierNames("google-vertex")),
    ),
  },
  { additionalProperties: false },
);
const validateServiceTierConfig = Compile(serviceTierConfigSchema);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatValidationErrors(filePath: string, value: unknown): string {
  const errors = Array.from(validateServiceTierConfig.Errors(value));
  const unknownKeys = isRecord(value)
    ? Object.keys(value).filter(
        (key) =>
          !(SERVICE_TIER_PROVIDERS as readonly string[]).includes(key),
      )
    : [];
  if (unknownKeys.length > 0) {
    return `Invalid ${filePath}: unknown setting ${unknownKeys.map((key) => `"${key}"`).join(", ")}`;
  }
  return `Invalid ${filePath}: ${errors
    .map((error) => `${error.path || "/"} ${error.message}`)
    .join(", ")}`;
}

export function getDefaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getServiceTierConfigPath(
  agentDir = getDefaultAgentDir(),
): string {
  return join(agentDir, SERVICE_TIER_CONFIG_FILE);
}

export function isServiceTierProvider(
  value: unknown,
): value is ServiceTierProvider {
  return (
    typeof value === "string" &&
    (SERVICE_TIER_PROVIDERS as readonly string[]).includes(value)
  );
}

export function parseServiceTierConfigValue(
  filePath: string,
  value: unknown,
): ServiceTierConfigSnapshot {
  if (value === undefined) return { ...DEFAULT_SERVICE_TIER_CONFIG };
  if (!validateServiceTierConfig.Check(value)) {
    throw new Error(formatValidationErrors(filePath, value));
  }

  const config = value as ServiceTierConfigSnapshot;
  const result: ServiceTierConfigSnapshot = {};
  for (const provider of SERVICE_TIER_PROVIDERS) {
    const serviceTier = config[provider];
    if (serviceTier !== undefined) result[provider] = serviceTier;
  }
  return result;
}

export function loadServiceTierConfig(
  configPath = getServiceTierConfigPath(),
): ServiceTierConfigSnapshot {
  if (!existsSync(configPath)) return { ...DEFAULT_SERVICE_TIER_CONFIG };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${configPath}: ${message}`);
  }

  return parseServiceTierConfigValue(configPath, parsed);
}

export function writeServiceTierConfigSnapshot(
  config: ServiceTierConfigSnapshot,
  configPath = getServiceTierConfigPath(),
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function modelSupportsServiceTier(
  model: { api?: unknown; provider?: unknown } | undefined,
): boolean {
  return getServiceTierProviderForModel(model) !== undefined;
}

export function getServiceTierProviderForModel(
  model: { api?: unknown; provider?: unknown } | undefined,
): ServiceTierProvider | undefined {
  if (!model) return undefined;

  // Exact provider-id match (with matching api).
  if (isServiceTierProvider(model.provider)) {
    const definition = SERVICE_TIER_PROVIDER_DEFINITIONS[model.provider];
    if (model.api === definition.api) return model.provider;
  }

  // API-based match for providers that opt in (e.g. proxied Anthropic).
  for (const provider of SERVICE_TIER_PROVIDERS) {
    const definition = SERVICE_TIER_PROVIDER_DEFINITIONS[provider];
    if (definition.matchByApi && model.api === definition.api) return provider;
  }

  return undefined;
}

export function getConfiguredServiceTier(
  config: ServiceTierConfigSnapshot,
  provider: ServiceTierProvider | undefined,
): ServiceTierName | "" {
  return provider ? (config[provider] ?? "") : "";
}

export function resolveEffectiveServiceTier(
  config: ServiceTierConfigSnapshot,
  model: { api?: unknown; provider?: unknown } | undefined,
): ServiceTierName | "" {
  return getConfiguredServiceTier(config, getServiceTierProviderForModel(model));
}

function getTier(
  provider: ServiceTierProvider,
  serviceTierName: ServiceTierName,
): ServiceTier | undefined {
  return SERVICE_TIER_PROVIDER_DEFINITIONS[provider].tiers.find(
    (serviceTier) => serviceTier.name === serviceTierName,
  );
}

function applyPayloadServiceTier(
  payload: Record<string, unknown>,
  provider: ServiceTierProvider,
  serviceTier: ServiceTier,
): Record<string, unknown> {
  // Anthropic fast mode is applied as a top-level `speed` field, not
  // `service_tier`. The accompanying beta header is applied separately via the
  // model headers (see service-tier.ts), since request payloads cannot carry
  // headers.
  if (serviceTier.mechanism === "speed") {
    return { ...payload, speed: serviceTier.value };
  }

  if (provider === "google" || provider === "google-vertex") {
    return {
      ...payload,
      config: {
        ...(isRecord(payload.config) ? payload.config : {}),
        serviceTier: serviceTier.value,
      },
    };
  }

  return { ...payload, service_tier: serviceTier.value };
}

export function applyServiceTierToPayload(
  payload: unknown,
  config: ServiceTierConfigSnapshot,
  model: { api?: unknown; provider?: unknown } | undefined,
): unknown | undefined {
  const provider = getServiceTierProviderForModel(model);
  const serviceTierName = getConfiguredServiceTier(config, provider);
  if (!provider || !serviceTierName || !isRecord(payload)) return undefined;

  const serviceTier = getTier(provider, serviceTierName);
  if (!serviceTier) return undefined;

  return applyPayloadServiceTier(payload, provider, serviceTier);
}

/** All beta header values this extension manages across every provider/tier. */
export function getManagedBetaHeaders(): string[] {
  const headers = new Set<string>();
  for (const provider of SERVICE_TIER_PROVIDERS) {
    for (const serviceTier of SERVICE_TIER_PROVIDER_DEFINITIONS[provider].tiers) {
      if (serviceTier.betaHeader) headers.add(serviceTier.betaHeader);
    }
  }
  return [...headers];
}

/**
 * Beta header values required by the effective tier for `model`, given
 * `config`. Empty when no tier is configured or the tier needs no beta header.
 */
export function getRequiredBetaHeaders(
  config: ServiceTierConfigSnapshot,
  model: { api?: unknown; provider?: unknown } | undefined,
): string[] {
  const provider = getServiceTierProviderForModel(model);
  const serviceTierName = getConfiguredServiceTier(config, provider);
  if (!provider || !serviceTierName) return [];

  const serviceTier = getTier(provider, serviceTierName);
  return serviceTier?.betaHeader ? [serviceTier.betaHeader] : [];
}

export interface FastToggleResult {
  config: ServiceTierConfigSnapshot;
  provider: ServiceTierProvider;
  serviceTier: ServiceTierName | "";
  fast: boolean;
}

export function toggleFastServiceTier(
  config: ServiceTierConfigSnapshot,
  model: { api?: unknown; provider?: unknown } | undefined,
): FastToggleResult | undefined {
  const provider = getServiceTierProviderForModel(model);
  if (!provider) return undefined;

  const definition = SERVICE_TIER_PROVIDER_DEFINITIONS[provider];
  if (!definition.fastTier) return undefined;

  const current = getConfiguredServiceTier(config, provider);
  const fast = current !== definition.fastTier;
  const serviceTier = fast ? definition.fastTier : "";
  return {
    config: setProviderServiceTier(config, provider, serviceTier),
    provider,
    serviceTier,
    fast,
  };
}

export function setProviderServiceTier(
  config: ServiceTierConfigSnapshot,
  provider: ServiceTierProvider,
  value: ServiceTierName | "",
): ServiceTierConfigSnapshot {
  const next = { ...config };
  if (value === "") delete next[provider];
  else next[provider] = value;
  return next;
}

export type ServiceTierSectionId = "current" | "providers";

export interface ServiceTierSectionItem {
  id: ServiceTierProvider;
  label: string;
  currentValue: ServiceTierName | "off";
  values: readonly (ServiceTierName | "off")[];
  description: string;
}

export interface ServiceTierSection {
  id: ServiceTierSectionId;
  title: string;
  items: ServiceTierSectionItem[];
}

function buildSectionItem(
  provider: ServiceTierProvider,
  config: ServiceTierConfigSnapshot,
  currentModel?: { id?: unknown; name?: unknown },
): ServiceTierSectionItem {
  const definition = SERVICE_TIER_PROVIDER_DEFINITIONS[provider];
  const modelLabel =
    typeof currentModel?.name === "string" && currentModel.name
      ? currentModel.name
      : typeof currentModel?.id === "string" && currentModel.id
        ? currentModel.id
        : "";
  const label = modelLabel
    ? `${definition.label} (${modelLabel})`
    : definition.label;
  const configuredValue = getConfiguredServiceTier(config, provider);
  const currentValue = configuredValue || "off";
  const tierNames = definition.tiers.map((serviceTier) => serviceTier.name);
  return {
    id: provider,
    label,
    currentValue,
    values: ["off", ...tierNames],
    description: `${definition.label} supports ${tierNames.join(", ")}.`,
  };
}

export function createServiceTierSections(
  config: ServiceTierConfigSnapshot,
  model: { api?: unknown; provider?: unknown; id?: unknown; name?: unknown } | undefined,
): ServiceTierSection[] {
  const currentProvider = getServiceTierProviderForModel(model);
  const otherProviders = SERVICE_TIER_PROVIDERS.filter(
    (provider) => provider !== currentProvider,
  );
  const sections: ServiceTierSection[] = [];

  if (currentProvider) {
    sections.push({
      id: "current",
      title: "Current Model",
      items: [buildSectionItem(currentProvider, config, model)],
    });
  }

  sections.push({
    id: "providers",
    title: currentProvider ? "Other Providers" : "Providers",
    items: otherProviders.map((provider) => buildSectionItem(provider, config)),
  });

  return sections;
}
