const { Telegraf, Scenes, session } = require('telegraf')
const { MongoClient, ObjectId } = require('mongodb')
const { Markup } = require('telegraf')
const config = require('./config')

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
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Функция экранирования специальных символов Markdown
function escapeMarkdown(text) {
	return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
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

async function notifyAdminsAboutNewFeedback(ctx, feedback) {
	try {
		const workshop = await db
			.collection('workshops')
			.findOne({ name: feedback.workshop })

		// Обрезаем текст отзыва, если он слишком длинный
		const maxFeedbackLength = MAX_FEEDBACK_LENGTH // Можно настроить по необходимости
		const truncatedFeedback =
			feedback.text_feedback.length > maxFeedbackLength
				? feedback.text_feedback.substring(0, maxFeedbackLength) + '...'
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

		// Добавляем текущую статистику мастерской
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

		// Отправляем сообщение в админский чат
		await ctx.telegram.sendMessage(ADMIN_CHAT_ID, message, {
			parse_mode: 'HTML',
			disable_web_page_preview: true,
		})
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
		[Markup.button.callback('➕ Добавить мастерскую', 'admin_add_workshop')],
		[Markup.button.callback('❌ Удалить мастерскую', 'admin_remove_workshop')],
		[Markup.button.callback('📋 Список мастерских', 'admin_list_workshops')],
	])
}

// Создаем клавиатуру для главного меню
const mainKeyboard = Markup.keyboard([
	['👍 Оставить отзыв', '📊 Рейтинг/Отзывы'],
	['📋 Список сервисов'],
]).resize()

function getMainKeyboard() {
	return Markup.keyboard([
		['👍 Оставить отзыв', '📊 Рейтинг/Отзывы'],
		['📋 Список сервисов'],
	]).resize()
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

// Создание stage
const stage = new Scenes.Stage([
	workshopScene,
	qualityScene,
	onTimeScene,
	communicationScene,
	textFeedbackScene,
	searchUserScene,
	addWorkshopScene,
])

// Подключение middleware
bot.use(session())
bot.use(stage.middleware())

// Обработчики команд
bot.command('start', ctx => {
	if (ctx.chat.type !== 'private') {
		return // Просто игнорируем команду в групповых чатах
	}
	ctx.reply(
		'Привет! Выберите действие:',
		getMainKeyboard() // Используем функцию
	)
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
	await ctx.editMessageText(
		'Выберите тип рейтинга:',
		Markup.inlineKeyboard([
			[Markup.button.callback('⭐️ По качеству работ', 'rating_quality')],
			[Markup.button.callback('💬 По коммуникации', 'rating_communication')],
			[Markup.button.callback('⏰ Соблюдение сроков', 'rating_delays')],
			[Markup.button.callback('« Назад', 'back_to_rating_menu')],
		])
	)
})

bot.action('view_reviews', async ctx => {
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
			text_feedback: { $exists: true, $ne: '' },
		})

		const totalPages = Math.ceil(totalReviews / reviewsPerPage)

		const reviews = await db
			.collection('feedback')
			.find({
				workshop: workshopName,
				text_feedback: { $exists: true, $ne: '' },
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
		console.error('Error getting workshop reviews:', error)
		await ctx.reply('Произошла ошибка при получении отзывов.')
	}
})

bot.action('back_to_rating_menu', async ctx => {
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

// Подключение к MongoDB и запуск бота
async function setupDatabase() {
	try {
		await db.collection('workshops').createIndex({ name: 1 }, { unique: true })
		console.log('Database indexes created')
	} catch (error) {
		console.error('Error creating indexes:', error)
	}
}

async function connectToMongo() {
	try {
		await mongoClient.connect()
		db = mongoClient.db(config.DB_NAME)
		await setupDatabase()
		console.log('Connected to MongoDB')
	} catch (error) {
		console.error('MongoDB connection error:', error)
	}
}

connectToMongo().then(() => {
	bot.launch().then(() => {
		console.log('Bot started')
	})
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
