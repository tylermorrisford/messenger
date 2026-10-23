import type { NextConfig } from 'next';

// static export: the app is plain files on a CDN and talks to the API by URL
const nextConfig: NextConfig = {
  output: 'export',
};

export default nextConfig;
