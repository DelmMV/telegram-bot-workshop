const { Telegraf, Scenes, session } = require('telegraf')
const { MongoClient, ObjectId } = require('mongodb')
const { Markup } = require('telegraf')
const crypto = require('crypto')
const express = require('express')
const config = require('./config')

// Проверка конфига
if (!config.BOT_TOKEN) {
	console.error('ERROR: BOT_TOKEN not set in config.js or .env')
	process.exit(1)
}
if (!config.MONGODB_URI) {
	console.error('ERROR: MONGODB_URI not set in config.js or .env')
	process.exit(1)
}
console.log('Loaded config:', {
	API_PORT: config.API_PORT,
	WEBAPP_ORIGINS: config.WEBAPP_ORIGINS,
	BOT_TOKEN: config.BOT_TOKEN ? '***' : 'MISSING',
	MONGODB_URI: config.MONGODB_URI ? '***' : 'MISSING',
})


// Инициализация бота
const bot = new Telegraf(config.BOT_TOKEN)
const ADMIN_CHAT_ID = config.ADMIN_CHAT_ID
//ограничим для комментариев по символами
const MAX_FEEDBACK_LENGTH = 1000
// MongoDB connection
const mongoClient = new MongoClient(config.MONGODB_URI)
let db

// Список разрешенных пользователей (админов)
const ADMIN_IDS = config.ADMIN_IDS

// Функция проверки является ли пользователь админом
function isAdmin(userId) {
	return ADMIN_IDS.includes(userId)
}

