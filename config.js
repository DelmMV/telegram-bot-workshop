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
};