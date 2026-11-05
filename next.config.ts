import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * `cacheComponents` is left off deliberately. It forbids the per-route
   * `export const runtime = 'nodejs'` declarations that this POC relies on, and
   * every route here is dynamic by nature: they talk to Salesforce and Gemini on
   * each request, so there is nothing to cache.
   */
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
