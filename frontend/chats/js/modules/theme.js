/**
 * THEME.JS - Модуль управления темами и настройками оформления
 * Поддерживает светлую/тёмную тему и кастомизацию цветов (как в Telegram)
 */

// Настройки темы по умолчанию (Gen Z / Premium palette)
const DEFAULT_THEME = {
    mode: 'light',
    colors: {
        primary: '#5865f2',
        backgroundApp: '#f4f4f7',
        background1: '#FFFFFF',
        background2: 'rgba(255, 255, 255, 0.72)',
        backgroundMessage: '#f0f2f5',
        textDark: '#1c1c1e',
        textInactive: '#8e8e93',
        divider: 'rgba(0, 0, 0, 0.06)',
        online: '#34c759',
    }
};

// Тёмная тема по умолчанию
const DARK_THEME = {
    mode: 'dark',
    colors: {
        primary: '#7c8aff',
        backgroundApp: '#0c0c0f',
        background1: '#1c1c1e',
        background2: 'rgba(28, 28, 30, 0.85)',
        backgroundMessage: '#2c2c2e',
        textDark: '#FFFFFF',
        textInactive: '#8e8e93',
        divider: 'rgba(255, 255, 255, 0.08)',
        online: '#34c759',
    }
};

// Предустановленные темы чатов
const CHAT_THEMES = {
    classic: {
        mode: 'light',
        colors: {
            primary: '#5865f2',
            backgroundApp: '#f4f4f7',
            background1: '#FFFFFF',
            background2: 'rgba(255, 255, 255, 0.72)',
            backgroundMessage: '#f0f2f5',
            textDark: '#1c1c1e',
            textInactive: '#8e8e93',
            divider: 'rgba(0, 0, 0, 0.06)'
        }
    },
    darkBlue: {
        mode: 'dark',
        colors: {
            primary: '#7c8aff',
            backgroundApp: '#0c0c0f',
            background1: '#1c1c1e',
            background2: 'rgba(28, 28, 30, 0.85)',
            backgroundMessage: '#2c2c2e',
            textDark: '#FFFFFF',
            textInactive: '#8e8e93',
            divider: 'rgba(255, 255, 255, 0.08)'
        }
    },
    mint: {
        mode: 'light',
        colors: {
            primary: '#37C878',
            backgroundApp: '#FFFFFF',
            background1: '#FFFFFF',
            background2: '#E9FBF3',
            backgroundMessage: '#F5FFFA',
            textDark: '#02060F',
            textInactive: '#7A8A8F',
            divider: '#D6EADF'
        }
    },
    sunset: {
        mode: 'light',
        colors: {
            primary: '#F97316',
            backgroundApp: '#FFF7ED',
            background1: '#FFFFFF',
            background2: '#FFEDD5',
            backgroundMessage: '#FFF3E0',
            textDark: '#1F2933',
            textInactive: '#9A7B5C',
            divider: '#FED7AA'
        }
    },
    violet: {
        mode: 'dark',
        colors: {
            primary: '#EC4899',
            backgroundApp: '#111827',
            background1: '#1F2937',
            background2: '#111827',
            backgroundMessage: '#312E81',
            textDark: '#FFFFFF',
            textInactive: '#9CA3AF',
            divider: '#4B5563'
        }
    },
    graphite: {
        mode: 'dark',
        colors: {
            primary: '#6366F1',
            backgroundApp: '#020617',
            background1: '#020617',
            background2: '#030712',
            backgroundMessage: '#111827',
            textDark: '#FFFFFF',
            textInactive: '#6B7280',
            divider: '#27272A'
        }
    }
};

// "Черновик" текущей темы — все изменения в панели пишем сюда,
// а в localStorage сохраняем только после нажатия "Сохранить"
let pendingTheme = null;

/**
 * Загружает сохранённую тему из localStorage
 */
function loadTheme() {
    try {
        const saved = localStorage.getItem('flicker_theme');
        if (saved) {
            return JSON.parse(saved);
        }
    } catch (e) {
        console.error('Ошибка загрузки темы:', e);
    }
    return DEFAULT_THEME;
}

/**
 * Сохраняет тему в localStorage
 */
function saveTheme(theme) {
    try {
        localStorage.setItem('flicker_theme', JSON.stringify(theme));
    } catch (e) {
        console.error('Ошибка сохранения темы:', e);
    }
}

/**
 * Применяет тему к документу
 */
