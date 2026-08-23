import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // Hides the Next.js dev-tools badge in the bottom-left corner so it cannot
  // appear over the dashboard during the demo. Dev-only UI; it never shipped
  // in the production build.
  devIndicators: false,
};

export default nextConfig;
