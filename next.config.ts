import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Everything in this app is per-request, authenticated data, so the Cache Components model is
  // not used; pages render dynamically.
  serverExternalPackages: ["pg"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
