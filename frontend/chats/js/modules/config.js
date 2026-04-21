/**
 * CONFIG.JS - Конфигурация приложения
 * Принцип SOLID: Single Responsibility
 * Отвечает только за хранение констант и конфигурации
 */

export const API_BASE_URL = window.location.origin;
export const WS_PROTOCOL = location.protocol === "https:" ? "wss" : "ws";

// Получаем данные пользователя из глобального контекста
export const getCurrentUser = () => ({
    email: window.CURRENT_USER_EMAIL,
    id: window.CURRENT_USER_ID
});

