import './globals.css'

export const metadata = {
	title: 'Рейтинг мастерских',
	description: 'Мини-приложение для просмотра рейтингов и отзывов',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="ru">
			<body>
				<div className="ambient">
					<div className="orb orb-a" />
					<div className="orb orb-b" />
					<div className="orb orb-c" />
				</div>
				{children}
			</body>
		</html>
	)
}
