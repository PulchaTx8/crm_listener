/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Top-level since Next 15.5; `experimental.typedRoutes` is deprecated.
  typedRoutes: true,
};

export default nextConfig;