function applyTheme(theme) {
    const root = document.documentElement;

    // Применяем цвета
    root.style.setProperty('--color-primary', theme.colors.primary);
    root.style.setProperty('--color-background-app', theme.colors.backgroundApp);
    root.style.setProperty('--color-background-1', theme.colors.background1);
    root.style.setProperty('--color-background-2', theme.colors.background2);
    root.style.setProperty('--color-background-message', theme.colors.backgroundMessage);
    root.style.setProperty('--color-text-dark', theme.colors.textDark);
    root.style.setProperty('--color-text-inactive', theme.colors.textInactive);
    root.style.setProperty('--color-divider', theme.colors.divider);
    root.style.setProperty('--color-online', theme.colors.online);

    // Применяем режим (светлый/тёмный)
    if (theme.mode === 'dark') {
        document.body.classList.add('theme-dark');
        document.body.classList.remove('theme-light');
    } else {
        document.body.classList.add('theme-light');
        document.body.classList.remove('theme-dark');
    }

    // Обновляем hover цвета
    const primaryRgb = hexToRgb(theme.colors.primary);
    if (primaryRgb) {
        root.style.setProperty('--color-background-hover',
            `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.05)`);
    }
}

/**
 * Переключает между светлой и тёмной темой
 */
function toggleTheme() {
    const currentTheme = loadTheme();
    const newMode = currentTheme.mode === 'light' ? 'dark' : 'light';

    let newTheme;
    if (newMode === 'dark') {
        // Переключаемся на тёмную тему
        newTheme = {
            ...DARK_THEME,
            colors: {
                ...DARK_THEME.colors,
                // Сохраняем кастомные цвета, если они были изменены
                primary: currentTheme.colors.primary !== DEFAULT_THEME.colors.primary
                    ? currentTheme.colors.primary
                    : DARK_THEME.colors.primary
            }
        };
    } else {
        // Переключаемся на светлую тему
        newTheme = {
            ...DEFAULT_THEME,
            colors: {
                ...DEFAULT_THEME.colors,
                // Сохраняем кастомные цвета, если они были изменены
                primary: currentTheme.colors.primary !== DARK_THEME.colors.primary
                    ? currentTheme.colors.primary
                    : DEFAULT_THEME.colors.primary
            }
        };
    }

    // Включаем плавный переход темы через вспомогательный класс
    try {
        document.body.classList.add('theme-transitioning');
    } catch (e) { }

    saveTheme(newTheme);
    applyTheme(newTheme);
    updateThemeToggleButton(newMode);

    // Через небольшой таймер убираем класс перехода
    setTimeout(() => {
        try {
            document.body.classList.remove('theme-transitioning');
        } catch (e) { }
    }, 260);

    return newTheme;
}

/**
 * Обновляет цвет в текущей теме
 */
function updateThemeColor(colorName, colorValue) {
    const currentTheme = loadTheme();
    const newTheme = {
        ...currentTheme,
        colors: {
            ...currentTheme.colors,
            [colorName]: colorValue
        }
    };

    saveTheme(newTheme);
    applyTheme(newTheme);
    return newTheme;
}

/**
 * Сбрасывает тему к значениям по умолчанию
 */
function resetTheme() {
    const currentMode = loadTheme().mode;
    const defaultTheme = currentMode === 'dark' ? DARK_THEME : DEFAULT_THEME;

    saveTheme(defaultTheme);
    applyTheme(defaultTheme);
    updateThemeToggleButton(currentMode);

    // Обновляем значения в инпутах, если панель открыта
    const appearancePanel = document.getElementById('appearanceSettingsPanel');
    if (appearancePanel && !appearancePanel.classList.contains('hidden')) {
        const colorInputs = appearancePanel.querySelectorAll('.theme-color-input');
        colorInputs.forEach(input => {
            const colorName = input.dataset.colorName;
            if (colorName && defaultTheme.colors[colorName]) {
                input.value = defaultTheme.colors[colorName];
                const valueSpan = input.closest('.theme-color-input-wrapper')?.querySelector('.theme-color-value');
                if (valueSpan) {
                    valueSpan.textContent = defaultTheme.colors[colorName].toUpperCase();
                }
            }
        });
    }

    return defaultTheme;
}

/**
 * Обновляет UI кнопки переключения темы
 */
function updateThemeToggleButton(mode) {
    // Кнопки переключения темы больше нет, но оставляем функцию
    // для совместимости, чтобы старый код мог её вызывать без ошибок.
}

/**
 * Конвертирует hex в RGB
 */
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

/**
 * Инициализирует систему тем
 * ОПТИМИЗАЦИЯ: Тема уже применена через inline script в <head>,
 * здесь только синхронизируем и инициализируем панель
 */
