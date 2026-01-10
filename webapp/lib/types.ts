export type Workshop = {
	name: string
	address: string
	description: string
	avg_quality: number
	avg_communication: number
	total_reviews: number
	on_time_count: number
	on_time_percentage: number
}

export type OverallWorkshop = Workshop & {
	overall_rating: number
	base_rating: number
	quality_score: number
	communication_score: number
	log_factor: number
}

export type Season = {
	id: string
	name: string
	description: string
	start_date: string | null
	end_date: string | null
}

export type Review = {
	id: string
	workshop: string
	quality_rating: number
	communication_rating: number
	on_time: string
	text_feedback: string
	created_at: string | null
}

export type RatingType = 'overall' | 'quality' | 'communication' | 'delays'
export type SeasonalRatingType = 'overall' | 'quality' | 'communication' | 'timing'

export type ApiResponse<T> = {
	ok: boolean
	error?: string
	reason?: string
} & T
