import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_MODEL = "dreamshaper";

const SUPPORTED_SIZES = [
  "512x512",
  "768x768",
  "1024x1024",
  "1024x1536",
  "1536x1024",
] as const;

type OllamaDiffuserHealthResponse = {
  status: string;
  model_loaded: boolean;
  current_model: string | null;
};

type OllamaDiffuserGenerateResponse = {
  image: string;
  format: string;
  width: number;
  height: number;
};

type PluginConfig = {
  baseUrl?: string;
  defaultModel?: string;
};

function resolvePluginConfig(cfg: ImageGenerationRequest["cfg"]): PluginConfig {
  const entries = cfg?.plugins?.entries as
    | Record<string, { config?: Record<string, unknown> }>
    | undefined;
  const raw = entries?.ollamadiffuser?.config;
  return {
    baseUrl: (raw?.baseUrl as string | undefined)?.trim(),
    defaultModel: (raw?.defaultModel as string | undefined)?.trim(),
  };
}

function resolveBaseUrl(cfg: ImageGenerationRequest["cfg"]): string {
  const pluginCfg = resolvePluginConfig(cfg);
  return (pluginCfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/u, "");
}

function resolveDefaultModel(cfg: ImageGenerationRequest["cfg"]): string {
  const pluginCfg = resolvePluginConfig(cfg);
  return pluginCfg.defaultModel || DEFAULT_MODEL;
}

function buildSsrFPolicy(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl);
    return {
      ...ssrfPolicyFromAllowPrivateNetwork(true),
      allowedHostnames: [parsed.hostname],
      hostnameAllowlist: [parsed.hostname],
    };
  } catch {
    return ssrfPolicyFromAllowPrivateNetwork(true);
  }
}

export function buildOllamaDiffuserImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "ollamadiffuser",
    label: "OllamaDiffuser (local)",
    defaultModel: DEFAULT_MODEL,
    models: [
      "stable-diffusion-1.5",
      "dreamshaper",
      "realistic-vision-v6",
      "realvisxl-v4",
      "sdxl-turbo",
      "sdxl-lightning-4step",
      "flux.1-schnell",
      "flux.1-dev",
      "stable-diffusion-3.5-medium",
      "stable-diffusion-3.5-large",
      "stable-diffusion-3.5-large-turbo",
      "sana-1.5",
      "pixart-sigma",
      "kolors",
      "cogview4",
      "auraflow",
    ],
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: false,
      },
      geometry: {
        sizes: [...SUPPORTED_SIZES],
      },
    },

    async generateImage(req: ImageGenerationRequest) {
      const baseUrl = resolveBaseUrl(req.cfg);
      const model = req.model?.trim() || resolveDefaultModel(req.cfg);
      const policy = buildSsrFPolicy(baseUrl);

      // Check health and auto-load model if needed
      const { response: healthRes, release: healthRelease } = await fetchWithSsrFGuard({
        url: `${baseUrl}/api/health`,
        policy,
        auditContext: "ollamadiffuser-health",
      });
      try {
        if (!healthRes.ok) {
          throw new Error(
            `OllamaDiffuser health check failed (${healthRes.status}): ${healthRes.statusText}`,
          );
        }
        const health = (await healthRes.json()) as OllamaDiffuserHealthResponse;

        if (!health.model_loaded || health.current_model !== model) {
          await healthRelease();

          const { response: loadRes, release: loadRelease } = await fetchWithSsrFGuard({
            url: `${baseUrl}/api/models/load`,
            init: {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model_name: model }),
            },
            policy,
            auditContext: "ollamadiffuser-load-model",
          });
          try {
            if (!loadRes.ok) {
              const text = await loadRes.text().catch(() => "");
              throw new Error(
                `Failed to load model ${model}: ${loadRes.status} ${text || loadRes.statusText}`,
              );
            }
          } finally {
            await loadRelease();
          }
        }
      } finally {
        await healthRelease().catch(() => {});
      }

      // Parse size
      let width = 1024;
      let height = 1024;
      if (req.size) {
        const match = /^(\d+)x(\d+)$/iu.exec(req.size.trim());
        if (match) {
          const w = Number.parseInt(match[1] ?? "", 10);
          const h = Number.parseInt(match[2] ?? "", 10);
          if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
            width = w;
            height = h;
          }
        }
      }

      // Generate image
      const { response: genRes, release: genRelease } = await fetchWithSsrFGuard({
        url: `${baseUrl}/api/generate`,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: req.prompt,
            width,
            height,
            response_format: "b64_json",
          }),
        },
        policy,
        auditContext: "ollamadiffuser-generate",
      });

      try {
        if (!genRes.ok) {
          const text = await genRes.text().catch(() => "");
          throw new Error(
            `OllamaDiffuser generation failed (${genRes.status}): ${text || genRes.statusText}`,
          );
        }

        const payload = (await genRes.json()) as OllamaDiffuserGenerateResponse;
        const buffer = Buffer.from(payload.image, "base64");
        const images: GeneratedImageAsset[] = [
          {
            buffer,
            mimeType: "image/png",
            fileName: "image-1.png",
          },
        ];

        return { images, model };
      } finally {
        await genRelease();
      }
    },
  };
}
