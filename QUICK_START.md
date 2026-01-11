# ⚡ Быстрый старт: Исправление initData

## 🎯 Проблема
`initData` пустой → Telegram не передает данные → API возвращает ошибку авторизации

## ✅ Решение: Vercel (15 минут)

---

## 📋 Чек-лист (5 шагов):

### 1️⃣ Vercel.com → Войти через GitHub
```
vercel.com → Continue with GitHub
```

### 2️⃣ Import Project
```
→ Import Git Repository
→ Выбрать: telegram-bot-workshop
→ Root Directory: /webapp
→ Framework: Next.js
→ Environment: NEXT_PUBLIC_API_BASE_URL=https://service.monopiter.ru
→ Deploy
```

### 3️⃣ Скопировать URL
```
После деплоя: https://your-project.vercel.app
```

### 4️⃣ BotFather → Обновить URL
```
@BotFather → Ваш бот → Bot Settings → Menu Button → Edit Web App
→ Вставить: https://your-project.vercel.app
→ Save
```

### 5️⃣ Тест
```
→ Открыть бота в Telegram
→ Нажать кнопку Mini App
→ Проверить консоль (F12)
→ Успех: [DEBUG] Telegram WebApp initialized
```

---

## 📁 Что уже готово:
- ✅ `webapp/vercel.json` - заголовки
- ✅ `webapp/next.config.js` - конфиг
- ✅ `webapp/.env.local` - API URL
- ✅ `MIGRATION_TO_VERCEL.md` - инструкция

---

## 🎯 Результат после миграции:
- ✅ `initData` передается корректно
- ✅ Telegram WebApp API работает
- ✅ Все функции приложения доступны

---

## 🚀 Готово! Осталось только задеплоить на Vercel.