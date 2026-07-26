/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Top-level desde o Next 15.5; `experimental.typedRoutes` está deprecado.
  typedRoutes: true,
};

export default nextConfig;
