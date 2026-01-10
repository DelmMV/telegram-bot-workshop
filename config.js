require('dotenv').config();

module.exports = {
    // Токен бота
    BOT_TOKEN: process.env.BOT_TOKEN,

    // MongoDB
    MONGODB_URI: process.env.MONGODB_URI,
    DB_NAME: process.env.DB_NAME,

    // Администрирование
    ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID,
    ADMIN_IDS: process.env.ADMIN_IDS.split(',').map(id => parseInt(id)),
    API_PORT: Number(process.env.API_PORT) || 3001,
    WEBAPP_URL: process.env.WEBAPP_URL,
    WEBAPP_ORIGINS: process.env.WEBAPP_ORIGINS
        ? process.env.WEBAPP_ORIGINS.split(',').map(origin => origin.trim())
        : [],
    WEBAPP_AUTH_MAX_AGE_SECONDS: Number(process.env.WEBAPP_AUTH_MAX_AGE_SECONDS) || 86400,
    ENABLE_DAILY_VOTE_LIMIT: process.env.ENABLE_DAILY_VOTE_LIMIT === 'true',
};
