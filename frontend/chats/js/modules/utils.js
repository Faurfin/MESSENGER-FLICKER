/**
 * UTILS.JS - Утилиты и вспомогательные функции
 * Принцип SOLID: Single Responsibility
 * Отвечает только за форматирование и утилиты
 */

/**
 * Форматирует ISO дату в время (HH:MM)
 * @param {string} iso - ISO строка даты
 * @returns {string} Отформатированное время
 */
export function formatTime(iso) {
    if (!iso) return "";
    // JavaScript Date автоматически конвертирует UTC время в локальный часовой пояс
    const d = new Date(iso);
    // Проверяем, что дата валидна
    if (isNaN(d.getTime())) return "";
    // Используем локальное время браузера (автоматически конвертируется из UTC)
    return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Форматирует статус "Был(а) в сети..."
 * @param {string} lastSeen - Время последнего визита
 * @param {boolean} isOnline - Онлайн ли пользователь
 * @param {HTMLElement} statusElement - Элемент статуса (опционально)
 * @returns {string} Отформатированный статус
 */
export function formatLastSeen(lastSeen, isOnline, statusElement = null) {
    // Если есть элемент статуса и он содержит "Печатает..."
    if (statusElement && statusElement.classList.contains("typing-status")) {
        return statusElement.textContent;
    }
    
    if (isOnline) {
        return "в сети";
    }

    if (!lastSeen || lastSeen === "online") {
        return "был(а) только что"; 
    }
    
    try {
        const d = new Date(lastSeen);
        if (isNaN(d.getTime())) return "";

        const now = new Date();
        const diffMs = now - d;
        const diffMin = Math.floor(diffMs / (1000 * 60));
        const diffHour = Math.floor(diffMin / 60);
        const diffDay = Math.floor(diffHour / 24);

        if (diffMin < 1) return "был(а) только что";
        if (diffMin < 60) return `был(а) ${diffMin} мин. назад`;
        if (diffHour < 24) return `был(а) ${diffHour} ч. назад`;
        if (diffDay === 1) return `был(а) вчера в ${formatTime(lastSeen)}`;
        return `был(а) ${d.toLocaleDateString('ru-RU')}`;
    
    } catch(e) {
        console.warn("Could not parse lastSeen date:", lastSeen);
        return "";
    }
}

