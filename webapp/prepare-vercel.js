const fs = require('fs');
const path = require('path');

// Создаем директорию .vercel/output/static
const vercelStaticDir = path.join(__dirname, '.vercel', 'output', 'static');
fs.mkdirSync(vercelStaticDir, { recursive: true });

// Копируем статические файлы из .next/static
const nextStaticDir = path.join(__dirname, '.next', 'static');
const files = fs.readdirSync(nextStaticDir, { recursive: true });

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(entry => {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

copyDir(nextStaticDir, path.join(vercelStaticDir, 'static'));

// Создаем .vercel/output/functions
const functionsDir = path.join(__dirname, '.vercel', 'output', 'functions', 'index.func');
fs.mkdirSync(functionsDir, { recursive: true });

// Копируем server files
const serverDir = path.join(__dirname, '.next', 'server');
copyDir(serverDir, functionsDir);

// Создаем .vercel/config.json
const config = {
  version: 3,
  routes: [
    { handle: "filesystem" },
    { src: "/(.*)", dest: "/index" }
  ],
  headers: [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "ALLOWALL" },
        { key: "Access-Control-Allow-Origin", value: "*" },
        { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
        { key: "Access-Control-Allow-Headers", value: "Content-Type, X-Telegram-Init-Data" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://telegram.org https://*.telegram.org" }
      ]
    }
  ]
};

fs.writeFileSync(
  path.join(__dirname, '.vercel', 'output', 'config.json'),
  JSON.stringify(config, null, 2)
);

console.log('✅ Vercel structure prepared');
