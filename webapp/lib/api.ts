import type {
	ApiResponse,
	OverallWorkshop,
	RatingType,
	Review,
	Season,
	SeasonalRatingType,
	Workshop,
} from './types'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''

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
		throw new Error('API base URL is not configured')
	}

	const url = buildUrl(path, params)
	const response = await fetch(url, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...(options.headers ?? {}),
		},
	})

	const data = (await response.json()) as T
	if (!response.ok) {
		throw new Error((data as { error?: string })?.error || 'API error')
	}
	return data
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