export function initTheme() {
    try {
        // Загружаем сохранённую тему (уже применена через inline script)
        const theme = loadTheme();
        pendingTheme = theme;

        // Синхронизируем тему (на случай если inline script не сработал)
        // Но не применяем заново, чтобы избежать мелькания
        if (!document.body.classList.contains('theme-loaded')) {
            applyTheme(theme);
            document.body.classList.add('theme-loaded');
        } else {
            // Только обновляем переменные CSS если нужно
            const root = document.documentElement;
            const currentPrimary = getComputedStyle(root).getPropertyValue('--color-primary').trim();
            if (!currentPrimary || currentPrimary === '') {
                // Если переменные не установлены, применяем тему
                applyTheme(theme);
            }
        }

        updateThemeToggleButton(theme.mode);

        // Инициализируем панель настройки оформления
        initAppearancePanel();
    } catch (error) {
        console.error('Ошибка инициализации темы:', error);
        // В случае ошибки показываем контент
        document.body.classList.add('theme-loaded');
    }
}

/**
 * Инициализирует панель настройки оформления
 */
function initAppearancePanel() {
    try {
        const appearancePanel = document.getElementById('appearanceSettingsPanel');
        if (!appearancePanel) {
            console.warn('Панель настройки оформления не найдена');
            return;
        }

        // Берём сохранённую тему как базу для инициализации панели
        if (!pendingTheme) {
            pendingTheme = loadTheme();
        }
        const currentTheme = pendingTheme;

        // Выбор предустановленных тем
        const themesGrid = appearancePanel.querySelector('#chatThemesGrid');
        if (themesGrid) {
            const cards = Array.from(themesGrid.querySelectorAll('.chat-theme-card'));

            const applyPresetTheme = (presetKey) => {
                const preset = CHAT_THEMES[presetKey];
                if (!preset) return;

                const current = pendingTheme || loadTheme();
                const newTheme = {
                    ...current,
                    mode: preset.mode,
                    colors: {
                        ...current.colors,
                        ...preset.colors
                    }
                };

                // Сохраняем только в "черновик". Весь интерфейс окончательно
                // обновится после нажатия «Сохранить».
                pendingTheme = newTheme;
                applyTheme(newTheme);             // живой предпросмотр
                updateThemeToggleButton(newTheme.mode);

                // Подсветка выбранной карточки
                cards.forEach(card => card.classList.remove('chat-theme-card--active'));
                const activeCard = themesGrid.querySelector(`[data-theme-id="${presetKey}"]`);
                if (activeCard) activeCard.classList.add('chat-theme-card--active');
            };

            // Устанавливаем активную карту по текущему режиму
            const initialKey =
                currentTheme.mode === 'dark'
                    ? 'darkBlue'
                    : 'classic';
            const initialCard = themesGrid.querySelector(`[data-theme-id="${initialKey}"]`);
            if (initialCard) {
                initialCard.classList.add('chat-theme-card--active');
            }

            cards.forEach(card => {
                const key = card.dataset.themeId;
                if (!key) return;
                card.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    applyPresetTheme(key);
                });
            });
        }

        // Кнопка сохранения текущей темы (фиксирует выбранные настройки во всех темах)
        const saveBtn = appearancePanel.querySelector('#themeSaveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Фиксируем текущий "черновик" в localStorage и применяем его окончательно
                const finalTheme = pendingTheme || loadTheme();
                saveTheme(finalTheme);
                applyTheme(finalTheme);
                updateThemeToggleButton(finalTheme.mode);
                // Небольшой визуальный отклик на кнопке
                saveBtn.disabled = true;
                const originalText = saveBtn.textContent;
                saveBtn.textContent = 'Сохранено';
                setTimeout(() => {
                    saveBtn.disabled = false;
                    saveBtn.textContent = originalText;
                }, 800);
            });
        }

        // Кнопка сброса
        const resetBtn = appearancePanel.querySelector('#themeResetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (confirm('Сбросить все настройки оформления к значениям по умолчанию?')) {
                    // Сбрасываем только "черновик" темы; в localStorage запишем после «Сохранить»
                    const mode = (pendingTheme || loadTheme()).mode;
                    const defaultTheme = mode === 'dark' ? DARK_THEME : DEFAULT_THEME;
                    pendingTheme = defaultTheme;
                    applyTheme(defaultTheme);      // обновляем предпросмотр и чат
                    updateThemeToggleButton(defaultTheme.mode);
                    // Сбрасываем выделение карточек тем
                    const themesGridAfter = appearancePanel.querySelector('#chatThemesGrid');
                    if (themesGridAfter) {
                        const cardsAfter = themesGridAfter.querySelectorAll('.chat-theme-card');
                        cardsAfter.forEach(card => card.classList.remove('chat-theme-card--active'));
                        const themeAfter = pendingTheme || loadTheme();
                        const keyAfter =
                            themeAfter.mode === 'dark'
                                ? 'darkBlue'
                                : 'classic';
                        const initialCardAfter = themesGridAfter.querySelector(`[data-theme-id="${keyAfter}"]`);
                        if (initialCardAfter) initialCardAfter.classList.add('chat-theme-card--active');
                    }
                }
            });
        }

        // Палитра цвета исходящих сообщений (меняет только цвет primary)
        const palette = appearancePanel.querySelector('#messageColorPalette');
        if (palette) {
            const swatches = Array.from(palette.querySelectorAll('.message-color-swatch'));

            const setActiveSwatch = (color) => {
                swatches.forEach(sw => {
                    const c = sw.dataset.messageColor;
                    if (!c) return;
                    if (c.toLowerCase() === color.toLowerCase()) {
                        sw.classList.add('message-color-swatch--active');
                    } else {
                        sw.classList.remove('message-color-swatch--active');
                    }
                });
            };

            // Инициализация активного цвета по текущей теме
            if (currentTheme.colors && currentTheme.colors.primary) {
                setActiveSwatch(currentTheme.colors.primary);
            }

            swatches.forEach(sw => {
                const color = sw.dataset.messageColor;
                if (!color) return;
                sw.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const themeNow = pendingTheme || loadTheme();
                    const newTheme = {
                        ...themeNow,
                        colors: {
                            ...themeNow.colors,
                            // Основной акцент (исходящие сообщения, кнопки и т.д.)
                            primary: color
                        }
                    };
                    // Меняем цвет только в "черновике",
                    // сохраняем в localStorage и применяем после «Сохранить»
                    pendingTheme = newTheme;
                    applyTheme(newTheme);          // живой предпросмотр для всех тем
                    setActiveSwatch(color);
                });
            });
        }
    } catch (error) {
        console.error('Ошибка инициализации панели оформления:', error);
    }
}