function escapeHTML(text) {
	const normalizedText = text == null ? '' : String(text)
	return normalizedText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Функция экранирования специальных символов Markdown
function escapeMarkdown(text) {
	const normalizedText = text == null ? '' : String(text)
	return normalizedText.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

function isIgnoredTelegramError(error) {
	const errorCode = error?.response?.error_code
	if (errorCode !== 400) return false
	const description = error?.response?.description ?? ''
	return (
		description.includes('message is not modified') ||
		description.includes('query is too old') ||
		description.includes('query ID is invalid')
	)
}

function getInitDataFromRequest(req) {
	const headerInitData = req.headers['x-telegram-init-data']
	if (typeof headerInitData === 'string') return headerInitData
	if (Array.isArray(headerInitData) && headerInitData[0]) return headerInitData[0]
	if (typeof req.body?.initData === 'string') return req.body.initData
	if (typeof req.query?.initData === 'string') return req.query.initData
	return ''
}

function buildDataCheckString(params) {
	return [...params.entries()]
		.sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
		.map(([key, value]) => `${key}=${value}`)
		.join('\n')
}

function getTelegramUserFromParams(params) {
	const userValue = params.get('user')
	if (!userValue) return null
	try {
		return JSON.parse(userValue)
	} catch (error) {
		return null
	}
}

function validateWebAppInitData(initData, botToken, maxAgeSeconds) {
	if (!initData || !botToken) {
		return { isValid: false, reason: 'missing_init_data' }
	}

	const params = new URLSearchParams(initData)
	const hash = params.get('hash')
	if (!hash) {
		return { isValid: false, reason: 'missing_hash' }
	}

	params.delete('hash')
	const dataCheckString = buildDataCheckString(params)
	const secretKey = crypto
		.createHmac('sha256', 'WebAppData')
		.update(botToken)
		.digest()
	const calculatedHash = crypto
		.createHmac('sha256', secretKey)
		.update(dataCheckString)
		.digest('hex')

	if (calculatedHash !== hash) {
		return { isValid: false, reason: 'invalid_hash' }
	}

	const authDate = Number(params.get('auth_date'))
	if (Number.isFinite(authDate) && maxAgeSeconds) {
		const nowSeconds = Math.floor(Date.now() / 1000)
		if (nowSeconds - authDate > maxAgeSeconds) {
			return { isValid: false, reason: 'expired_init_data' }
		}
	}

	return {
		isValid: true,
		user: getTelegramUserFromParams(params),
		data: Object.fromEntries(params.entries()),
	}
}

function requireWebAppAuth(req, res, next) {
	const initData = getInitDataFromRequest(req)
	const validation = validateWebAppInitData(
		initData,
		config.BOT_TOKEN,
		config.WEBAPP_AUTH_MAX_AGE_SECONDS
	)

	if (!validation.isValid) {
		return res.status(401).json({
			ok: false,
			error: 'unauthorized',
			reason: validation.reason,
		})
	}

	req.telegramUser = validation.user
	req.telegramInitData = initData
	return next()
}

// Функции для работы с базой данных
async function getWorkshops() {
	try {
		const workshops = await db
			.collection('workshops')
			.find({})
			.collation({ locale: 'ru' })
			.sort({ name: 1 })
			.toArray()
		return workshops
	} catch (error) {
		console.error('Error getting workshops:', error)
		return []
	}
}

async function buildAdminFeedbackMessage(feedback) {
	const workshop = await db
		.collection('workshops')
		.findOne({ name: feedback.workshop })

	const truncatedFeedback =
		feedback.text_feedback.length > MAX_FEEDBACK_LENGTH
			? feedback.text_feedback.substring(0, MAX_FEEDBACK_LENGTH) + '...'
			: feedback.text_feedback

	let message = '📝 <b>Новый отзыв!</b>\n\n'
	message += `👤 <b>Пользователь:</b> ${escapeHTML(feedback.first_name)}`
	if (feedback.last_name) message += ` ${escapeHTML(feedback.last_name)}`
	if (feedback.username) message += ` (@${escapeHTML(feedback.username)})`
	message += `\n🆔 ID: <code>${feedback.user_id}</code>\n\n`

	message += `🏢 <b>Мастерская:</b> ${escapeHTML(feedback.workshop)}\n`
	if (workshop) {
		message += `📍 <b>Адрес:</b> ${escapeHTML(workshop.address)}\n`
	}

	message += `📊 <b>Оценки:</b>\n`
	message += `⭐️ Качество: ${feedback.quality_rating}/5\n`
	message += `💬 Коммуникация: ${feedback.communication_rating}/5\n`
	message += `⏰ Выполнено вовремя: ${feedback.on_time}\n\n`

	message += `💭 <b>Отзыв:</b> ${escapeHTML(truncatedFeedback)}\n\n`

	const stats = await getWorkshopStats(feedback.workshop)
	message += `📈 <b>Текущая статистика мастерской:</b>\n`
	message += `📝 Всего отзывов: ${stats.total_reviews}\n`
	message += `⭐️ Средняя оценка качества: ${
		stats.avg_quality ? stats.avg_quality.toFixed(2) : '0'
	}/5\n`
	message += `💬 Средняя оценка коммуникации: ${
		stats.avg_communication ? stats.avg_communication.toFixed(2) : '0'
	}/5\n`
	message += `✅ Выполнено вовремя: ${stats.on_time_count}\n`
	message += `❌ С задержкой: ${stats.delayed_count}\n\n`

	message += `🗑 Удалить отзыв: /delete_feedback ${feedback._id}`

	return message
}

async function sendAdminFeedbackNotification(telegram, feedback) {
	if (!ADMIN_CHAT_ID || !telegram) return
	const message = await buildAdminFeedbackMessage(feedback)
	await telegram.sendMessage(ADMIN_CHAT_ID, message, {
		parse_mode: 'HTML',
		disable_web_page_preview: true,
	})
}

async function notifyAdminsAboutNewFeedback(ctx, feedback) {
	try {
		await sendAdminFeedbackNotification(ctx.telegram, feedback)
	} catch (error) {
		console.error('Error sending admin notification:', error)
	}
}

async function notifyAdminsAboutNewFeedbackFromApi(feedback) {
	try {
		await sendAdminFeedbackNotification(bot.telegram, feedback)
	} catch (error) {
		console.error('Error sending admin notification:', error)
	}
}

async function addWorkshop(data) {
	try {
		const exists = await db.collection('workshops').findOne({ name: data.name })
		if (exists) {
			return false
		}
		await db.collection('workshops').insertOne({
			name: data.name,
			address: data.address,
			description: data.description,
			created_at: new Date(),
		})
		return true
	} catch (error) {
		console.error('Error adding workshop:', error)
		return false
	}
}

async function getAllFeedbacks(limit = 50) {
	return await db
		.collection('feedback')
		.find({})
		.sort({ created_at: -1 })
		.limit(limit)
		.toArray()
}

async function getUserFeedbacks(userId) {
	return await db
		.collection('feedback')
		.find({ user_id: userId })
		.sort({ created_at: -1 })
		.toArray()
}

async function getWorkshopStats(workshop) {
	const aggregation = await db
		.collection('feedback')
		.aggregate([
			{ $match: { workshop: workshop } },
			{
				$group: {
					_id: null,
					total_reviews: { $sum: 1 },
					avg_quality: { $avg: '$quality_rating' },
					avg_communication: { $avg: '$communication_rating' },
					on_time_count: {
						$sum: { $cond: [{ $eq: ['$on_time', 'Да'] }, 1, 0] },
					},
					delayed_count: {
						$sum: { $cond: [{ $eq: ['$on_time', 'Нет'] }, 1, 0] },
					},
				},
			},
		])
		.toArray()

	return (
		aggregation[0] || {
			total_reviews: 0,
			avg_quality: 0,
			avg_communication: 0,
			on_time_count: 0,
			delayed_count: 0,
		}
	)
}

async function getLastReviews(workshop, limit = 3) {
	// Получаем все отзывы для мастерской
	const allReviews = await db
		.collection('feedback')
		.find({ workshop: workshop })
		.sort({ created_at: -1 })
		.toArray()

	// Фильтруем отзывы, оставляя только те, где есть текстовый комментарий
	const reviewsWithText = allReviews.filter(
		review => review.text_feedback && review.text_feedback.trim() !== ''
	)

	// Возвращаем первые 3 отзыва с текстом
	return reviewsWithText.slice(0, limit)
}

async function getWorkshopsList() {
	const workshops = await getWorkshops()
	const workshopsData = []

	for (const workshop of workshops) {
		const feedbacks = await db
			.collection('feedback')
			.find({ workshop: workshop.name })
			.toArray()

		const total_reviews = feedbacks.length
		const on_time_count = feedbacks.filter(f => f.on_time === 'Да').length

		const onTimePercentage =
			total_reviews > 0
				? ((on_time_count / total_reviews) * 100).toFixed(1)
				: '0.0'

		workshopsData.push({
			name: workshop.name,
			address: workshop.address,
			description: workshop.description,
			avg_quality: calculateAverage(feedbacks, 'quality_rating'),
			avg_communication: calculateAverage(feedbacks, 'communication_rating'),
			total_reviews: total_reviews,
			on_time_count: on_time_count,
			on_time_percentage: onTimePercentage,
		})
	}

	return workshopsData
}

function calculateAverage(feedbacks, field) {
	if (feedbacks.length === 0) return '0.00'
	const sum = feedbacks.reduce((acc, curr) => acc + (curr[field] || 0), 0)
	return (sum / feedbacks.length).toFixed(2)
}

function buildOverallRatingEntries(workshops) {
	return workshops.map(workshop => {
		const qualityScore = parseFloat(workshop.avg_quality) || 0
		const communicationScore = parseFloat(workshop.avg_communication) || 0
		const onTimePercentage = parseFloat(workshop.on_time_percentage) / 100 || 0
		const reviewCount = workshop.total_reviews
		const baseRating = qualityScore * 0.8 + communicationScore * 0.2
		const overallRating = baseRating * onTimePercentage * Math.log(reviewCount + 1)

		return {
			...workshop,
			base_rating: baseRating,
			overall_rating: overallRating,
			quality_score: qualityScore,
			communication_score: communicationScore,
			on_time_percentage_decimal: onTimePercentage,
			log_factor: Math.log(reviewCount + 1),
		}
	})
}

function normalizeOnTimeValue(value) {
	if (value === true || value === 'Да' || value === 'да') return 'Да'
	if (value === false || value === 'Нет' || value === 'нет') return 'Нет'
	return null
}

function isValidRating(value) {
	return Number.isInteger(value) && value >= 1 && value <= 5
}

/**
 * Функция расчета общего рейтинга по формуле:
 * Рейтинг = (Качество * 0.8 + Коммуникации * 0.2) * %_вовремя * log(Количество_отзывов + 1)
 */
async function getOverallRating() {
	const workshops = await getWorkshopsList()

	const workshopsWithRating = workshops.map(workshop => {
		const qualityScore = parseFloat(workshop.avg_quality) || 0
		const communicationScore = parseFloat(workshop.avg_communication) || 0
		const onTimePercentage = parseFloat(workshop.on_time_percentage) / 100 // конвертируем в 0-1
		const reviewCount = workshop.total_reviews

		// Применяем формулу:
		// Рейтинг = (Качество * 0.8 + Коммуникации * 0.2) * %_вовремя * log(Количество_отзывов + 1)
		const baseRating = qualityScore * 0.8 + communicationScore * 0.2
		const overallRating =
			baseRating * onTimePercentage * Math.log(reviewCount + 1)

		return {
			...workshop,
			base_rating: baseRating,
			overall_rating: overallRating,
			quality_score: qualityScore,
			communication_score: communicationScore,
			on_time_percentage_decimal: onTimePercentage,
			log_factor: Math.log(reviewCount + 1),
		}
	})

	// Сортируем по общему рейтингу (от большего к меньшему)
	workshopsWithRating.sort((a, b) => b.overall_rating - a.overall_rating)

	return workshopsWithRating
}

function formatWorkshopsListMessage(workshops) {
	if (workshops.length === 0) {
		return 'В данный момент нет доступных мастерских.'
	}

	let message = '📋 *Список сервисов:*\n\n'
	workshops.forEach((workshop, index) => {
		message += `*${index + 1}. ${workshop.name}*\n`
		message += `📍 *Адрес:* ${workshop.address}\n`
		message += `ℹ️ *Описание:* ${workshop.description}\n`
		message += `⭐️ *Средняя оценка качества:* ${workshop.avg_quality}/5\n`
		message += `💬 *Средняя оценка коммуникации:* ${workshop.avg_communication}/5\n`
		message += `✅ *Выполнено вовремя:* ${workshop.on_time_percentage}%\n`
		message += `📝 *Всего отзывов:* ${workshop.total_reviews}\n\n`
	})
	return message
}

function formatFeedbackMessage(feedback, includeDeleteButton = true) {
	let message = ''
	const userName =
		feedback.first_name + (feedback.last_name ? ` ${feedback.last_name}` : '')

	message += `👤 Пользователь: ${userName} (ID: ${feedback.user_id})\n`
	message += `🏢 Мастерская: ${feedback.workshop}\n`
	message += `⭐️ Качество: ${feedback.quality_rating}\n`
	message += `💬 Коммуникация: ${feedback.communication_rating}\n`
	message += `⏰ Вовремя: ${feedback.on_time}\n`
	message += `📝 Отзыв: ${feedback.text_feedback}\n`
	message += `📅 Дата: ${new Date(feedback.created_at).toLocaleString()}\n`

	if (includeDeleteButton) {
		message += `\n🗑 Удалить: /delete_feedback ${feedback._id}\n`
	}

	return message
}

// Функция создания админской клавиатуры
function getAdminKeyboard() {
	return Markup.inlineKeyboard([
		[Markup.button.callback('📊 Последние отзывы', 'admin_all_feedbacks')],
		[Markup.button.callback('🔍 Поиск пользователя', 'admin_search_user')],
		[Markup.button.callback('🏆 Сезонный рейтинг', 'admin_seasonal_rating')],
		[Markup.button.callback('➕ Добавить мастерскую', 'admin_add_workshop')],
		[Markup.button.callback('❌ Удалить мастерскую', 'admin_remove_workshop')],
		[Markup.button.callback('📋 Список мастерских', 'admin_list_workshops')],
	])
}

// Создаем клавиатуру для главного меню
function getMainKeyboard() {
	const rows = [
		['👍 Оставить отзыв', '📊 Рейтинг/Отзывы'],
		['📋 Список сервисов', 'ℹ️ Помощь'],
	]
	if (config.WEBAPP_URL) {
		rows.push(['🧩 Мини-приложение'])
	}
	return Markup.keyboard(rows).resize()
}

function getWebAppButtonMarkup() {
	if (!config.WEBAPP_URL) return null
	return Markup.inlineKeyboard([
		[Markup.button.webApp('Открыть мини-приложение', config.WEBAPP_URL)],
	])
}

async function setupWebAppMenuButton() {
	if (!config.WEBAPP_URL) return
	try {
		await bot.telegram.setChatMenuButton({
			menu_button: {
				type: 'web_app',
				text: 'Мини-приложение',
				web_app: { url: config.WEBAPP_URL },
			},
		})
	} catch (error) {
		console.error('Error setting web app menu button:', error)
	}
}

// Сцены для голосования
const workshopScene = new Scenes.BaseScene('workshop')
workshopScene.enter(async ctx => {
	const workshops = await getWorkshops()
	if (workshops.length === 0) {
		ctx.reply('В данный момент нет доступных мастерских.')
		return ctx.scene.leave()
	}

	ctx.reply(
		'Выберите мастерскую:',
		Markup.inlineKeyboard(
			workshops.map(workshop => [
				Markup.button.callback(workshop.name, `workshop_${workshop.name}`),
			])
		)
	)
})

workshopScene.action(/workshop_(.+)/, ctx => {
	const workshop = ctx.match[1]
	ctx.session.workshop = workshop
	ctx.editMessageReplyMarkup({ inline_keyboard: [] })
	ctx.reply(`Вы выбрали: ${workshop}`)
	ctx.scene.enter('quality')
})

const qualityScene = new Scenes.BaseScene('quality')
qualityScene.enter(ctx => {
	ctx.reply(
		'Оцените качество работы от 1 до 5:',
		Markup.keyboard([['1', '2', '3', '4', '5']])
			.oneTime()
			.resize()
	)
})

qualityScene.on('text', ctx => {
	if (!['1', '2', '3', '4', '5'].includes(ctx.message.text)) {
		return ctx.reply('Пожалуйста, выберите оценку от 1 до 5')
	}
	ctx.session.quality = parseInt(ctx.message.text)
	ctx.scene.enter('onTime')
})

const onTimeScene = new Scenes.BaseScene('onTime')
onTimeScene.enter(ctx => {
	ctx.reply(
		'Ремонт осуществлен в оговоренный срок?',
		Markup.keyboard([['Да', 'Нет']])
			.oneTime()
			.resize()
	)
})

onTimeScene.on('text', ctx => {
	if (!['Да', 'Нет'].includes(ctx.message.text)) {
		return ctx.reply('Пожалуйста, выберите Да или Нет')
	}
	ctx.session.onTime = ctx.message.text
	ctx.scene.enter('communication')
})

const communicationScene = new Scenes.BaseScene('communication')
communicationScene.enter(ctx => {
	ctx.reply(
		'Оцените коммуникацию с мастерской от 1 до 5:',
		Markup.keyboard([['1', '2', '3', '4', '5']])
			.oneTime()
			.resize()
	)
})

communicationScene.on('text', ctx => {
	if (!['1', '2', '3', '4', '5'].includes(ctx.message.text)) {
		return ctx.reply('Пожалуйста, выберите оценку от 1 до 5')
	}
	ctx.session.communication = parseInt(ctx.message.text)
	ctx.scene.enter('textFeedback')
})

const textFeedbackScene = new Scenes.BaseScene('textFeedback')
textFeedbackScene.enter(ctx => {
	ctx.reply(
		`Пожалуйста, напишите ваш отзыв о мастерской (максимум ${MAX_FEEDBACK_LENGTH} символов)\n` +
			'или нажмите кнопку "Пропустить" если не хотите оставлять текстовый отзыв:',
		Markup.keyboard([['Пропустить']])
			.oneTime()
			.resize()
	)
})

textFeedbackScene.on('text', async ctx => {
	// Проверяем, хочет ли пользователь пропустить текстовый отзыв
	if (ctx.message.text === 'Пропустить') {
		ctx.session.textFeedback = '' // Пустой текстовый отзыв
	} else {
		// Проверка длины отзыва
		if (ctx.message.text.length > MAX_FEEDBACK_LENGTH) {
			await ctx.reply(
				`⚠️ Отзыв слишком длинный. Максимальная длина - ${MAX_FEEDBACK_LENGTH} символов.\n` +
					`Ваш текст содержит ${ctx.message.text.length} символов.\n\n` +
					`Пожалуйста, сократите отзыв и отправьте снова, или нажмите "Пропустить":`,
				Markup.keyboard([['Пропустить']])
					.oneTime()
					.resize()
			)
			return
		}
		ctx.session.textFeedback = ctx.message.text
	}

	// Формируем предпросмотр отзыва
	const feedback = {
		user_id: ctx.from.id,
		first_name: ctx.from.first_name,
		last_name: ctx.from.last_name,
		username: ctx.from.username,
		workshop: ctx.session.workshop,
		quality_rating: ctx.session.quality,
		on_time: ctx.session.onTime,
		communication_rating: ctx.session.communication,
		text_feedback: ctx.session.textFeedback,
		created_at: new Date(),
	}

	// Объявляем и формируем сообщение предпросмотра
	let previewMessage = '📝 <b>Предпросмотр вашего отзыва:</b>\n\n'
	previewMessage += `<b>🏢 Мастерская:</b> ${escapeHTML(feedback.workshop)}\n`
	previewMessage += `<b>⭐️ Качество:</b> ${feedback.quality_rating}/5\n`
	previewMessage += `<b>💬 Коммуникация:</b> ${feedback.communication_rating}/5\n`
	previewMessage += `<b>⏰ Выполнено вовремя:</b> ${feedback.on_time}\n`
	if (feedback.text_feedback) {
		previewMessage += `📝 <b>Комментарий:</b> ${escapeHTML(
			feedback.text_feedback
		)}\n`
	}

	await ctx.reply(previewMessage, {
		parse_mode: 'HTML',
		reply_markup: Markup.inlineKeyboard([
			[
				Markup.button.callback('✅ Подтвердить', 'confirm_feedback'),
				Markup.button.callback('❌ Отменить', 'cancel_feedback'),
			],
		]).reply_markup,
	})
})

// Обработчик подтверждения отзыва
textFeedbackScene.action('confirm_feedback', async ctx => {
	try {
		const feedback = {
			user_id: ctx.from.id,
			first_name: ctx.from.first_name,
			last_name: ctx.from.last_name,
			username: ctx.from.username,
			workshop: ctx.session.workshop,
			quality_rating: ctx.session.quality,
			on_time: ctx.session.onTime,
			communication_rating: ctx.session.communication,
			text_feedback: ctx.session.textFeedback,
			created_at: new Date(),
		}

		// Сохраняем отзыв в базу данных
		const result = await db.collection('feedback').insertOne(feedback)
		feedback._id = result.insertedId

		// Отправляем сообщение пользователю
		await ctx.answerCbQuery('Спасибо за ваш отзыв!')
		await ctx.reply('✅ Ваш отзыв успешно сохранен!', getMainKeyboard())

		// Отправляем уведомление админам
		await notifyAdminsAboutNewFeedback(ctx, feedback)

		ctx.scene.leave()
	} catch (error) {
		console.error('Error saving feedback:', error)
		await ctx.answerCbQuery('Произошла ошибка при сохранении отзыва.')
		await ctx.reply(
			'❌ Произошла ошибка при сохранении отзыва.',
			getMainKeyboard()
		)
		ctx.scene.leave()
	}
})

// Обработчик отмены отзыва
textFeedbackScene.action('cancel_feedback', async ctx => {
	await ctx.answerCbQuery('Отзыв отменен')
	await ctx.reply('❌ Отзыв отменен.', getMainKeyboard())
	ctx.scene.leave()
})

// Сцена поиска пользователя
const searchUserScene = new Scenes.BaseScene('search_user_scene')
searchUserScene.enter(async ctx => {
	await ctx.editMessageText(
		'Введите имя или username пользователя для поиска:',
		Markup.inlineKeyboard([[Markup.button.callback('« Отмена', 'admin_back')]])
	)
})

searchUserScene.on('text', async ctx => {
	try {
		const users = await db
			.collection('feedback')
			.aggregate([
				{
					$match: {
						$or: [
							{ first_name: { $regex: ctx.message.text, $options: 'i' } },
							{ last_name: { $regex: ctx.message.text, $options: 'i' } },
							{ username: { $regex: ctx.message.text, $options: 'i' } },
						],
					},
				},
				{
					$group: {
						_id: '$user_id',
						first_name: { $first: '$first_name' },
						last_name: { $first: '$last_name' },
						username: { $first: '$username' },
						feedback_count: { $sum: 1 },
					},
				},
			])
			.toArray()

		if (users.length === 0) {
			await ctx.reply('Пользователи не найдены.')
		} else {
			let message = '🔍 Найденные пользователи:\n\n'
			const keyboard = []

			users.forEach(user => {
				const userName =
					user.first_name + (user.last_name ? ` ${user.last_name}` : '')
				message += `👤 ${userName}\n`
				if (user.username) message += `@${user.username}\n`
				message += `ID: ${user._id}\n`
				message += `Количество отзывов: ${user.feedback_count}\n\n`

				keyboard.push([
					Markup.button.callback(
						`Отзывы ${userName}`,
						`user_feedbacks_${user._id}`
					),
				])
			})

			keyboard.push([Markup.button.callback('« Назад', 'admin_back')])

			await ctx.reply(message, Markup.inlineKeyboard(keyboard))
		}
		ctx.scene.leave()
	} catch (error) {
		console.error('Error searching users:', error)
		await ctx.reply('Произошла ошибка при поиске пользователей.')
		ctx.scene.leave()
	}
})

// Сцена добавления мастерской
const addWorkshopScene = new Scenes.BaseScene('add_workshop_scene')
addWorkshopScene.enter(async ctx => {
	ctx.session.workshop = {}
	await ctx.editMessageText(
		'Введите название новой мастерской:',
		Markup.inlineKeyboard([[Markup.button.callback('« Отмена', 'admin_back')]])
	)
})

addWorkshopScene.on('text', async ctx => {
	if (!ctx.session.workshop.name) {
		ctx.session.workshop.name = ctx.message.text
		await ctx.reply('Теперь введите адрес мастерской:')
		return
	}

	if (!ctx.session.workshop.address) {
		ctx.session.workshop.address = ctx.message.text
		await ctx.reply('Теперь введите описание мастерской:')
		return
	}

	if (!ctx.session.workshop.description) {
		ctx.session.workshop.description = ctx.message.text

		// Показываем предпросмотр и запрашиваем подтверждение
		const previewMessage =
			`📍 Проверьте данные:\n\n` +
			`Название: ${ctx.session.workshop.name}\n` +
			`Адрес: ${ctx.session.workshop.address}\n` +
			`Описание: ${ctx.session.workshop.description}`

		await ctx.reply(
			previewMessage,
			Markup.inlineKeyboard([
				[
					Markup.button.callback('✅ Подтвердить', 'confirm_workshop_add'),
					Markup.button.callback('❌ Отменить', 'cancel_workshop_add'),
				],
			])
		)
	}
})

addWorkshopScene.action('confirm_workshop_add', async ctx => {
	try {
		const success = await addWorkshop(ctx.session.workshop)
		if (success) {
			await ctx.answerCbQuery('Мастерская успешно добавлена!')
			await ctx.reply(
				`Мастерская "${ctx.session.workshop.name}" успешно добавлена.`
			)
		} else {
			await ctx.answerCbQuery('Мастерская с таким названием уже существует.')
			await ctx.reply('Мастерская с таким названием уже существует.')
		}
	} catch (error) {
		console.error('Error adding workshop:', error)
		await ctx.reply('Произошла ошибка при добавлении мастерской.')
	}
	ctx.scene.leave()
})

addWorkshopScene.action('cancel_workshop_add', async ctx => {
	await ctx.answerCbQuery('Добавление мастерской отменено')
	await ctx.reply('Добавление мастерской отменено.')
	ctx.scene.leave()
})

// Сцена добавления сезона
const addSeasonScene = new Scenes.BaseScene('add_season_scene')
addSeasonScene.enter(async ctx => {
	ctx.session.season = {}
	await ctx.editMessageText(
		'Введите название нового сезона (например, "Зимний сезон 2024/2025"):',
		Markup.inlineKeyboard([
			[Markup.button.callback('« Отмена', 'admin_seasonal_back')],
		])
	)
})

addSeasonScene.on('text', async ctx => {
	if (!ctx.session.season.name) {
		ctx.session.season.name = ctx.message.text
		await ctx.reply('Теперь введите описание сезона:')
		return
	}

	if (!ctx.session.season.description) {
		ctx.session.season.description = ctx.message.text
		await ctx.reply(
			'Введите дату начала сезона в формате ДД.ММ.ГГГГ (например, 25.04.2025):'
		)
		return
	}

	if (!ctx.session.season.start_date) {
		const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/
		const match = ctx.message.text.match(dateRegex)

		if (!match) {
			await ctx.reply(
				'Неверный формат даты. Используйте формат ДД.ММ.ГГГГ (например, 25.04.2025):'
			)
			return
		}

		const [, day, month, year] = match
		const startDate = new Date(year, month - 1, day)

		if (isNaN(startDate.getTime())) {
			await ctx.reply(
				'Неверная дата. Введите корректную дату в формате ДД.ММ.ГГГГ:'
			)
			return
		}

		ctx.session.season.start_date = startDate
		await ctx.reply(
			'Введите дату окончания сезона в формате ДД.ММ.ГГГГ или напишите "Не указывать" если сезон текущий:',
			Markup.keyboard([['Не указывать']])
				.oneTime()
				.resize()
		)
		return
	}

	if (!ctx.session.season.hasOwnProperty('end_date')) {
		if (ctx.message.text === 'Не указывать') {
			ctx.session.season.end_date = null
		} else {
			const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/
			const match = ctx.message.text.match(dateRegex)

			if (!match) {
				await ctx.reply(
					'Неверный формат даты. Используйте формат ДД.ММ.ГГГГ или "Не указывать":'
				)
				return
			}

			const [, day, month, year] = match
			const endDate = new Date(year, month - 1, day)

			if (isNaN(endDate.getTime())) {
				await ctx.reply(
					'Неверная дата. Введите корректную дату в формате ДД.ММ.ГГГГ:'
				)
				return
			}

			if (endDate <= ctx.session.season.start_date) {
				await ctx.reply(
					'Дата окончания должна быть позже даты начала. Введите корректную дату:'
				)
				return
			}

			ctx.session.season.end_date = endDate
		}

		// Показываем предпросмотр
		const startDateStr =
			ctx.session.season.start_date.toLocaleDateString('ru-RU')
		const endDateStr = ctx.session.season.end_date
			? ctx.session.season.end_date.toLocaleDateString('ru-RU')
			: 'Не указана (текущий сезон)'

		const previewMessage =
			`📅 Проверьте данные сезона:\n\n` +
			`Название: ${ctx.session.season.name}\n` +
			`Описание: ${ctx.session.season.description}\n` +
			`Дата начала: ${startDateStr}\n` +
			`Дата окончания: ${endDateStr}`

		await ctx.reply(
			previewMessage,
			Markup.inlineKeyboard([
				[
					Markup.button.callback('✅ Подтвердить', 'confirm_season_add'),
					Markup.button.callback('❌ Отменить', 'cancel_season_add'),
				],
			])
		)
	}
})

addSeasonScene.action('confirm_season_add', async ctx => {
	try {
		const result = await addSeason(ctx.session.season)
		if (result.success) {
			await ctx.answerCbQuery('Сезон успешно добавлен!')
			await ctx.reply(`Сезон "${ctx.session.season.name}" успешно добавлен.`)
		} else {
			await ctx.answerCbQuery(result.message)
			await ctx.reply(result.message)
		}
	} catch (error) {
		console.error('Error adding season:', error)
		await ctx.reply('Произошла ошибка при добавлении сезона.')
	}
	ctx.scene.leave()
})

addSeasonScene.action('cancel_season_add', async ctx => {
	await ctx.answerCbQuery('Добавление сезона отменено')
	await ctx.reply('Добавление сезона отменено.')
	ctx.scene.leave()
})

addSeasonScene.action('admin_seasonal_back', async ctx => {
	await ctx.answerCbQuery('Добавление отменено')
	ctx.scene.leave()
})

// Сцена завершения сезона
const endSeasonScene = new Scenes.BaseScene('end_season_scene')
endSeasonScene.enter(async ctx => {
	await ctx.editMessageText(
		'Введите дату окончания сезона в формате ДД.ММ.ГГГГ:',
		Markup.inlineKeyboard([
			[Markup.button.callback('« Отмена', 'admin_seasonal_back')],
		])
	)
})

endSeasonScene.on('text', async ctx => {
	const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/
	const match = ctx.message.text.match(dateRegex)

	if (!match) {
		await ctx.reply(
			'Неверный формат даты. Используйте формат ДД.ММ.ГГГГ (например, 15.10.2025):'
		)
		return
	}

	const [, day, month, year] = match
	const endDate = new Date(year, month - 1, day)

	if (isNaN(endDate.getTime())) {
		await ctx.reply(
			'Неверная дата. Введите корректную дату в формате ДД.ММ.ГГГГ:'
		)
		return
	}

	try {
		const success = await updateSeasonEndDate(
			ctx.session.selectedSeasonId,
			endDate
		)
		if (success) {
			await ctx.reply(
				`✅ Дата окончания сезона успешно установлена: ${endDate.toLocaleDateString(
					'ru-RU'
				)}`
			)
		} else {
			await ctx.reply('❌ Произошла ошибка при обновлении сезона.')
		}
	} catch (error) {
		console.error('Error updating season:', error)
		await ctx.reply('Произошла ошибка при обновлении сезона.')
	}

	ctx.scene.leave()
})

endSeasonScene.action('admin_seasonal_back', async ctx => {
	await ctx.answerCbQuery('Завершение отменено')
	ctx.scene.leave()
})

// Создание stage
const stage = new Scenes.Stage([
	workshopScene,
	qualityScene,
	onTimeScene,
	communicationScene,
	textFeedbackScene,
	searchUserScene,
	addWorkshopScene,
	addSeasonScene,
	endSeasonScene,
])

	// Подключение middleware
	bot.use(session())
	bot.use(stage.middleware())

	// Логирование сообщений для отладки
	bot.use((ctx, next) => {
		console.log('[BOT] Update type:', ctx.updateType)
		if (ctx.message) {
			console.log('[BOT] Message:', ctx.message.text, 'from', ctx.from?.id)
		}
		if (ctx.callbackQuery) {
			console.log('[BOT] Callback:', ctx.callbackQuery.data, 'from', ctx.from?.id)
		}
		return next()
	})


// Глобальный обработчик ошибок: игнорируем безвредные ошибки Telegram
bot.catch((err, ctx) => {
	if (isIgnoredTelegramError(err)) {
		return
	}
	console.error('Unhandled bot error:', err)
})

// Обработчики команд
bot.command('start', ctx => {
	if (ctx.chat.type !== 'private') {
		return // Просто игнорируем команду в групповых чатах
	}

	const welcomeMessage =
		'👋 <b>Добро пожаловать в рейтинг мастерских!</b>\n\n' +
		'🎯 <b>Что умеет этот бот:</b>\n\n' +
		'👍 <b>Оставить отзыв</b>\n' +
		'   • Оценить качество работы мастерской\n' +
		'   • Оценить коммуникацию с мастерской\n' +
		'   • Указать, выполнен ли заказ вовремя\n' +
		'   • Написать текстовый комментарий\n\n' +
		'📊 <b>Рейтинг/Отзывы</b>\n' +
		'   • Посмотреть рейтинг мастерских по качеству\n' +
		'   • Посмотреть рейтинг по коммуникации\n' +
		'   • Посмотреть статистику соблюдения сроков\n' +
		'   • Прочитать отзывы других клиентов\n\n' +
		'📋 <b>Список сервисов</b>\n' +
		'   • Просмотр всех доступных мастерских\n' +
		'   • Контактная информация и описание\n' +
		'   • Средние оценки и общая статистика\n\n' +
		'💡 <i>Ваши честные отзывы помогают другим клиентам делать правильный выбор!</i>\n\n' +
		'👇 Выберите действие:'

	ctx.reply(welcomeMessage, {
		parse_mode: 'HTML',
		reply_markup: getMainKeyboard().reply_markup,
	})
})

bot.command('help', ctx => {
	if (ctx.chat.type !== 'private') {
		return
	}

	const helpMessage =
		'ℹ️ <b>Справка по использованию бота</b>\n\n' +
		'<b>Основные команды:</b>\n' +
		'/start - Главное меню\n' +
		'/help - Эта справка\n' +
		'/app - Мини-приложение\n\n' +
		'<b>Как оставить отзыв:</b>\n' +
		'1️⃣ Нажмите "👍 Оставить отзыв"\n' +
		'2️⃣ Выберите мастерскую\n' +
		'3️⃣ Оцените качество работы (1-5)\n' +
		'4️⃣ Укажите, выполнен ли заказ вовремя\n' +
		'5️⃣ Оцените коммуникацию (1-5)\n' +
		'6️⃣ Напишите текстовый отзыв или пропустите\n' +
		'7️⃣ Подтвердите отправку\n\n' +
		'<b>Как посмотреть рейтинг:</b>\n' +
		'• Нажмите "📊 Рейтинг/Отзывы"\n' +
		'• Выберите тип рейтинга или просмотр отзывов\n' +
		'• Для отзывов выберите интересующую мастерскую\n\n' +
		'<b>Список мастерских:</b>\n' +
		'• Нажмите "📋 Список сервисов"\n' +
		'• Получите полную информацию о всех мастерских\n\n' +
		'❓ <i>Если у вас возникли вопросы, обратитесь к администратору.</i>'

	ctx.reply(helpMessage, { parse_mode: 'HTML' })
})

bot.command('app', ctx => {
	const webAppMarkup = getWebAppButtonMarkup()
	if (!webAppMarkup) {
		return ctx.reply('Мини-приложение пока не настроено.')
	}
	return ctx.reply('Открыть мини-приложение:', webAppMarkup)
})

bot.command('admin', async ctx => {
	if (!isAdmin(ctx.from.id)) {
		return ctx.reply('У вас нет прав доступа к панели администратора.')
	}

	ctx.reply(
		'🔐 Панель администратора\n\nВыберите действие:',
		getAdminKeyboard()
	)
})

bot.command('delete_feedback', async ctx => {
	if (!isAdmin(ctx.from.id)) {
		return ctx.reply('У вас нет прав для удаления отзывов.')
	}

	const feedbackId = ctx.message.text.split('/delete_feedback ')[1]
	if (!feedbackId) {
		return ctx.reply('Пожалуйста, укажите ID отзыва.')
	}

	try {
		// Подтверждение удаления
		await ctx.reply(
			`Вы уверены, что хотите удалить отзыв ${feedbackId}?`,
			Markup.inlineKeyboard([
				[
					Markup.button.callback('✅ Да', `confirm_delete_${feedbackId}`),
					Markup.button.callback('❌ Нет', 'cancel_delete'),
				],
			])
		)
	} catch (error) {
		console.error('Error with delete command:', error)
		await ctx.reply('Произошла ошибка при обработке команды.')
	}
})

bot.command('set_admin_chat', async ctx => {
	if (!isAdmin(ctx.from.id)) {
		return ctx.reply('У вас нет прав для выполнения этой команды.')
	}

	if (ctx.chat.type !== 'supergroup') {
		return ctx.reply(
			'Эта команда должна быть выполнена в супергруппе, которая будет использоваться как админский чат.'
		)
	}

	try {
		// Здесь вы можете сохранить ID чата в базу данных или конфиг
		await ctx.reply(`ID этого чата: ${ctx.chat.id}\n`)
	} catch (error) {
		console.error('Error setting admin chat:', error)
		await ctx.reply('Произошла ошибка при установке админского чата.')
	}
})
bot.action(/stats_(.+)/, async ctx => {
	try {
		await ctx.answerCbQuery()
		const workshopName = ctx.match[1]

		const workshop = await db
			.collection('workshops')
			.findOne({ name: workshopName })
		if (!workshop) {
			await ctx.reply('Мастерская не найдена.')
			return
		}

		const stats = await getWorkshopStats(workshopName)
		const lastReviews = await getLastReviews(workshopName, 3)

		let message = `📊 ${workshop.name}\n\n`
		message += `📍 Адрес: ${workshop.address}\n`
		message += `ℹ️ Описание: ${workshop.description}\n\n`
		message += `📝 Всего отзывов: ${stats.total_reviews}\n`
		message += `⭐️ Средняя оценка качества: ${
			stats.avg_quality ? stats.avg_quality.toFixed(2) : '0'
		}\n`
		message += `💬 Средняя оценка коммуникации: ${
			stats.avg_communication ? stats.avg_communication.toFixed(2) : '0'
		}\n`
		message += `✅ Выполнено вовремя: ${stats.on_time_count}\n`
		message += `❌ С задержкой: ${stats.delayed_count}\n\n`

		if (lastReviews && lastReviews.length > 0) {
			message += '📌 *Последние отзывы:*\n'
			lastReviews.forEach(review => {
				const name = escapeMarkdown(
					review.first_name + (review.last_name ? ` ${review.last_name}` : '')
				)

				message += `\n- От ${
					isAdmin(ctx.from.id) ? escapeMarkdown(name) : 'Аноним'
				}\n`
				const truncatedFeedback =
					review.text_feedback.length > MAX_FEEDBACK_LENGTH
						? review.text_feedback.substring(0, MAX_FEEDBACK_LENGTH)
						: review.text_feedback
				message += `  Отзыв: ${truncatedFeedback}\n`
				message += `  Дата: ${new Date(review.created_at).toLocaleDateString(
					'ru-RU'
				)}\n`
			})
		}

		await ctx.editMessageText(message, {
			parse_mode: 'Markdown',
			reply_markup: Markup.inlineKeyboard([
				[Markup.button.callback('« Назад к списку', 'back_to_workshops')],
			]).reply_markup,
		})
	} catch (error) {
		console.error('Error getting workshop stats:', error)
		await ctx.reply('Произошла ошибка при получении статистики.')
	}
})

bot.action('back_to_workshops', async ctx => {
	await ctx.answerCbQuery()
	const workshops = await getWorkshops()

	if (workshops.length === 0) {
		return ctx.editMessageText('В данный момент нет доступных мастерских.')
	}

	await ctx.editMessageText(
		'Выберите мастерскую для просмотра статистики:',
		Markup.inlineKeyboard(
			workshops.map(workshop => [
				Markup.button.callback(workshop.name, `stats_${workshop.name}`),
			])
		)
	)
})

// Обработчики действий админ-панели
bot.action('admin_all_feedbacks', async ctx => {
	await ctx.answerCbQuery()

	const keyboard = Markup.inlineKeyboard([
		[
			Markup.button.callback('10 отзывов', 'feedbacks_10'),
			Markup.button.callback('30 отзывов', 'feedbacks_30'),
			Markup.button.callback('50 отзывов', 'feedbacks_50'),
		],
		[Markup.button.callback('« Назад', 'admin_back')],
	])

	await ctx.editMessageText(
		'Выберите количество последних отзывов для просмотра:',
		keyboard
	)
})
;['10', '30', '50'].forEach(number => {
	bot.action(`feedbacks_${number}`, async ctx => {
		await ctx.answerCbQuery()

		try {
			const feedbacks = await getAllFeedbacks(parseInt(number))
			if (feedbacks.length === 0) {
				await ctx.reply('Отзывы не найдены.')
				return
			}

			const messages = []
			let currentMessage = `📊 Последние ${feedbacks.length} отзывов:\n\n`
			options = {
				year: 'numeric',
				month: 'numeric',
				day: 'numeric',
				hours: 'numeric',
				minutes: 'numeric',
			}
			for (const feedback of feedbacks) {
				const userName =
					feedback.first_name +
					(feedback.last_name ? ` ${feedback.last_name}` : '')
				let feedbackMessage = `👤 Пользователь: ${userName} (ID: ${feedback.user_id})\n`
				feedbackMessage += `🏢 Мастерская: ${feedback.workshop}\n`
				feedbackMessage += `⭐️ Качество: ${feedback.quality_rating}\n`
				feedbackMessage += `💬 Коммуникация: ${feedback.communication_rating}\n`
				feedbackMessage += `⏰ Вовремя: ${feedback.on_time}\n`
				feedbackMessage += `📝 Отзыв: ${feedback.text_feedback}\n`
				feedbackMessage += `📅 Дата: ${new Date(
					feedback.created_at
				).toLocaleString('ru-RU')}\n`
				feedbackMessage += `🗑 Удалить: /delete_feedback ${feedback._id}\n\n`

				if (currentMessage.length + feedbackMessage.length > 3800) {
					messages.push(currentMessage)
					currentMessage = feedbackMessage
				} else {
					currentMessage += feedbackMessage
				}
			}

			if (currentMessage) {
				messages.push(currentMessage)
			}

			for (const message of messages) {
				await ctx.reply(message)
			}
		} catch (error) {
			console.error('Error getting feedbacks:', error)
			await ctx.reply('Произошла ошибка при получении отзывов.')
		}
	})
})

bot.action('admin_search_user', async ctx => {
	await ctx.answerCbQuery()
	ctx.scene.enter('search_user_scene')
})

bot.action('admin_add_workshop', async ctx => {
	await ctx.answerCbQuery()
	ctx.scene.enter('add_workshop_scene')
})

bot.action('admin_remove_workshop', async ctx => {
	await ctx.answerCbQuery()

	const workshops = await getWorkshops()
	if (workshops.length === 0) {
		await ctx.editMessageText(
			'Нет доступных мастерских.',
			Markup.inlineKeyboard([[Markup.button.callback('« Назад', 'admin_back')]])
		)
		return
	}

	const keyboard = workshops.map(workshop => [
		Markup.button.callback(
			`❌ ${workshop.name}`,
			`remove_workshop_${workshop.name}`
		),
	])
	keyboard.push([Markup.button.callback('« Назад', 'admin_back')])

	await ctx.editMessageText(
		'Выберите мастерскую для удаления:',
		Markup.inlineKeyboard(keyboard)
	)
})

bot.action(/feedbacks_(\d+)/, async ctx => {
	await ctx.answerCbQuery()
	const limit = parseInt(ctx.match[1])

	try {
		const feedbacks = await getAllFeedbacks(limit)
		if (feedbacks.length === 0) {
			await ctx.reply('Отзывы не найдены.')
			return
		}

		const messages = []
		let currentMessage = `📊 Последние ${feedbacks.length} отзывов:\n\n`

		for (const feedback of feedbacks) {
			const feedbackMessage = formatFeedbackMessage(feedback, true) + '\n'

			if (currentMessage.length + feedbackMessage.length > 3800) {
				messages.push(currentMessage)
				currentMessage = feedbackMessage
			} else {
				currentMessage += feedbackMessage
			}
		}

		if (currentMessage) {
			messages.push(currentMessage)
		}

		// Отправляем все сообщения последовательно
		for (const message of messages) {
			await ctx.reply(message)
		}
	} catch (error) {
		console.error('Error getting feedbacks:', error)
		await ctx.reply('Произошла ошибка при получении отзывов.')
	}
})

bot.action(/user_feedbacks_(\d+)/, async ctx => {
	await ctx.answerCbQuery()
	const userId = parseInt(ctx.match[1])

	try {
		const feedbacks = await getUserFeedbacks(userId)
		if (feedbacks.length === 0) {
			await ctx.reply('Отзывы данного пользователя не найдены.')
			return
		}

		const messages = []
		let currentMessage = `📊 Отзывы пользователя:\n\n`

		for (const feedback of feedbacks) {
			const feedbackMessage = formatFeedbackMessage(feedback, true) + '\n'

			if (currentMessage.length + feedbackMessage.length > 3800) {
				messages.push(currentMessage)
				currentMessage = feedbackMessage
			} else {
				currentMessage += feedbackMessage
			}
		}

		if (currentMessage) {
			messages.push(currentMessage)
		}

		for (const message of messages) {
			await ctx.reply(message)
		}
	} catch (error) {
		console.error('Error getting user feedbacks:', error)
		await ctx.reply('Произошла ошибка при получении отзывов.')
	}
})

bot.action(/remove_workshop_(.+)/, async ctx => {
	await ctx.answerCbQuery()
	const workshopName = ctx.match[1]

	try {
		const result = await db
			.collection('workshops')
			.deleteOne({ name: workshopName })
		if (result.deletedCount > 0) {
			await ctx.editMessageText(
				`Мастерская "${workshopName}" успешно удалена.`,
				Markup.inlineKeyboard([
					[Markup.button.callback('« Назад', 'admin_back')],
				])
			)
		} else {
			await ctx.reply('Мастерская не найдена.')
		}
	} catch (error) {
		console.error('Error removing workshop:', error)
		await ctx.reply('Произошла ошибка при удалении мастерской.')
	}
})

bot.action(/confirm_delete_(.+)/, async ctx => {
	if (!isAdmin(ctx.from.id)) {
		await ctx.answerCbQuery('У вас нет прав для удаления отзывов.')
		return
	}

	const feedbackId = ctx.match[1]
	try {
		const result = await db.collection('feedback').deleteOne({
			_id: new ObjectId(feedbackId),
		})

		if (result.deletedCount > 0) {
			await ctx.answerCbQuery('Отзыв успешно удален!')
			await ctx.editMessageText('✅ Отзыв успешно удален.')
		} else {
			await ctx.answerCbQuery('Отзыв не найден.')
			await ctx.editMessageText('❌ Отзыв не найден.')
		}
	} catch (error) {
		console.error('Error deleting feedback:', error)
		await ctx.answerCbQuery('Произошла ошибка при удалении отзыва.')
		await ctx.editMessageText('❌ Произошла ошибка при удалении отзыва.')
	}
})

bot.action('cancel_delete', async ctx => {
	await ctx.answerCbQuery('Удаление отменено')
	await ctx.editMessageText('❌ Удаление отменено.')
})

bot.action('admin_list_workshops', async ctx => {
	await ctx.answerCbQuery()

	const workshops = await getWorkshops()
	if (workshops.length === 0) {
		await ctx.editMessageText(
			'Нет доступных мастерских.',
			Markup.inlineKeyboard([[Markup.button.callback('« Назад', 'admin_back')]])
		)
		return
	}

	let message = '📋 Список мастерских:\n\n'
	workshops.forEach((workshop, index) => {
		message += `${index + 1}. ${workshop.name}\n`
		message += `📍 ${workshop.address}\n`
		message += `ℹ️ ${workshop.description}\n\n`
	})

	await ctx.editMessageText(
		message,
		Markup.inlineKeyboard([[Markup.button.callback('« Назад', 'admin_back')]])
	)
})

bot.action('admin_back', async ctx => {
	await ctx.answerCbQuery()
	await ctx.editMessageText(
		'🔐 Панель администратора\n\nВыберите действие:',
		getAdminKeyboard()
	)
})

// Обработчики сезонного рейтинга
bot.action('admin_seasonal_rating', async ctx => {
	await ctx.answerCbQuery()

	const keyboard = Markup.inlineKeyboard([
		[Markup.button.callback('📋 Список сезонов', 'seasonal_list')],
		[Markup.button.callback('📊 Рейтинг по сезонам', 'seasonal_ratings')],
		[Markup.button.callback('➕ Добавить сезон', 'seasonal_add')],
		[Markup.button.callback('⏰ Завершить сезон', 'seasonal_end')],
		[Markup.button.callback('« Назад', 'admin_back')],
	])

	await ctx.editMessageText(
		'🏆 Управление сезонным рейтингом\n\nВыберите действие:',
		keyboard
	)
})

bot.action('admin_seasonal_back', async ctx => {
	await ctx.answerCbQuery()

	const keyboard = Markup.inlineKeyboard([
		[Markup.button.callback('📋 Список сезонов', 'seasonal_list')],
		[Markup.button.callback('📊 Рейтинг по сезонам', 'seasonal_ratings')],
		[Markup.button.callback('➕ Добавить сезон', 'seasonal_add')],
		[Markup.button.callback('⏰ Завершить сезон', 'seasonal_end')],
		[Markup.button.callback('« Назад', 'admin_back')],
	])

	await ctx.editMessageText(
		'🏆 Управление сезонным рейтингом\n\nВыберите действие:',
		keyboard
	)
})

bot.action('seasonal_list', async ctx => {
	await ctx.answerCbQuery()

	try {
		const seasons = await getSeasons()

		if (seasons.length === 0) {
			await ctx.editMessageText(
				'📅 Сезоны не найдены.',
				Markup.inlineKeyboard([
					[Markup.button.callback('« Назад', 'admin_seasonal_back')],
				])
			)
			return
		}

		let message = '📅 <b>Список сезонов:</b>\n\n'

		seasons.forEach((season, index) => {
			const startDate = new Date(season.start_date).toLocaleDateString('ru-RU')
			const endDate = season.end_date
				? new Date(season.end_date).toLocaleDateString('ru-RU')
				: 'Текущий'

			message += `<b>${index + 1}. ${escapeHTML(season.name)}</b>\n`
			message += `📝 ${escapeHTML(season.description)}\n`
			message += `📅 Период: ${startDate} - ${endDate}\n\n`
		})

		await ctx.editMessageText(message, {
			parse_mode: 'HTML',
			reply_markup: Markup.inlineKeyboard([
				[Markup.button.callback('« Назад', 'admin_seasonal_back')],
			]).reply_markup,
		})
	} catch (error) {
		console.error('Error getting seasons list:', error)
		await ctx.reply('Произошла ошибка при получении списка сезонов.')
	}
})

bot.action('seasonal_add', async ctx => {
	await ctx.answerCbQuery()
	ctx.scene.enter('add_season_scene')
})

bot.action('seasonal_end', async ctx => {
	await ctx.answerCbQuery()

	try {
		const seasons = await getSeasons()
		const openSeasons = seasons.filter(season => !season.end_date)

		if (openSeasons.length === 0) {
			await ctx.editMessageText(
				'Нет открытых сезонов для завершения.',
				Markup.inlineKeyboard([
					[Markup.button.callback('« Назад', 'admin_seasonal_back')],
				])
			)
			return
		}

		const keyboard = openSeasons.map(season => [
			Markup.button.callback(`📅 ${season.name}`, `end_season_${season._id}`),
		])
		keyboard.push([Markup.button.callback('« Назад', 'admin_seasonal_back')])

		await ctx.editMessageText(
			'Выберите сезон для завершения:',
			Markup.inlineKeyboard(keyboard)
		)
	} catch (error) {
		console.error('Error getting open seasons:', error)
		await ctx.reply('Произошла ошибка при получении списка сезонов.')
	}
})

bot.action(/end_season_(.+)/, async ctx => {
	await ctx.answerCbQuery()
	ctx.session.selectedSeasonId = ctx.match[1]
	ctx.scene.enter('end_season_scene')
})

bot.action('seasonal_ratings', async ctx => {
	await ctx.answerCbQuery()

	try {
		const seasons = await getSeasons()

		if (seasons.length === 0) {
			await ctx.editMessageText(
				'Сезоны не найдены.',
				Markup.inlineKeyboard([
					[Markup.button.callback('« Назад', 'admin_seasonal_back')],
				])
			)
			return
		}

		const keyboard = seasons.map(season => {
			const startDate = new Date(season.start_date).toLocaleDateString('ru-RU')
			const endDate = season.end_date
				? new Date(season.end_date).toLocaleDateString('ru-RU')
				: 'Текущий'

			return [
				Markup.button.callback(
					`📊 ${season.name} (${startDate} - ${endDate})`,
					`user_season_rating_${season._id}`
				),
			]
		})
		keyboard.push([Markup.button.callback('« Назад', 'view_ratings')])

		await ctx.editMessageText(
			'Выберите сезон для просмотра рейтинга:',
			Markup.inlineKeyboard(keyboard)
		)
	} catch (error) {
		console.error('Error getting seasons for rating:', error)
		await ctx.reply('Произошла ошибка при получении списка сезонов.')
	}
})

bot.action(/season_rating_(.+)/, async ctx => {
	await ctx.answerCbQuery()
	const seasonId = ctx.match[1]

	try {
		const season = await db
			.collection('seasons')
			.findOne({ _id: new ObjectId(seasonId) })
		if (!season) {
			await ctx.reply('Сезон не найден.')
			return
		}

		const keyboard = Markup.inlineKeyboard([
			[
				Markup.button.callback(
					'🏆 Общий рейтинг',
					`user_season_overall_${seasonId}`
				),
			],
			[
				Markup.button.callback(
					'⭐️ По качеству',
					`user_season_quality_${seasonId}`
				),
			],
			[
				Markup.button.callback(
					'💬 По коммуникации',
					`user_season_communication_${seasonId}`
				),
			],
			[
				Markup.button.callback(
					'⏰ По срокам',
					`user_season_timing_${seasonId}`
				),
			],
			[Markup.button.callback('« Назад', 'user_seasonal_ratings')],
		])

		const startDate = new Date(season.start_date).toLocaleDateString('ru-RU')
		const endDate = season.end_date
			? new Date(season.end_date).toLocaleDateString('ru-RU')
			: 'Текущий'

		await ctx.editMessageText(
			`📊 *Рейтинг за сезон "${season.name}"*\n` +
				`📅 Период: ${startDate} - ${endDate}\n\n` +
				'Выберите тип рейтинга:',
			{
				parse_mode: 'Markdown',
				reply_markup: keyboard.reply_markup,
			}
		)
	} catch (error) {
		console.error('Error getting season rating menu:', error)
		await ctx.reply('Произошла ошибка при получении меню рейтинга.')
	}
})

// Обработчик общего сезонного рейтинга
bot.action(/user_season_overall_(.+)/, async ctx => {
	await ctx.answerCbQuery()
	const seasonId = ctx.match[1]

	try {
		const season = await db
			.collection('seasons')
			.findOne({ _id: new ObjectId(seasonId) })
		const workshops = await getSeasonalWorkshopStats(seasonId)

		// Применяем ту же формулу общего рейтинга для сезонных данных
		const workshopsWithRating = workshops.map(workshop => {
			const qualityScore = parseFloat(workshop.avg_quality) || 0
			const communicationScore = parseFloat(workshop.avg_communication) || 0
			const onTimePercentage = parseFloat(workshop.on_time_percentage) / 100
			const reviewCount = workshop.total_reviews

			const baseRating = qualityScore * 0.8 + communicationScore * 0.2
			const overallRating =
				baseRating * onTimePercentage * Math.log(reviewCount + 1)

			return {
				...workshop,
				base_rating: baseRating,
				overall_rating: overallRating,
				quality_score: qualityScore,
				communication_score: communicationScore,
				on_time_percentage_decimal: onTimePercentage,
				log_factor: Math.log(reviewCount + 1),
			}
		})

		workshopsWithRating.sort((a, b) => b.overall_rating - a.overall_rating)

		const startDate = new Date(season.start_date).toLocaleDateString('ru-RU')
		const endDate = season.end_date
			? new Date(season.end_date).toLocaleDateString('ru-RU')
			: 'Текущий'

		let message = `🏆 *Общий рейтинг за сезон "${season.name}"*\n\n`
		message += `📅 Период: ${startDate} - ${endDate}\n`
		message +=
			'_Формула: (Качество×0.8 + Коммуникация×0.2) × %вовремя × log(отзывы+1)_\n\n'

		if (workshopsWithRating.length === 0) {
			message += 'За этот период отзывов не найдено.'
		} else {
			workshopsWithRating.forEach((workshop, index) => {
				const medal =
					index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🔸'

				message += `${medal} *${index + 1}. ${workshop.name}*\n`
				message += `🏆 Общий рейтинг: *${workshop.overall_rating.toFixed(2)}*\n`
				message += `📊 Базовый балл: *${workshop.base_rating.toFixed(2)}/5*\n`
				message += `⭐️ Качество: *${workshop.quality_score.toFixed(
					1
				)}/5* (80%)\n`
				message += `💬 Коммуникация: *${workshop.communication_score.toFixed(
					1
				)}/5* (20%)\n`
				message += `⏰ Вовремя: *${workshop.on_time_percentage}%*\n`
				message += `📝 Отзывов: *${
					workshop.total_reviews
				}* (×${workshop.log_factor.toFixed(2)})\n\n`
			})
		}

		await ctx.editMessageText(message, {
			parse_mode: 'Markdown',
			reply_markup: Markup.inlineKeyboard([
				[Markup.button.callback('« Назад', `user_season_rating_${seasonId}`)],
			]).reply_markup,
		})
	} catch (error) {
		console.error('Error getting seasonal overall rating:', error)
		await ctx.reply('Произошла ошибка при получении рейтинга.')
	}
})

// Остальные обработчики сезонных рейтингов
bot.action(/user_season_quality_(.+)/, async ctx => {
	await ctx.answerCbQuery()
	const seasonId = ctx.match[1]

	try {
		const season = await db
			.collection('seasons')
			.findOne({ _id: new ObjectId(seasonId) })
		const workshops = await getSeasonalWorkshopStats(seasonId)
		workshops.sort(
			(a, b) => parseFloat(b.avg_quality) - parseFloat(a.avg_quality)
		)

		const startDate = new Date(season.start_date).toLocaleDateString('ru-RU')
		const endDate = season.end_date
			? new Date(season.end_date).toLocaleDateString('ru-RU')
			: 'Текущий'

		let message = `📊 *Рейтинг по качеству за сезон "${season.name}"*\n`
		message += `📅 Период: ${startDate} - ${endDate}\n\n`

		if (workshops.length === 0) {
			message += 'За этот период отзывов не найдено.'
		} else {
			workshops.forEach((workshop, index) => {
				message += `*${index + 1}. ${workshop.name}*\n`
				message += `⭐️ Качество: *${workshop.avg_quality}/5*\n`
				message += `📝 Отзывов: *${workshop.total_reviews}*\n\n`
			})
		}

		await ctx.editMessageText(message, {
			parse_mode: 'Markdown',
			reply_markup: Markup.inlineKeyboard([
				[Markup.button.callback('« Назад', `user_season_rating_${seasonId}`)],
			]).reply_markup,
		})
	} catch (error) {
		console.error('Error getting seasonal quality rating:', error)
		await ctx.reply('Произошла ошибка при получении рейтинга.')
	}
})

bot.action(/user_season_communication_(.+)/, async ctx => {
	await ctx.answerCbQuery()
	const seasonId = ctx.match[1]

	try {
		const season = await db
			.collection('seasons')
			.findOne({ _id: new ObjectId(seasonId) })
		const workshops = await getSeasonalWorkshopStats(seasonId)
		workshops.sort(
			(a, b) =>
				parseFloat(b.avg_communication) - parseFloat(a.avg_communication)
		)

		const startDate = new Date(season.start_date).toLocaleDateString('ru-RU')
		const endDate = season.end_date
			? new Date(season.end_date).toLocaleDateString('ru-RU')
			: 'Текущий'

		let message = `📊 *Рейтинг по коммуникации за сезон "${season.name}"*\n`
		message += `📅 Период: ${startDate} - ${endDate}\n\n`

		if (workshops.length === 0) {
			message += 'За этот период отзывов не найдено.'
		} else {
			workshops.forEach((workshop, index) => {
				message += `*${index + 1}. ${workshop.name}*\n`
				message += `💬 Коммуникация: *${workshop.avg_communication}/5*\n`
				message += `📝 Отзывов: *${workshop.total_reviews}*\n\n`
			})
		}

		await ctx.editMessageText(message, {
			parse_mode: 'Markdown',
			reply_markup: Markup.inlineKeyboard([
				[Markup.button.callback('« Назад', `user_season_rating_${seasonId}`)],
			]).reply_markup,
		})
	} catch (error) {
		console.error('Error getting seasonal communication rating:', error)
		await ctx.reply('Произошла ошибка при получении рейтинга.')
	}
})

bot.action(/user_season_timing_(.+)/, async ctx => {
	await ctx.answerCbQuery()
	const seasonId = ctx.match[1]

	try {
		const season = await db
			.collection('seasons')
			.findOne({ _id: new ObjectId(seasonId) })
		const workshops = await getSeasonalWorkshopStats(seasonId)

		workshops.sort(
			(a, b) =>
				parseFloat(b.on_time_percentage) - parseFloat(a.on_time_percentage)
		)

		const startDate = new Date(season.start_date).toLocaleDateString('ru-RU')
		const endDate = season.end_date
			? new Date(season.end_date).toLocaleDateString('ru-RU')
			: 'Текущий'

		let message = `📊 *Рейтинг по соблюдению сроков за сезон "${season.name}"*\n`
		message += `📅 Период: ${startDate} - ${endDate}\n\n`

		if (workshops.length === 0) {
			message += 'За этот период отзывов не найдено.'
		} else {
			workshops.forEach((workshop, index) => {
				message += `*${index + 1}. ${workshop.name}*\n`
				message += `✅ Вовремя: *${workshop.on_time_percentage}%*\n`
				message += `📝 Отзывов: *${workshop.total_reviews}*\n\n`
			})
		}

		await ctx.editMessageText(message, {
			parse_mode: 'Markdown',
			reply_markup: Markup.inlineKeyboard([
				[Markup.button.callback('« Назад', `user_season_rating_${seasonId}`)],
			]).reply_markup,
		})
	} catch (error) {
		console.error('Error getting seasonal timing rating:', error)
		await ctx.reply('Произошла ошибка при получении рейтинга.')
	}
})

// Обработчики основного меню
bot.hears('👍 Оставить отзыв', async ctx => {
	try {
		// const canVote = await canUserVote(ctx.from.id)

		// if (!canVote) {
		// 	await ctx.reply(
		// 		'⚠️ Вы уже голосовали сегодня. Следующее голосование будет доступно завтра.',
		// 		getMainKeyboard()
		// 	)
		// 	return
		// }

		ctx.scene.enter('workshop')
	} catch (error) {
		console.error('Error in vote handler:', error)
		await ctx.reply(
			'Произошла ошибка при проверке возможности голосования.',
			getMainKeyboard()
		)
	}
})

bot.hears('📋 Список сервисов', async ctx => {
	const workshops = await getWorkshopsList()
	const message = formatWorkshopsListMessage(workshops)
	await ctx.replyWithMarkdown(message) // Используем Markdown для форматирования
})

bot.hears('🧩 Мини-приложение', ctx => {
	const webAppMarkup = getWebAppButtonMarkup()
	if (!webAppMarkup) {
		return ctx.reply('Мини-приложение пока не настроено.')
	}
	return ctx.reply('Открыть мини-приложение:', webAppMarkup)
})

bot.hears('ℹ️ Помощь', ctx => {
	const helpMessage =
		'ℹ️ <b>Справка по использованию бота</b>\n\n' +
		'<b>Основные команды:</b>\n' +
		'/start - Главное меню\n' +
		'/help - Эта справка\n\n' +
		'<b>Как оставить отзыв:</b>\n' +
		'1️⃣ Нажмите "👍 Оставить отзыв"\n' +
		'2️⃣ Выберите мастерскую\n' +
		'3️⃣ Оцените качество работы (1-5)\n' +
		'4️⃣ Укажите, выполнен ли заказ вовремя\n' +
		'5️⃣ Оцените коммуникацию (1-5)\n' +
		'6️⃣ Напишите текстовый отзыв или пропустите\n' +
		'7️⃣ Подтвердите отправку\n\n' +
		'<b>Как посмотреть рейтинг:</b>\n' +
		'• Нажмите "📊 Рейтинг/Отзывы"\n' +
		'• Выберите тип рейтинга или просмотр отзывов\n' +
		'• Для отзывов выберите интересующую мастерскую\n\n' +
		'<b>Список мастерских:</b>\n' +
		'• Нажмите "📋 Список сервисов"\n' +
		'• Получите полную информацию о всех мастерских\n\n' +
		'❓ <i>Если у вас возникли вопросы, обратитесь к администратору.</i>'

	ctx.reply(helpMessage, { parse_mode: 'HTML' })
})

bot.hears('📊 Рейтинг/Отзывы', async ctx => {
	await ctx.reply(
		'Выберите действие:',
		Markup.inlineKeyboard([
			[Markup.button.callback('📊 Посмотреть рейтинг', 'view_ratings')],
			[Markup.button.callback('💬 Смотреть отзывы', 'view_reviews')],
		])
	)
})

bot.action('view_ratings', async ctx => {
	await ctx.answerCbQuery()
	await ctx.editMessageText(
		'Выберите тип рейтинга:',
		Markup.inlineKeyboard([
			[Markup.button.callback('🏆 Общий рейтинг', 'rating_overall')],
			[Markup.button.callback('⭐️ По качеству работ', 'rating_quality')],
			[Markup.button.callback('💬 По коммуникации', 'rating_communication')],
			[Markup.button.callback('⏰ Соблюдение сроков', 'rating_delays')],
			[Markup.button.callback('📅 Сезонный рейтинг', 'user_seasonal_ratings')],
			[Markup.button.callback('« Назад', 'back_to_rating_menu')],
		])
	)
})

bot.action('view_reviews', async ctx => {
	await ctx.answerCbQuery()
	const workshops = await getWorkshops()
	if (workshops.length === 0) {
		return ctx.editMessageText(
			'В данный момент нет доступных мастерских.',
			Markup.inlineKeyboard([
				[Markup.button.callback('« Назад', 'back_to_rating_menu')],
			])
		)
	}

	const keyboard = workshops.map(workshop => [
		Markup.button.callback(workshop.name, `show_reviews_${workshop.name}_0`), // Добавляем _0 для первой страницы
	])
	keyboard.push([Markup.button.callback('« Назад', 'back_to_rating_menu')])

	await ctx.editMessageText(
		'Выберите мастерскую для просмотра отзывов:',
		Markup.inlineKeyboard(keyboard)
	)
})

// Обработчики для разных типов рейтингов
bot.action('rating_quality', async ctx => {
	await ctx.answerCbQuery()
	const workshops = await getWorkshopsList()
	workshops.sort((a, b) => b.avg_quality - a.avg_quality)

	let message = '📊 <b>Рейтинг по качеству работ:</b>\n\n'
	workshops.forEach((workshop, index) => {
		message += `<b>${index + 1}. ${escapeHTML(workshop.name)}</b>\n`
		message += `⭐️ Качество: <b>${workshop.avg_quality}/5</b>\n`
		message += `📝 Всего отзывов: <b>${workshop.total_reviews}</b>\n\n`
	})

	await ctx.editMessageText(message, {
		parse_mode: 'HTML',
		reply_markup: Markup.inlineKeyboard([
			[Markup.button.callback('« Назад', 'view_ratings')],
		]).reply_markup,
	})
})

bot.action('rating_communication', async ctx => {
	await ctx.answerCbQuery()
	const workshops = await getWorkshopsList()
	workshops.sort((a, b) => b.avg_communication - a.avg_communication)

	let message = '📊 <b>Рейтинг по коммуникации:</b>\n\n'
	workshops.forEach((workshop, index) => {
		message += `<b>${index + 1}. ${escapeHTML(workshop.name)}</b>\n`
		message += `💬 Коммуникация: <b>${workshop.avg_communication}/5</b>\n`
		message += `📝 Всего отзывов: <b>${workshop.total_reviews}</b>\n\n`
	})

	await ctx.editMessageText(message, {
		parse_mode: 'HTML',
		reply_markup: Markup.inlineKeyboard([
			[Markup.button.callback('« Назад', 'view_ratings')],
		]).reply_markup,
	})
})

bot.action('rating_delays', async ctx => {
	await ctx.answerCbQuery()
	const workshops = await getWorkshopsList()

	// Сортируем по проценту выполненных вовремя (от большего к меньшему)
	workshops.sort((a, b) => {
		const onTimePercentA =
			a.total_reviews > 0 ? (a.on_time_count / a.total_reviews) * 100 : 0
		const onTimePercentB =
			b.total_reviews > 0 ? (b.on_time_count / b.total_reviews) * 100 : 0
		return onTimePercentB - onTimePercentA
	})

	let message = '📊 <b>Рейтинг по соблюдению сроков:</b>\n\n'
	workshops.forEach((workshop, index) => {
		const onTimePercentage =
			workshop.total_reviews > 0
				? ((workshop.on_time_count / workshop.total_reviews) * 100).toFixed(1)
				: '0.0'

		message += `<b>${index + 1}. ${escapeHTML(workshop.name)}</b>\n`
		message += `✅ Выполнено вовремя: <b>${onTimePercentage}%</b>\n`
		message += `📝 Всего отзывов: <b>${workshop.total_reviews}</b>\n\n`
	})

	await ctx.editMessageText(message, {
		parse_mode: 'HTML',
		reply_markup: Markup.inlineKeyboard([
			[Markup.button.callback('« Назад', 'view_ratings')],
		]).reply_markup,
	})
})

bot.action(/show_reviews_(.+)_(\d+)/, async ctx => {
	const workshopName = ctx.match[1]
	const page = parseInt(ctx.match[2])
	const reviewsPerPage = 5

	try {
		const totalReviews = await db.collection('feedback').countDocuments({
			workshop: workshopName,
			text_feedback: { $exists: true, $nin: ['', null] },
		})

		const totalPages = Math.ceil(totalReviews / reviewsPerPage)

		const reviews = await db
			.collection('feedback')
			.find({
				workshop: workshopName,
				text_feedback: { $exists: true, $nin: ['', null] },
			})
			.sort({ created_at: -1 })
			.skip(page * reviewsPerPage)
			.limit(reviewsPerPage)
			.toArray()

		if (reviews.length === 0 && page === 0) {
			await ctx.editMessageText(
				'Для данной мастерской пока нет отзывов.',
				Markup.inlineKeyboard([
					[Markup.button.callback('« Назад', 'view_reviews')],
				])
			)
			return
		}

		let message = `💬 <b>Отзывы о мастерской "${escapeHTML(
			workshopName
		)}"</b>\n`
		message += `<i>Страница ${page + 1} из ${totalPages}</i>\n\n`

		reviews.forEach(review => {
			message += `Отзыв от ${new Date(review.created_at).toLocaleDateString(
				'ru-RU'
			)}\n`
			message += `⭐️ Качество: <b>${review.quality_rating}/5</b>\n`
			message += `💬 Коммуникация: <b>${review.communication_rating}/5</b>\n`
			message += `⏰ Вовремя: <b>${review.on_time}</b>\n`
			message += `📝 Комментарий: ${escapeHTML(review.text_feedback)}\n\n`
		})

		// Создаем кнопки пагинации
		const keyboard = []
		const navigationRow = []

		if (page > 0) {
			navigationRow.push(
				Markup.button.callback(
					'« Предыдущая',
					`show_reviews_${workshopName}_${page - 1}`
				)
			)
		}
		if (page < totalPages - 1) {
			navigationRow.push(
				Markup.button.callback(
					'Следующая »',
					`show_reviews_${workshopName}_${page + 1}`
				)
			)
		}
		if (navigationRow.length > 0) {
			keyboard.push(navigationRow)
		}
		keyboard.push([Markup.button.callback('« Назад к списку', 'view_reviews')])

		await ctx.editMessageText(message, {
			parse_mode: 'HTML',
			reply_markup: Markup.inlineKeyboard(keyboard).reply_markup,
		})
	} catch (error) {
		if (isIgnoredTelegramError(error)) {
			return
		}
		console.error('Error getting workshop reviews:', error)
		await ctx.reply('Произошла ошибка при получении отзывов.')
	}
})

bot.action('back_to_rating_menu', async ctx => {
	await ctx.answerCbQuery()
	await ctx.editMessageText(
		'Выберите действие:',
		Markup.inlineKeyboard([
			[Markup.button.callback('📊 Посмотреть рейтинг', 'view_ratings')],
			[Markup.button.callback('💬 Смотреть отзывы', 'view_reviews')],
		])
	)
})

// Добавим функцию проверки последнего голосования пользователя
async function canUserVote(userId) {
	// Если пользователь админ - разрешаем голосовать всегда
	if (isAdmin(userId)) {
		return true
	}

	try {
		const lastFeedback = await db
			.collection('feedback')
			.findOne({ user_id: userId }, { sort: { created_at: -1 } })

		if (!lastFeedback) {
			return true // Пользователь еще не голосовал
		}

		const lastVoteDate = new Date(lastFeedback.created_at)
		const currentDate = new Date()

		// Сбрасываем время до начала дня для корректного сравнения
		lastVoteDate.setHours(0, 0, 0, 0)
		currentDate.setHours(0, 0, 0, 0)

		// Проверяем, прошел ли один день
		return lastVoteDate.getTime() < currentDate.getTime()
	} catch (error) {
		console.error('Error checking user vote:', error)
		return false
	}
}

// Функции для работы с сезонами
async function getSeasons() {
	try {
		const seasons = await db
			.collection('seasons')
			.find({})
			.sort({ start_date: -1 })
			.toArray()
		return seasons
	} catch (error) {
		console.error('Error getting seasons:', error)
		return []
	}
}

async function getCurrentSeason() {
	try {
		const now = new Date()
		const season = await db.collection('seasons').findOne({
			start_date: { $lte: now },
			$or: [
				{ end_date: { $gte: now } },
				{ end_date: null }, // Текущий сезон без окончательной даты
			],
		})
		return season
	} catch (error) {
		console.error('Error getting current season:', error)
		return null
	}
}

async function addSeason(seasonData) {
	try {
		const newStart = seasonData.start_date
		const newEnd = seasonData.end_date || new Date('9999-12-31')

		// Проверяем, нет ли пересекающихся сезонов
		const existingSeason = await db.collection('seasons').findOne({
			start_date: { $lte: newEnd },
			$or: [{ end_date: null }, { end_date: { $gte: newStart } }],
		})

		if (existingSeason) {
			return {
				success: false,
				message: 'Период пересекается с существующим сезоном',
			}
		}

		await db.collection('seasons').insertOne({
			name: seasonData.name,
			description: seasonData.description,
			start_date: seasonData.start_date,
			end_date: seasonData.end_date,
			created_at: new Date(),
		})
		return { success: true }
	} catch (error) {
		console.error('Error adding season:', error)
		return { success: false, message: 'Ошибка при добавлении сезона' }
	}
}

async function updateSeasonEndDate(seasonId, endDate) {
	try {
		const result = await db
			.collection('seasons')
			.updateOne(
				{ _id: new ObjectId(seasonId) },
				{ $set: { end_date: endDate } }
			)
		return result.modifiedCount > 0
	} catch (error) {
		console.error('Error updating season:', error)
		return false
	}
}

async function getSeasonalWorkshopStats(seasonId) {
	try {
		const season = await db
			.collection('seasons')
			.findOne({ _id: new ObjectId(seasonId) })

		if (!season) return []

		const dateFilter = {
			created_at: { $gte: season.start_date },
		}

		if (season.end_date) {
			dateFilter.created_at.$lte = season.end_date
		}

		const workshops = await db.collection('workshops').find({}).toArray()

		const workshopsData = []

		for (const workshop of workshops) {
			const feedbacks = await db
				.collection('feedback')
				.find({
					workshop: workshop.name,
					...dateFilter,
				})
				.toArray()

			const total_reviews = feedbacks.length
			const on_time_count = feedbacks.filter(f => f.on_time === 'Да').length

			const onTimePercentage =
				total_reviews > 0
					? ((on_time_count / total_reviews) * 100).toFixed(1)
					: '0.0'

			workshopsData.push({
				name: workshop.name,
				address: workshop.address,
				description: workshop.description,
				avg_quality: calculateAverage(feedbacks, 'quality_rating'),
				avg_communication: calculateAverage(feedbacks, 'communication_rating'),
				total_reviews: total_reviews,
				on_time_count: on_time_count,
				on_time_percentage: onTimePercentage,
			})
		}

		return workshopsData
	} catch (error) {
		console.error('Error getting seasonal stats:', error)
		return []
	}
}

function mapWorkshopStats(workshop) {
	return {
		name: workshop.name,
		address: workshop.address,
		description: workshop.description,
		avg_quality: Number(workshop.avg_quality),
		avg_communication: Number(workshop.avg_communication),
		total_reviews: workshop.total_reviews,
		on_time_count: workshop.on_time_count,
		on_time_percentage: Number(workshop.on_time_percentage),
	}
}

function mapSeason(season) {
	return {
		id: season._id.toString(),
		name: season.name,
		description: season.description,
		start_date: season.start_date ? season.start_date.toISOString() : null,
		end_date: season.end_date ? season.end_date.toISOString() : null,
	}
}

function mapReview(review) {
	return {
		id: review._id.toString(),
		workshop: review.workshop,
		quality_rating: review.quality_rating,
		communication_rating: review.communication_rating,
		on_time: review.on_time,
		text_feedback: review.text_feedback,
		created_at: review.created_at ? review.created_at.toISOString() : null,
	}
}

function isAllowedOrigin(origin) {
	if (!origin) return false
	if (config.WEBAPP_ORIGINS.length === 0) return true
	return config.WEBAPP_ORIGINS.includes(origin)
}

function startApiServer() {
	const app = express()
	app.disable('x-powered-by')
	app.use(express.json({ limit: '1mb' }))

	app.use((req, res, next) => {
		const origin = req.headers.origin
		console.log('[API] Incoming request:', req.method, req.url)
		console.log('[API] Origin:', origin)
		console.log('[API] X-Telegram-Init-Data present:', !!req.headers['x-telegram-init-data'])

		if (isAllowedOrigin(origin)) {
			res.setHeader('Access-Control-Allow-Origin', origin)
			res.setHeader('Vary', 'Origin')
		} else if (config.WEBAPP_ORIGINS.length === 0) {
			// Если whitelist пустой, разрешаем любой origin
			res.setHeader('Access-Control-Allow-Origin', origin || '*')
		}
		res.setHeader(
			'Access-Control-Allow-Headers',
			'Content-Type, X-Telegram-Init-Data'
		)
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
		if (req.method === 'OPTIONS') {
			return res.status(204).end()
		}
		return next()
	})

	app.get('/api/health', (req, res) => {
		res.json({ ok: true })
	})

	app.get('/api/workshops', async (req, res) => {
		try {
			const initData = getInitDataFromRequest(req)
			console.log('[API] /api/workshops initData:', initData ? 'present' : 'missing')
			if (initData) {
				const validation = validateWebAppInitData(initData, config.BOT_TOKEN, config.WEBAPP_AUTH_MAX_AGE_SECONDS)
				console.log('[API] /api/workshops validation:', validation.isValid ? 'OK' : validation.reason)
			}
			const workshops = await getWorkshopsList()
			res.json({
				ok: true,
				workshops: workshops.map(mapWorkshopStats),
			})
		} catch (error) {
			console.error('Error getting workshops for API:', error)
			res.status(500).json({ ok: false, error: 'server_error' })
		}
	})

	app.get('/api/seasons', async (req, res) => {
		try {
			const seasons = await getSeasons()
			res.json({ ok: true, seasons: seasons.map(mapSeason) })
		} catch (error) {
			console.error('Error getting seasons for API:', error)
			res.status(500).json({ ok: false, error: 'server_error' })
		}
	})

	app.get('/api/ratings', async (req, res) => {
		const type = String(req.query.type || 'overall')
		try {
			if (type === 'overall') {
				const workshops = await getOverallRating()
				return res.json({
					ok: true,
					type,
					workshops: workshops.map(workshop => ({
						...mapWorkshopStats(workshop),
						overall_rating: Number(workshop.overall_rating),
						base_rating: Number(workshop.base_rating),
						quality_score: Number(workshop.quality_score),
						communication_score: Number(workshop.communication_score),
						log_factor: Number(workshop.log_factor),
					})),
				})
			}

			const workshops = await getWorkshopsList()
			const normalized = workshops.map(mapWorkshopStats)
			if (type === 'quality') {
				normalized.sort((a, b) => b.avg_quality - a.avg_quality)
				return res.json({ ok: true, type, workshops: normalized })
			}
			if (type === 'communication') {
				normalized.sort((a, b) => b.avg_communication - a.avg_communication)
				return res.json({ ok: true, type, workshops: normalized })
			}
			if (type === 'delays') {
				normalized.sort((a, b) => b.on_time_percentage - a.on_time_percentage)
				return res.json({ ok: true, type, workshops: normalized })
			}

			return res.status(400).json({ ok: false, error: 'invalid_type' })
		} catch (error) {
			console.error('Error getting ratings for API:', error)
			return res.status(500).json({ ok: false, error: 'server_error' })
		}
	})

	app.get('/api/ratings/seasonal', async (req, res) => {
		const type = String(req.query.type || 'overall')
		const seasonId = String(req.query.seasonId || '')

		if (!seasonId) {
			return res.status(400).json({ ok: false, error: 'missing_season_id' })
		}

		try {
			const workshops = await getSeasonalWorkshopStats(seasonId)
			const normalized = workshops.map(mapWorkshopStats)

			if (type === 'overall') {
				const overall = buildOverallRatingEntries(normalized)
				overall.sort((a, b) => b.overall_rating - a.overall_rating)
				return res.json({ ok: true, type, workshops: overall })
			}
			if (type === 'quality') {
				normalized.sort((a, b) => b.avg_quality - a.avg_quality)
				return res.json({ ok: true, type, workshops: normalized })
			}
			if (type === 'communication') {
				normalized.sort((a, b) => b.avg_communication - a.avg_communication)
				return res.json({ ok: true, type, workshops: normalized })
			}
			if (type === 'timing') {
				normalized.sort((a, b) => b.on_time_percentage - a.on_time_percentage)
				return res.json({ ok: true, type, workshops: normalized })
			}

			return res.status(400).json({ ok: false, error: 'invalid_type' })
		} catch (error) {
			console.error('Error getting seasonal ratings for API:', error)
			return res.status(500).json({ ok: false, error: 'server_error' })
		}
	})

	app.get('/api/reviews', async (req, res) => {
		const workshop = String(req.query.workshop || '')
		const page = Math.max(Number.parseInt(req.query.page, 10) || 0, 0)
		const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 5, 1), 10)

		if (!workshop) {
			return res.status(400).json({ ok: false, error: 'missing_workshop' })
		}

		try {
			const query = {
				workshop,
				text_feedback: { $exists: true, $nin: ['', null] },
			}
			const totalReviews = await db.collection('feedback').countDocuments(query)
			const totalPages = Math.ceil(totalReviews / limit)
			const reviews = await db
				.collection('feedback')
				.find(query)
				.sort({ created_at: -1 })
				.skip(page * limit)
				.limit(limit)
				.toArray()

			return res.json({
				ok: true,
				page,
				total_pages: totalPages,
				total_reviews: totalReviews,
				reviews: reviews.map(mapReview),
			})
		} catch (error) {
			console.error('Error getting reviews for API:', error)
			return res.status(500).json({ ok: false, error: 'server_error' })
		}
	})

	app.post('/api/reviews', requireWebAppAuth, async (req, res) => {
		const workshop = String(req.body.workshop || '')
		const qualityRating = Number(req.body.qualityRating ?? req.body.quality_rating)
		const communicationRating = Number(
			req.body.communicationRating ?? req.body.communication_rating
		)
		const onTimeValue = normalizeOnTimeValue(req.body.onTime ?? req.body.on_time)
		const textFeedback = String(req.body.textFeedback ?? req.body.text_feedback ?? '')
			.trim()
			.slice(0, MAX_FEEDBACK_LENGTH)

		if (!workshop || !isValidRating(qualityRating) || !isValidRating(communicationRating)) {
			return res.status(400).json({ ok: false, error: 'invalid_payload' })
		}
		if (!onTimeValue) {
			return res.status(400).json({ ok: false, error: 'invalid_on_time' })
		}

		const telegramUser = req.telegramUser
		if (!telegramUser || !telegramUser.id) {
			return res.status(401).json({ ok: false, error: 'invalid_user' })
		}

		try {
			const workshopExists = await db
				.collection('workshops')
				.findOne({ name: workshop })
			if (!workshopExists) {
				return res.status(404).json({ ok: false, error: 'workshop_not_found' })
			}

			if (config.ENABLE_DAILY_VOTE_LIMIT) {
				const canVote = await canUserVote(telegramUser.id)
				if (!canVote) {
					return res
						.status(429)
						.json({ ok: false, error: 'daily_limit_reached' })
				}
			}

			const feedback = {
				user_id: telegramUser.id,
				first_name: telegramUser.first_name,
				last_name: telegramUser.last_name,
				username: telegramUser.username,
				workshop: workshop,
				quality_rating: qualityRating,
				on_time: onTimeValue,
				communication_rating: communicationRating,
				text_feedback: textFeedback,
				created_at: new Date(),
			}

			const result = await db.collection('feedback').insertOne(feedback)
			feedback._id = result.insertedId

			await notifyAdminsAboutNewFeedbackFromApi(feedback)
			return res.json({ ok: true, id: result.insertedId.toString() })
		} catch (error) {
			console.error('Error creating feedback from API:', error)
			return res.status(500).json({ ok: false, error: 'server_error' })
		}
	})

	app.listen(config.API_PORT, () => {
		console.log(`API server listening on ${config.API_PORT}`)
	})
}

