import type {
	ApiResponse,
	OverallWorkshop,
	RatingType,
	Review,
	Season,
	SeasonalRatingType,
	Workshop,
} from './types'

const DEFAULT_API_PORT = 5800
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function normalizeApiBaseUrl(value: string) {
	if (!value) return ''
	try {
		const url = new URL(value)
		const isLocalHost = LOCAL_HOSTS.has(url.hostname)
		if (!url.port && isLocalHost) url.port = String(DEFAULT_API_PORT)
		return url.toString().replace(/\/$/, '')
	} catch (error) {
		return value
	}
}

const API_BASE_URL = normalizeApiBaseUrl(
	process.env.NEXT_PUBLIC_API_BASE_URL || 'https://service.monopiter.ru'
)

function buildUrl(path: string, params?: Record<string, string | number | undefined>) {
	const url = new URL(path, API_BASE_URL)
	if (params) {
		Object.entries(params).forEach(([key, value]) => {
			if (value !== undefined && value !== '') {
				url.searchParams.set(key, String(value))
			}
		})
	}
	return url.toString()
}

async function fetchJson<T>(
	path: string,
	options: RequestInit = {},
	params?: Record<string, string | number | undefined>
): Promise<T> {
	if (!API_BASE_URL) {
		const errorMsg = 'API base URL is not configured. Check NEXT_PUBLIC_API_BASE_URL in webapp/.env.local'
		console.error('[API] ❌', errorMsg)
		throw new Error(errorMsg)
	}

	const url = buildUrl(path, params)
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...(options.headers as Record<string, string> ?? {}),
	}
	
	const initDataHeader = headers['X-Telegram-Init-Data']
	console.log('[API] 🚀 Request:', {
		url,
		method: options.method || 'GET',
		hasInitData: !!initDataHeader,
		initDataLength: initDataHeader ? initDataHeader.length : 0
	})

	try {
		const response = await fetch(url, {
			...options,
			headers,
		})

		console.log('[API] Response:', {
			status: response.status,
			statusText: response.statusText,
			ok: response.ok
		})

		if (!response.ok) {
			const errorData = await response.json().catch(() => ({ error: 'Failed to parse error response' }))
			console.error('[API] ❌ Error response:', errorData)
			
			// Provide specific error messages
			if (response.status === 401) {
				throw new Error('401: Unauthorized - Invalid or expired initData')
			} else if (response.status === 403) {
				throw new Error('403: Forbidden - Access denied')
			} else if (response.status === 404) {
				throw new Error('404: Not found - API endpoint does not exist')
			} else if (response.status >= 500) {
				throw new Error(`${response.status}: Server error - Please try again later`)
			}
			
			throw new Error((errorData as { error?: string })?.error || `API error ${response.status}`)
		}

		const data = (await response.json()) as T
		console.log('[API] ✅ Success:', { data })
		return data
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes('Failed to fetch')) {
				console.error('[API] ❌ Network error - Cannot reach API server')
				console.error('[API] ❌ Check if API is running and CORS is configured')
				throw new Error('Сетевая ошибка: не удалось подключиться к API. Проверьте соединение и CORS настройки.')
			}
			throw error
		}
		throw new Error('Unknown API error')
	}
}

export async function fetchWorkshops(initData?: string) {
	return fetchJson<ApiResponse<{ workshops: Workshop[] }>>('/api/workshops', {
		headers: initData ? { 'X-Telegram-Init-Data': initData } : undefined,
	})
}

export async function fetchRatings(type: RatingType, initData?: string) {
	if (type === 'overall') {
		return fetchJson<ApiResponse<{ workshops: OverallWorkshop[]; type: RatingType }>>(
			'/api/ratings',
			{
				headers: initData ? { 'X-Telegram-Init-Data': initData } : undefined,
			},
			{ type }
		)
	}

	return fetchJson<ApiResponse<{ workshops: Workshop[]; type: RatingType }>>(
		'/api/ratings',
		{
			headers: initData ? { 'X-Telegram-Init-Data': initData } : undefined,
		},
		{ type }
	)
}

export async function fetchSeasons(initData?: string) {
	return fetchJson<ApiResponse<{ seasons: Season[] }>>('/api/seasons', {
		headers: initData ? { 'X-Telegram-Init-Data': initData } : undefined,
	})
}

export async function fetchSeasonalRatings(
	seasonId: string,
	type: SeasonalRatingType,
	initData?: string
) {
	return fetchJson<
		ApiResponse<{
			workshops: (Workshop | OverallWorkshop)[]
			type: SeasonalRatingType
		}>
	>('/api/ratings/seasonal', {
		headers: initData ? { 'X-Telegram-Init-Data': initData } : undefined,
	}, {
		seasonId,
		type,
	})
}

export async function fetchReviews(
	workshop: string,
	page: number,
	limit: number,
	initData?: string
) {
	return fetchJson<
		ApiResponse<{
			reviews: Review[]
			page: number
			total_pages: number
			total_reviews: number
		}>
	>(
		'/api/reviews',
		{
			headers: initData ? { 'X-Telegram-Init-Data': initData } : undefined,
		},
		{ workshop, page, limit }
	)
}

export async function submitReview(
	payload: {
		workshop: string
		qualityRating: number
		communicationRating: number
		onTime: string
		textFeedback: string
	},
	initData: string
) {
	return fetchJson<ApiResponse<{ id: string }>>('/api/reviews', {
		method: 'POST',
		headers: {
			'X-Telegram-Init-Data': initData,
		},
		body: JSON.stringify(payload),
	})
}
