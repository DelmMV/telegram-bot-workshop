#!/usr/bin/env node

/**
 * Скрипт для проверки конфигурации initData
 * Запуск: node check-config.js
 */

const config = require('./config')

console.log('🔍 Проверка конфигурации Telegram WebApp...\n')

// Проверка основных переменных
const checks = [
	{
		name: 'BOT_TOKEN',
		value: config.BOT_TOKEN ? '✅ Есть' : '❌ Отсутствует',
		critical: true
	},
	{
		name: 'MONGODB_URI',
		value: config.MONGODB_URI ? '✅ Есть' : '❌ Отсутствует',
		critical: true
	},
	{
		name: 'API_PORT',
		value: config.API_PORT,
		critical: false
	},
	{
		name: 'WEBAPP_URL',
		value: config.WEBAPP_URL || '❌ Отсутствует',
		critical: true
	},
	{
		name: 'WEBAPP_ORIGINS',
		value: config.WEBAPP_ORIGINS.length > 0 ? config.WEBAPP_ORIGINS.join(', ') : '❌ Отсутствует',
		critical: true
	},
	{
		name: 'WEBAPP_AUTH_MAX_AGE_SECONDS',
		value: config.WEBAPP_AUTH_MAX_AGE_SECONDS,
		critical: false
	}
]

checks.forEach(check => {
	const status = check.critical ? '[CRITICAL]' : '[INFO]'
	console.log(`${status} ${check.name}: ${check.value}`)
})

console.log('\n📋 Инструкция по настройке:\n')

console.log('1. Бэкенд (rating.js):')
console.log('   - Убедитесь, что сервер запущен на порту', config.API_PORT)
console.log('   - CORS уже настроен для:', config.WEBAPP_ORIGINS.join(', '))
console.log('   - Проверьте логи при запуске: должны быть "✅ Origin allowed"')

console.log('\n2. Фронтенд (webapp/.env.local):')
console.log('   - NEXT_PUBLIC_API_BASE_URL:', process.env.NEXT_PUBLIC_API_BASE_URL || 'https://service.monopiter.ru')
console.log('   - Убедитесь, что URL совпадает с вашим API сервером')

console.log('\n3. Тестирование:')
console.log('   - Откройте приложение через Telegram')
console.log('   - Проверьте консоль браузера на наличие ошибок')
console.log('   - Ищите логи: [API] Request, [API] Response')

console.log('\n4. Если initData пустой:')
console.log('   - Приложение должно открываться ТОЛЬКО через Telegram')
console.log('   - Проверьте, что бот корректно настроен')
console.log('   - Убедитесь, что Mini App привязан к боту')

console.log('\n🚀 Готово! Запустите сервер и проверьте логи.\n')