// Подключение к MongoDB и запуск бота
async function initializeSeasons() {
	try {
		const seasonsCount = await db.collection('seasons').countDocuments()

		if (seasonsCount === 0) {
			// Создаем начальные сезоны согласно требованиям
			const winterSeason = {
				name: 'Межсезонье/Зимний сезон 2024/2025',
				description: 'Зимний период с начала времени до 25.04.2025',
				start_date: new Date('2024-01-01'), // Начальная дата
				end_date: new Date('2025-04-25'),
				created_at: new Date(),
			}

			const summerSeason = {
				name: 'Летний сезон 2025',
				description: 'Летний период с 26.04.2025 до 15.10.2025',
				start_date: new Date('2025-04-26'),
				end_date: new Date('2025-10-15'),
				created_at: new Date(),
			}

			const fallSeason = {
				name: 'Осенний сезон 2025',
				description:
					'Осенний период с 16.10.2025 (дата окончания будет определена позднее)',
				start_date: new Date('2025-10-16'),
				end_date: null, // Текущий открытый сезон
				created_at: new Date(),
			}

			await db
				.collection('seasons')
				.insertMany([winterSeason, summerSeason, fallSeason])
			console.log('Initial seasons created')
		}
	} catch (error) {
		console.error('Error initializing seasons:', error)
	}
}

