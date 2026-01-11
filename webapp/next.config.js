/** @type {import('next').NextConfig} */
const nextConfig = {
  // Для Vercel используем стандартную сборку Next.js
  // Для GitHub Pages нужно будет использовать отдельную сборку
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // Добавляем заголовки для Vercel
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'Content-Type, X-Telegram-Init-Data' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self' https://telegram.org https://*.telegram.org" }
        ]
      }
    ]
  }
}

module.exports = nextConfig
