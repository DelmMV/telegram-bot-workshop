/** @type {import('next').NextConfig} */
const rootPackage = require('../package.json')

const inferredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ||
	(process.env.NODE_ENV === 'production' && rootPackage.name
		? `/${rootPackage.name}`
		: '')

const nextConfig = {
	output: 'export',
	basePath: inferredBasePath,
	assetPrefix: inferredBasePath ? `${inferredBasePath}/` : undefined,
	trailingSlash: true,
	images: {
		unoptimized: true,
	},
}

module.exports = nextConfig