async function setupDatabase() {
	try {
		await db.collection('workshops').createIndex({ name: 1 }, { unique: true })
		await db.collection('seasons').createIndex({ start_date: 1 })
		await db.collection('seasons').createIndex({ end_date: 1 })
		await db.collection('feedback').createIndex({ created_at: 1 })
		await initializeSeasons()
		console.log('Database indexes created')
	} catch (error) {
		console.error('Error creating indexes:', error)
	}
}

async function connectToMongo() {
	await mongoClient.connect()
	db = mongoClient.db(config.DB_NAME)
	await setupDatabase()
	console.log('Connected to MongoDB')
}

connectToMongo()
	.then(() => {
		startApiServer()
		return bot.launch().then(async () => {
			console.log('Bot started')
			await setupWebAppMenuButton()
		})
	})
	.catch(error => {
		console.error('MongoDB connection error:', error)
		process.exit(1)
	})

// Корректное завершение работы
process.once('SIGINT', () => {
	mongoClient.close()
	bot.stop('SIGINT')
})
process.once('SIGTERM', () => {
	mongoClient.close()
	bot.stop('SIGTERM')
})

bot.action('rating_overall', async ctx => {
	await ctx.answerCbQuery()
	try {
		const workshops = await getOverallRating()

		let message = '🏆 *Общий рейтинг мастерских:*\n\n'
		message +=
			'_Формула: (Качество×0.8 + Коммуникация×0.2) × %вовремя × log(отзывы+1)_\n\n'

		workshops.forEach((workshop, index) => {
			// Медали для топ-3
			const medal =
				index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🔸'

			message += `${medal} *${index + 1}. ${workshop.name}*\n`
			message += `🏆 Общий рейтинг: *${workshop.overall_rating.toFixed(2)}*\n`
			message += `📊 Базовый балл: *${workshop.base_rating.toFixed(2)}/5*\n`
			message += `⭐️ Качество: *${workshop.quality_score.toFixed(
				1
			)}/5* (80%)\n`
			message += `💬 Коммуникация: *${workshop.communication_score.toFixed(
				1
			)}/5* (20%)\n`
			message += `⏰ Вовремя: *${workshop.on_time_percentage}%*\n`
			message += `📝 Отзывов: *${
				workshop.total_reviews
			}* (×${workshop.log_factor.toFixed(2)})\n\n`
		})

		message +=
			'_Логарифмический множитель учитывает количество отзывов, давая преимущество мастерским с большим опытом._'

		await ctx.editMessageText(message, {
			parse_mode: 'Markdown',
			reply_markup: Markup.inlineKeyboard([
				[Markup.button.callback('« Назад', 'view_ratings')],
			]).reply_markup,
		})
	} catch (error) {
		console.error('Error getting overall rating:', error)
		await ctx.reply('Произошла ошибка при получении общего рейтинга.')
	}
})

