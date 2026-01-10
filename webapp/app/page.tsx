'use client'

import { useEffect, useMemo, useState } from 'react'
import {
	fetchRatings,
	fetchReviews,
	fetchSeasonalRatings,
	fetchSeasons,
	fetchWorkshops,
	submitReview,
} from '../lib/api'
import type {
	OverallWorkshop,
	RatingType,
	Review,
	Season,
	SeasonalRatingType,
	Workshop,
} from '../lib/types'

const MAX_FEEDBACK_LENGTH = 1000
const REVIEWS_PER_PAGE = 5

type TabKey = 'ratings' | 'reviews' | 'feedback'

type TelegramUser = {
	id: number
	first_name?: string
	last_name?: string
	username?: string
}

type TelegramThemeParams = {
	bg_color?: string
	text_color?: string
	hint_color?: string
	button_color?: string
	button_text_color?: string
	secondary_bg_color?: string
}

type TelegramWebApp = {
	initData: string
	initDataUnsafe: { user?: TelegramUser }
	ready: () => void
	expand: () => void
	themeParams?: TelegramThemeParams
	onEvent?: (event: string, callback: () => void) => void
	offEvent?: (event: string, callback: () => void) => void
}

type TelegramWindow = Window & {
	Telegram?: {
		WebApp?: TelegramWebApp
	}
}

function isTelegramUser(value: unknown): value is TelegramUser {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	if (typeof record.id !== 'number') return false
	if (record.first_name !== undefined && typeof record.first_name !== 'string')
		return false
	if (record.last_name !== undefined && typeof record.last_name !== 'string')
		return false
	if (record.username !== undefined && typeof record.username !== 'string')
		return false
	return true
}

function parseTelegramUser(initData: string) {
	if (!initData) return null
	const userValue = new URLSearchParams(initData).get('user')
	if (!userValue) return null
	try {
		const parsed: unknown = JSON.parse(userValue)
		if (!isTelegramUser(parsed)) return null
		return parsed
	} catch (error) {
		return null
	}
}

function formatDate(value: string | null) {
	if (!value) return ''
	return new Date(value).toLocaleDateString('ru-RU')
}

function formatSeasonRange(season: Season) {
	const start = season.start_date ? formatDate(season.start_date) : '—'
	const end = season.end_date ? formatDate(season.end_date) : 'Текущий'
	return `${start} — ${end}`
}

function applyTelegramTheme(webApp?: TelegramWebApp) {
	if (!webApp?.themeParams) return
	const theme = webApp.themeParams
	const root = document.documentElement

	if (theme.bg_color) root.style.setProperty('--bg', theme.bg_color)
	if (theme.text_color) root.style.setProperty('--ink', theme.text_color)
	if (theme.hint_color) root.style.setProperty('--muted', theme.hint_color)
	if (theme.button_color) root.style.setProperty('--accent', theme.button_color)
	if (theme.button_text_color)
		root.style.setProperty('--tg-button-text', theme.button_text_color)
	if (theme.secondary_bg_color)
		root.style.setProperty('--card', theme.secondary_bg_color)
}

