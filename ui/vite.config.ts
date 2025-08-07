import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import basicSsl from "@vitejs/plugin-basic-ssl";

declare const process: {
  env: {
    KVM_PROXY_URL: string;
    USE_SSL: string;
  };
};

export default defineConfig(({ mode, command }) => {
  const isCloud = mode.indexOf("cloud") !== -1;
  const onDevice = mode === "device";
  const { KVM_PROXY_URL, USE_SSL } = process.env;
  const useSSL = USE_SSL === "true";

  const plugins = [
    tailwindcss(),
    tsconfigPaths(),
    react()
  ];
  if (useSSL) {
    plugins.push(basicSsl());
  }

  return {
    plugins,
    build: { outDir: isCloud ? "dist" : "../static" },
    server: {
      host: "0.0.0.0",
      https: useSSL,
      proxy: KVM_PROXY_URL
        ? {
            "/me": KVM_PROXY_URL,
            "/device": KVM_PROXY_URL,
            "/webrtc": KVM_PROXY_URL,
            "/auth": KVM_PROXY_URL,
            "/storage": KVM_PROXY_URL,
            "/cloud": KVM_PROXY_URL,
            "/developer": KVM_PROXY_URL,
          }
        : undefined,
    },
    base: onDevice && command === "build" ? "/static" : "/",
  };
});
