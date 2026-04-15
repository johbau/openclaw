import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOllamaDiffuserImageGenerationProvider } from "./image-generation-provider.js";

const PROVIDER_ID = "ollamadiffuser";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "OllamaDiffuser Provider",
  description: "Local AI image generation via OllamaDiffuser",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "OllamaDiffuser (local)",
      docsPath: "/providers/models",
      envVars: [],
      auth: [],
    });
    api.registerImageGenerationProvider(buildOllamaDiffuserImageGenerationProvider());
  },
});