export default function HomePage() {
	const [activeTab, setActiveTab] = useState<TabKey>('ratings')
	const [initData, setInitData] = useState('')
	const [telegramUser, setTelegramUser] = useState<TelegramUser | null>(null)
	const [isTelegramWebApp, setIsTelegramWebApp] = useState(true)

	const [workshops, setWorkshops] = useState<Workshop[]>([])
	const [workshopsError, setWorkshopsError] = useState('')

	const [ratingType, setRatingType] = useState<RatingType>('overall')
	const [ratings, setRatings] = useState<(Workshop | OverallWorkshop)[]>([])
	const [ratingsError, setRatingsError] = useState('')
	const [isRatingsLoading, setIsRatingsLoading] = useState(false)

	const [seasons, setSeasons] = useState<Season[]>([])
	const [seasonalType, setSeasonalType] = useState<SeasonalRatingType>('overall')
	const [selectedSeasonId, setSelectedSeasonId] = useState('')
	const [seasonalRatings, setSeasonalRatings] = useState<
		(Workshop | OverallWorkshop)[]
	>([])
	const [seasonalError, setSeasonalError] = useState('')
	const [isSeasonalLoading, setIsSeasonalLoading] = useState(false)

	const [reviewsWorkshop, setReviewsWorkshop] = useState('')
	const [reviews, setReviews] = useState<Review[]>([])
	const [reviewsPage, setReviewsPage] = useState(0)
	const [reviewsTotalPages, setReviewsTotalPages] = useState(0)
	const [reviewsError, setReviewsError] = useState('')
	const [isReviewsLoading, setIsReviewsLoading] = useState(false)

	const [feedbackWorkshop, setFeedbackWorkshop] = useState('')
	const [qualityRating, setQualityRating] = useState<number | null>(null)
	const [communicationRating, setCommunicationRating] = useState<number | null>(null)
	const [onTime, setOnTime] = useState<'Да' | 'Нет' | ''>('')
	const [textFeedback, setTextFeedback] = useState('')
	const [submitStatus, setSubmitStatus] = useState<
		{ type: 'success' | 'error'; message: string } | null
	>(null)
	const [isSubmitting, setIsSubmitting] = useState(false)

	useEffect(() => {
		const webApp = (window as TelegramWindow).Telegram?.WebApp
		if (!webApp) {
			setIsTelegramWebApp(false)
			return
		}

		webApp.ready()
		webApp.expand()
		const fallbackUser = parseTelegramUser(webApp.initData || '')
		setInitData(webApp.initData || '')
		setTelegramUser(webApp.initDataUnsafe?.user ?? fallbackUser)
		applyTelegramTheme(webApp)

		const themeHandler = () => applyTelegramTheme(webApp)
		webApp.onEvent?.('themeChanged', themeHandler)

		return () => {
			webApp.offEvent?.('themeChanged', themeHandler)
		}
	}, [])

	useEffect(() => {
		async function loadWorkshops() {
			setWorkshopsError('')
			try {
				const response = await fetchWorkshops(initData)
				if (response.ok) {
					setWorkshops(response.workshops)
				}
			} catch (error) {
				setWorkshopsError('Не удалось загрузить мастерские')
			}
		}

		async function loadSeasons() {
			setSeasonalError('')
			try {
				const response = await fetchSeasons(initData)
				if (response.ok) {
					setSeasons(response.seasons)
					if (!selectedSeasonId && response.seasons.length > 0) {
						setSelectedSeasonId(response.seasons[0].id)
					}
				}
			} catch (error) {
				setSeasonalError('Не удалось загрузить сезоны')
			}
		}

		loadWorkshops()
		loadSeasons()
	}, [initData])

	useEffect(() => {
		if (workshops.length === 0) return
		if (!reviewsWorkshop) setReviewsWorkshop(workshops[0].name)
		if (!feedbackWorkshop) setFeedbackWorkshop(workshops[0].name)
	}, [workshops, reviewsWorkshop, feedbackWorkshop])

	useEffect(() => {
		async function loadRatings() {
			setRatingsError('')
			setIsRatingsLoading(true)
			try {
				const response = await fetchRatings(ratingType, initData)
				if (response.ok) setRatings(response.workshops)
			} catch (error) {
				setRatingsError('Не удалось загрузить рейтинг')
			} finally {
				setIsRatingsLoading(false)
			}
		}

		loadRatings()
	}, [ratingType, initData])

	useEffect(() => {
		if (!selectedSeasonId) return

		async function loadSeasonalRatings() {
			setSeasonalError('')
			setIsSeasonalLoading(true)
			try {
				const response = await fetchSeasonalRatings(
					selectedSeasonId,
					seasonalType,
					initData
				)
				if (response.ok) setSeasonalRatings(response.workshops)
			} catch (error) {
				setSeasonalError('Не удалось загрузить сезонный рейтинг')
			} finally {
				setIsSeasonalLoading(false)
			}
		}

		loadSeasonalRatings()
	}, [selectedSeasonId, seasonalType, initData])

	useEffect(() => {
		if (!reviewsWorkshop) return

		async function loadReviews() {
			setReviewsError('')
			setIsReviewsLoading(true)
			try {
				const response = await fetchReviews(
					reviewsWorkshop,
					reviewsPage,
					REVIEWS_PER_PAGE,
					initData
				)
				if (response.ok) {
					setReviews(response.reviews)
					setReviewsTotalPages(response.total_pages)
				}
			} catch (error) {
				setReviewsError('Не удалось загрузить отзывы')
			} finally {
				setIsReviewsLoading(false)
			}
		}

		loadReviews()
	}, [reviewsWorkshop, reviewsPage, initData])

	const ratingTabs = useMemo(
		() => [
			{ key: 'overall' as const, label: 'Общий' },
			{ key: 'quality' as const, label: 'Качество' },
			{ key: 'communication' as const, label: 'Коммуникация' },
			{ key: 'delays' as const, label: 'Сроки' },
		],
		[]
	)

	const seasonalTabs = useMemo(
		() => [
			{ key: 'overall' as const, label: 'Общий' },
			{ key: 'quality' as const, label: 'Качество' },
			{ key: 'communication' as const, label: 'Коммуникация' },
			{ key: 'timing' as const, label: 'Сроки' },
		],
		[]
	)

	async function handleSubmitReview() {
		setSubmitStatus(null)

		if (!initData) {
			setSubmitStatus({
				type: 'error',
				message: 'Откройте мини-приложение через Telegram',
			})
			return
		}
		if (!feedbackWorkshop || !qualityRating || !communicationRating || !onTime) {
			setSubmitStatus({
				type: 'error',
				message: 'Заполните все обязательные поля',
			})
			return
		}

		setIsSubmitting(true)
		try {
			await submitReview(
				{
					workshop: feedbackWorkshop,
					qualityRating,
					communicationRating,
					onTime,
					textFeedback,
				},
				initData
			)
			setSubmitStatus({ type: 'success', message: 'Спасибо! Отзыв отправлен.' })
			setQualityRating(null)
			setCommunicationRating(null)
			setOnTime('')
			setTextFeedback('')
			if (reviewsWorkshop === feedbackWorkshop) {
				setReviewsPage(0)
			}
		} catch (error) {
			setSubmitStatus({
				type: 'error',
				message: 'Не удалось отправить отзыв. Попробуйте позже.',
			})
		} finally {
			setIsSubmitting(false)
		}
	}

	return (
		<div className="page">
			<header className="hero">
				<h1>Рейтинг мастерских</h1>
				<p>
					Смотрите свежие рейтинги, читайте отзывы и оставляйте свой опыт за пару
					шагов.
				</p>
				<div className="meta">
					<div className="pill">Telegram Mini App</div>
					<div className="pill">
						{telegramUser?.first_name
							? `Вы вошли как ${telegramUser.first_name}`
							: 'Гость'}
					</div>
					{workshops.length > 0 && (
						<div className="pill">Мастерских: {workshops.length}</div>
					)}
				</div>
			</header>

			{!isTelegramWebApp && (
				<div className="section" style={{ marginTop: 18 }}>
					<div className="notice">
						Откройте мини-приложение внутри Telegram, чтобы использовать все функции.
					</div>
				</div>
			)}

			{workshopsError && (
				<div className="section" style={{ marginTop: 18 }}>
					<div className="status error">{workshopsError}</div>
				</div>
			)}

			<nav className="nav-tabs">
				<button
					className={activeTab === 'ratings' ? 'active' : ''}
					onClick={() => setActiveTab('ratings')}
				>
					Рейтинги
				</button>
				<button
					className={activeTab === 'reviews' ? 'active' : ''}
					onClick={() => setActiveTab('reviews')}
				>
					Отзывы
				</button>
				<button
					className={activeTab === 'feedback' ? 'active' : ''}
					onClick={() => setActiveTab('feedback')}
				>
					Оставить отзыв
				</button>
			</nav>

			{activeTab === 'ratings' && (
				<section className="section">
					<h2>Основные рейтинги</h2>
					<p>Сравнивайте мастерские по ключевым критериям.</p>
					<div className="segmented">
						{ratingTabs.map(tab => (
							<button
								key={tab.key}
								className={ratingType === tab.key ? 'active' : ''}
								onClick={() => setRatingType(tab.key)}
							>
								{tab.label}
							</button>
						))}
					</div>
					{ratingsError && <div className="status error">{ratingsError}</div>}
					{isRatingsLoading ? (
						<div className="notice">Загружаем рейтинг...</div>
					) : (
						<div className="grid">
							{ratings.map((workshop, index) => (
								<div className="card" key={`${workshop.name}-${index}`}>
									<h3>{workshop.name}</h3>
									<div className="stat">{workshop.address}</div>
									<div className="stat">{workshop.description}</div>
									{ratingType === 'overall' && 'overall_rating' in workshop ? (
										<div className="badge">
											🏆 {workshop.overall_rating.toFixed(2)}
										</div>
									) : null}
									<div className="stat">
										⭐️ Качество: {workshop.avg_quality.toFixed(2)} / 5
									</div>
									<div className="stat">
										💬 Коммуникация: {workshop.avg_communication.toFixed(2)} / 5
									</div>
									<div className="stat">
										⏰ Вовремя: {workshop.on_time_percentage.toFixed(1)}%
									</div>
									<div className="stat">
										📝 Отзывов: {workshop.total_reviews}
									</div>
								</div>
							))}
						</div>
					)}

					<div style={{ height: 24 }} />

					<h2>Сезонный рейтинг</h2>
					<p>Выберите сезон и оцените лидеров периода.</p>
					<div className="field">
						<label>Сезон</label>
						<select
							value={selectedSeasonId}
							onChange={event => setSelectedSeasonId(event.target.value)}
						>
							{seasons.map(season => (
								<option key={season.id} value={season.id}>
									{season.name} ({formatSeasonRange(season)})
								</option>
							))}
						</select>
					</div>
					<div className="segmented" style={{ marginTop: 12 }}>
						{seasonalTabs.map(tab => (
							<button
								key={tab.key}
								className={seasonalType === tab.key ? 'active' : ''}
								onClick={() => setSeasonalType(tab.key)}
							>
								{tab.label}
							</button>
						))}
					</div>
					{seasonalError && <div className="status error">{seasonalError}</div>}
					{isSeasonalLoading ? (
						<div className="notice">Загружаем сезонный рейтинг...</div>
					) : (
						<div className="grid">
							{seasonalRatings.map((workshop, index) => (
								<div className="card" key={`${workshop.name}-${index}`}>
									<h3>{workshop.name}</h3>
									{seasonalType === 'overall' && 'overall_rating' in workshop ? (
										<div className="badge">
											🏆 {workshop.overall_rating.toFixed(2)}
										</div>
									) : null}
									<div className="stat">
										⭐️ Качество: {workshop.avg_quality.toFixed(2)} / 5
									</div>
									<div className="stat">
										💬 Коммуникация: {workshop.avg_communication.toFixed(2)} / 5
									</div>
									<div className="stat">
										⏰ Вовремя: {workshop.on_time_percentage.toFixed(1)}%
									</div>
									<div className="stat">
										📝 Отзывов: {workshop.total_reviews}
									</div>
								</div>
							))}
						</div>
					)}
				</section>
			)}

			{activeTab === 'reviews' && (
				<section className="section">
					<h2>Отзывы клиентов</h2>
					<p>Выберите мастерскую и листайте отзывы.</p>
					<div className="field">
						<label>Мастерская</label>
						<select
							value={reviewsWorkshop}
							onChange={event => {
								setReviewsWorkshop(event.target.value)
								setReviewsPage(0)
							}}
						>
							{workshops.map(workshop => (
								<option key={workshop.name} value={workshop.name}>
									{workshop.name}
								</option>
							))}
						</select>
					</div>
					{reviewsError && <div className="status error">{reviewsError}</div>}
					{isReviewsLoading ? (
						<div className="notice">Загружаем отзывы...</div>
					) : (
						<div className="reviews">
							{reviews.length === 0 && (
								<div className="notice">
									Пока нет отзывов для этой мастерской.
								</div>
							)}
							{reviews.map(review => (
								<div className="review-card" key={review.id}>
									<div className="meta">
										{formatDate(review.created_at)} · ⭐️ {review.quality_rating}/5 ·
										💬 {review.communication_rating}/5 · ⏰ {review.on_time}
									</div>
									<div>{review.text_feedback}</div>
								</div>
							))}
						</div>
					)}
					<div className="pagination">
						<button
							disabled={reviewsPage <= 0}
							onClick={() => setReviewsPage(page => Math.max(page - 1, 0))}
						>
							Назад
						</button>
						<button
							disabled={reviewsPage + 1 >= reviewsTotalPages}
							onClick={() => setReviewsPage(page => page + 1)}
						>
							Вперед
						</button>
					</div>
				</section>
			)}

			{activeTab === 'feedback' && (
				<section className="section">
					<h2>Оставить отзыв</h2>
					<p>Пара минут — и ваш отзыв поможет другим.</p>
					<form
						className="form"
						onSubmit={event => {
							event.preventDefault()
							handleSubmitReview()
						}}
					>
						<div className="field">
							<label>Мастерская</label>
							<select
								value={feedbackWorkshop}
								onChange={event => setFeedbackWorkshop(event.target.value)}
							>
								{workshops.map(workshop => (
									<option key={workshop.name} value={workshop.name}>
										{workshop.name}
									</option>
								))}
							</select>
						</div>

						<div className="field">
							<label>Качество работы</label>
							<div className="rating-row">
								{[1, 2, 3, 4, 5].map(value => (
									<button
										type="button"
										key={`quality-${value}`}
										className={qualityRating === value ? 'active' : ''}
										onClick={() => setQualityRating(value)}
									>
										{value}
									</button>
								))}
							</div>
						</div>

						<div className="field">
							<label>Коммуникация</label>
							<div className="rating-row">
								{[1, 2, 3, 4, 5].map(value => (
									<button
										type="button"
										key={`communication-${value}`}
										className={communicationRating === value ? 'active' : ''}
										onClick={() => setCommunicationRating(value)}
									>
										{value}
									</button>
								))}
							</div>
						</div>

						<div className="field">
							<label>Ремонт выполнен вовремя?</label>
							<div className="toggle">
								<button
									type="button"
									className={onTime === 'Да' ? 'active' : ''}
									onClick={() => setOnTime('Да')}
								>
									Да
								</button>
								<button
									type="button"
									className={onTime === 'Нет' ? 'active' : ''}
									onClick={() => setOnTime('Нет')}
								>
									Нет
								</button>
							</div>
						</div>

						<div className="field">
							<label>Комментарий (необязательно)</label>
							<textarea
								maxLength={MAX_FEEDBACK_LENGTH}
								value={textFeedback}
								onChange={event => setTextFeedback(event.target.value)}
								placeholder="Что особенно понравилось?"
							/>
							<div className="stat">
								{textFeedback.length} / {MAX_FEEDBACK_LENGTH}
							</div>
						</div>

						{submitStatus && (
							<div className={`status ${submitStatus.type}`}>
								{submitStatus.message}
							</div>
						)}

						<button className="primary" type="submit" disabled={isSubmitting}>
							{isSubmitting ? 'Отправляем...' : 'Отправить отзыв'}
						</button>
					</form>
				</section>
			)}
		</div>
	)
}