/**
 * Открывает панель настройки оформления
 */
export function openAppearancePanel() {
    try {
        const appearancePanel = document.getElementById('appearanceSettingsPanel');
        const settingsInfo = document.getElementById('settingsInfo');

        if (!appearancePanel) {
            console.error('Панель настройки оформления не найдена в DOM');
            return;
        }

        if (!settingsInfo) {
            console.error('Элемент settingsInfo не найден в DOM');
            return;
        }

        // Скрываем другие панели
        const myProfilePanel = document.getElementById('myProfileSettingsPanel');
        const privacyPanel = document.getElementById('privacySettingsPanel');
        if (myProfilePanel) myProfilePanel.classList.add('hidden');
        if (privacyPanel) privacyPanel.classList.add('hidden');

        // Скрываем стандартную панель информации
        const infoContent = settingsInfo.querySelector('.settings-info-content');
        if (infoContent) {
            infoContent.classList.add('hidden');
        }

        // Показываем панель оформления
        appearancePanel.classList.remove('hidden');
        settingsInfo.classList.add('has-appearance-panel');
        settingsInfo.classList.add('has-my-profile'); // Используем те же стили

        // Обновляем значения цветов в панели
        const currentTheme = loadTheme();
        const colorInputs = appearancePanel.querySelectorAll('.theme-color-input');
        colorInputs.forEach(input => {
            const colorName = input.dataset.colorName;
            if (colorName && currentTheme.colors[colorName]) {
                input.value = currentTheme.colors[colorName];
                const valueSpan = input.closest('.theme-color-input-wrapper')?.querySelector('.theme-color-value');
                if (valueSpan) {
                    valueSpan.textContent = currentTheme.colors[colorName].toUpperCase();
                }
            }
        });

        // Переинициализируем обработчики событий для цветовых пикеров
        initAppearancePanel();
    } catch (error) {
        console.error('Ошибка при открытии панели оформления:', error);
    }
}

/**
 * Закрывает панель настройки оформления
 */
export function closeAppearancePanel() {
    const appearancePanel = document.getElementById('appearanceSettingsPanel');
    const settingsInfo = document.getElementById('settingsInfo');

    if (appearancePanel && settingsInfo) {
        appearancePanel.classList.add('hidden');
        settingsInfo.classList.remove('has-appearance-panel');
        settingsInfo.classList.remove('has-my-profile'); // Remove this class too

        // Показываем стандартную панель информации
        const infoContent = settingsInfo.querySelector('.settings-info-content');
        if (infoContent) {
            infoContent.classList.remove('hidden');
        }
    }
}

// Экспортируем функции для глобального использования
if (typeof window !== 'undefined') {
    window.toggleTheme = toggleTheme;
    window.updateThemeColor = updateThemeColor;
    window.resetTheme = resetTheme;
    window.openAppearancePanel = openAppearancePanel;
    window.closeAppearancePanel = closeAppearancePanel;
}