// Обработчики пользовательского сезонного рейтинга
bot.action('user_seasonal_ratings', async ctx => {
	console.log(
		'User seasonal ratings accessed by:',
		ctx.from.id,
		ctx.from.first_name
	)
	await ctx.answerCbQuery()

	try {
		const seasons = await getSeasons()

		if (seasons.length === 0) {
			await ctx.editMessageText(
				'Сезоны не найдены.',
				Markup.inlineKeyboard([
					[Markup.button.callback('« Назад', 'view_ratings')],
				])
			)
			return
		}

		const keyboard = seasons.map(season => {
			const startDate = new Date(season.start_date).toLocaleDateString('ru-RU')
			const endDate = season.end_date
				? new Date(season.end_date).toLocaleDateString('ru-RU')
				: 'Текущий'

			return [
				Markup.button.callback(
					`📊 ${season.name} (${startDate} - ${endDate})`,
					`user_season_rating_${season._id}`
				),
			]
		})
		keyboard.push([Markup.button.callback('« Назад', 'view_ratings')])

		await ctx.editMessageText(
			'Выберите сезон для просмотра рейтинга:',
			Markup.inlineKeyboard(keyboard)
		)
	} catch (error) {
		console.error('Error getting seasons for user rating:', error)
		await ctx.reply('Произошла ошибка при получении списка сезонов.')
	}
})
