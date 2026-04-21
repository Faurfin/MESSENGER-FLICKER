/**
 * SETTINGS.JS - Модуль управления вкладкой настроек
 * Принцип SOLID: 
 * - Single Responsibility: Отвечает только за переключение вкладок
 * - Open/Closed: Можно расширить новыми вкладками без изменения существующего кода
 */

// Сохраняем исходный HTML списка чатов для восстановления
let originalChatListHTML = null;

/**
 * Инициализирует переключение между вкладками
 * @returns {Function} Функция switchTab для программного переключения
 */
export function initTabSwitching() {
    // Пробуем найти элементы несколько раз с задержкой
    let chatsButton = document.getElementById("chatsButton");
    let settingsButton = document.getElementById("settingsButton");
    let botsButton = document.getElementById("botsButton");
    let groupsButton = document.getElementById("groupsButton");
    let contactsButton = document.getElementById("contactsButton");
    let callsButton = document.getElementById("callsButton");
    let chatListSection = document.getElementById("chatListSection");
    let settingsSection = document.getElementById("settingsSection");
    let contactsSection = document.getElementById("contactsSection");
    let groupsSection = document.getElementById("groupsSection");
    let callsSection = document.getElementById("callsSection");
    let chatWindow = document.getElementById("chatWindow");
    let chatEmptyState = document.getElementById("chatEmptyState");
    let chatListUl = document.getElementById("chatListUl");

    if (!chatsButton || !settingsButton || !chatListSection || !settingsSection) {
        console.warn("Не все элементы для переключения вкладок найдены");
        return null;
    }

    // Сохраняем исходный HTML списка чатов при первой загрузке
    if (chatListUl && !originalChatListHTML) {
        originalChatListHTML = chatListUl.innerHTML;
    }

    /**
     * Переключает активную вкладку
     * @param {string} tabName - Имя вкладки ('chats' | 'settings' | 'bots')
     */
    function switchTab(tabName) {
        // Разрешаем закрытие окна чата на время переключения вкладок
        try { window.allowChatClose = true; } catch (e) {}
        // Убираем активное состояние со всех кнопок
        document.querySelectorAll(".nav-button").forEach(btn => {
            btn.classList.remove("active");
        });

        // Закрываем профиль при переключении вкладок
        const profileSection = document.getElementById("profileSection");
        if (profileSection && !profileSection.classList.contains("hidden")) {
            profileSection.classList.add("hidden");
            const app = document.querySelector('.app');
            if (app) {
                app.classList.remove('profile-open');
            }
        }
        const appRoot = document.querySelector('.app');

        if (tabName === "chats") {
            if (appRoot) appRoot.classList.remove('contacts-open');
            chatListSection.classList.remove("hidden");
            settingsSection.classList.add("hidden");
            if (contactsSection) contactsSection.classList.add("hidden");
            if (groupsSection) groupsSection.classList.add("hidden");
            if (callsSection) callsSection.classList.add("hidden");
            chatsButton.classList.add("active");
            updateDockSlider();

            // Восстанавливаем исходный список чатов
            if (chatListUl && originalChatListHTML) {
                chatListUl.innerHTML = originalChatListHTML;
            }

            // Сбрасываем состояние чата и показываем пустое окно
            if (chatWindow) {
                chatWindow.classList.add("hidden");
            }
            if (chatEmptyState) {
                chatEmptyState.classList.remove("hidden");
            }

            // Убираем активное выделение с чатов
            document.querySelectorAll(".chat-list-item-btn").forEach(btn => {
                btn.classList.remove("active");
            });

            // Устанавливаем флаг, чтобы при следующем клике на чат показать пустое состояние
            window.dispatchEvent(new CustomEvent("setShouldShowEmptyState"));

            // Сбрасываем activeChatId через событие
            window.dispatchEvent(new CustomEvent("resetActiveChat"));
        } else if (tabName === "bots") {
            if (appRoot) appRoot.classList.remove('contacts-open');
            chatListSection.classList.remove("hidden");
            settingsSection.classList.add("hidden");
            if (contactsSection) contactsSection.classList.add("hidden");
            if (groupsSection) groupsSection.classList.add("hidden");
            if (callsSection) callsSection.classList.add("hidden");
            if (botsButton) botsButton.classList.add("active");
            updateDockSlider();

            // Сохраняем текущий HTML перед загрузкой ботов (если еще не сохранен)
            if (chatListUl && !originalChatListHTML) {
                originalChatListHTML = chatListUl.innerHTML;
            }

            // Загружаем список ботов
            loadBotsList();

            // Сбрасываем состояние чата и показываем пустое окно
            if (chatWindow) {
                chatWindow.classList.add("hidden");
            }
            if (chatEmptyState) {
                chatEmptyState.classList.remove("hidden");
            }

            // Убираем активное выделение с чатов
            document.querySelectorAll(".chat-list-item-btn").forEach(btn => {
                btn.classList.remove("active");
            });

            // Сбрасываем activeChatId через событие
            window.dispatchEvent(new CustomEvent("resetActiveChat"));
        } else if (tabName === "settings") {
            if (appRoot) appRoot.classList.remove('contacts-open');
            chatListSection.classList.add("hidden");
            settingsSection.classList.remove("hidden");
            if (contactsSection) contactsSection.classList.add("hidden");
            if (groupsSection) groupsSection.classList.add("hidden");
            if (callsSection) callsSection.classList.add("hidden");
            chatWindow.classList.add("hidden");
            chatEmptyState.classList.add("hidden");
            settingsButton.classList.add("active");
            updateDockSlider();
        } else if (tabName === "groups") {
            if (appRoot) appRoot.classList.remove('contacts-open');
            chatListSection.classList.add("hidden");
            settingsSection.classList.add("hidden");
            if (contactsSection) contactsSection.classList.add("hidden");
            if (groupsSection) groupsSection.classList.remove("hidden");
            if (callsSection) callsSection.classList.add("hidden");
            if (chatWindow) chatWindow.classList.add("hidden");
            if (chatEmptyState) chatEmptyState.classList.add("hidden");
            if (groupsButton) groupsButton.classList.add("active");
            updateDockSlider();

            // Сбрасываем состояние чата группы
            const groupsChatWindow = document.getElementById("groupsChatWindow");
            const groupsChatEmptyState = document.getElementById("groupsChatEmptyState");
            if (groupsChatWindow) groupsChatWindow.classList.add("hidden");
            if (groupsChatEmptyState) groupsChatEmptyState.classList.remove("hidden");

            document.querySelectorAll(".chat-list-item-btn").forEach(btn => {
                btn.classList.remove("active");
            });
            document.querySelectorAll("#groupsList .chat-list-item-btn").forEach(btn => {
                btn.classList.remove("active");
            });
            window.dispatchEvent(new CustomEvent("resetActiveChat"));
            window.dispatchEvent(new CustomEvent("groupsTabOpened"));
        } else if (tabName === "contacts") {
            if (appRoot) appRoot.classList.add('contacts-open');
            chatListSection.classList.add("hidden");
            settingsSection.classList.add("hidden");
            if (contactsSection) contactsSection.classList.remove("hidden");
            if (groupsSection) groupsSection.classList.add("hidden");
            if (callsSection) callsSection.classList.add("hidden");
            if (chatWindow) chatWindow.classList.add("hidden");
            if (chatEmptyState) chatEmptyState.classList.add("hidden");
            if (contactsButton) contactsButton.classList.add("active");
            updateDockSlider();
            document.querySelectorAll(".chat-list-item-btn").forEach(btn => {
                btn.classList.remove("active");
            });
            window.dispatchEvent(new CustomEvent("resetActiveChat"));
            window.dispatchEvent(new CustomEvent("contactsTabOpened"));
        } else if (tabName === "calls") {
            if (appRoot) appRoot.classList.add('contacts-open');
            chatListSection.classList.add("hidden");
            settingsSection.classList.add("hidden");
            if (contactsSection) contactsSection.classList.add("hidden");
            if (groupsSection) groupsSection.classList.add("hidden");
            if (callsSection) callsSection.classList.remove("hidden");
            if (chatWindow) chatWindow.classList.add("hidden");
            if (chatEmptyState) chatEmptyState.classList.add("hidden");
            if (callsButton) callsButton.classList.add("active");
            updateDockSlider();
            document.querySelectorAll(".chat-list-item-btn").forEach(btn => {
                btn.classList.remove("active");
            });
            window.dispatchEvent(new CustomEvent("resetActiveChat"));
            window.dispatchEvent(new CustomEvent("callsTabOpened"));
        }
        // Снимаем разрешение на закрытие окна чата
        try { window.allowChatClose = false; } catch (e) {}
    }

    function updateDockSlider() {
        const dock = document.getElementById("navDock");
        const inner = dock ? dock.querySelector(".nav-dock__inner") : null;
        const activeBtn = document.querySelector(".nav-button.active");
        if (!dock || !inner || !activeBtn) return;
        const index = parseInt(activeBtn.getAttribute("data-dock-index"), 10);
        if (!isNaN(index)) dock.style.setProperty("--dock-active-index", index);
        const innerRect = inner.getBoundingClientRect();
        const btnRect = activeBtn.getBoundingClientRect();
        const topPx = btnRect.top - innerRect.top;
        const leftPx = btnRect.left - innerRect.left;
        dock.style.setProperty("--dock-slider-top", `${topPx}px`);
        dock.style.setProperty("--dock-slider-left", `${leftPx}px`);
        dock.style.setProperty("--dock-slider-width", `${btnRect.width}px`);
        dock.style.setProperty("--dock-slider-height", `${btnRect.height}px`);
    }

    // Обработчики кликов на кнопки навигации
    chatsButton.addEventListener("click", () => switchTab("chats"));
    settingsButton.addEventListener("click", () => switchTab("settings"));
    if (botsButton) {
        botsButton.addEventListener("click", () => switchTab("bots"));
    }
    if (groupsButton) {
        groupsButton.addEventListener("click", () => switchTab("groups"));
    }
    if (contactsButton) {
        contactsButton.addEventListener("click", () => switchTab("contacts"));
    }
    if (callsButton) {
        callsButton.addEventListener("click", () => switchTab("calls"));
    }

    // Делаем switchTab доступным глобально
    window.switchTab = switchTab;

    updateDockSlider();
    requestAnimationFrame(() => updateDockSlider());
    window.addEventListener("resize", () => updateDockSlider());
    return switchTab;
}

/**
 * Загружает и отображает список ботов
 */
async function loadBotsList(searchQuery = "") {
    const chatListUl = document.getElementById("chatListUl");
    if (!chatListUl) return;

    try {
        // Добавляем параметр поиска в URL
        const url = searchQuery
            ? `/api/bots?search_query=${encodeURIComponent(searchQuery)}`
            : "/api/bots";

        const response = await fetch(url, {
            credentials: 'include' // Используем cookies для аутентификации
        });

        if (!response.ok) {
            throw new Error("Ошибка загрузки ботов");
        }

        const data = await response.json();
        const bots = data.bots || [];

        // Очищаем список чатов
        chatListUl.innerHTML = "";

        // Добавляем ботов (без заголовка, чтобы не было дублирования)
        bots.forEach(bot => {
            const li = document.createElement("li");
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "chat-list-item-btn";
            btn.dataset.botId = bot.bot_id;
            if (bot.chat_id) {
                btn.dataset.chatId = bot.chat_id;
            }
            btn.dataset.interlocutorEmail = `bot_${bot.bot_id}@flicker.local`;
            btn.dataset.isBot = "true";
            btn.dataset.lastSeen = "bot";
            btn.dataset.isOnline = "false";

            // Определяем текст последнего сообщения
            let lastMessageText = bot.description || "";
            if (bot.last_message) {
                lastMessageText = bot.last_message;
            } else if (bot.has_chat) {
                lastMessageText = "Нет сообщений";
            }

            // Определяем время последнего сообщения
            let lastMessageTime = "";
            if (bot.last_message_timestamp) {
                const timestamp = new Date(bot.last_message_timestamp);
                if (!isNaN(timestamp.getTime())) {
                    const now = new Date();
                    const diff = now - timestamp;
                    const minutes = Math.floor(diff / 60000);
                    const hours = Math.floor(diff / 3600000);
                    const days = Math.floor(diff / 86400000);

                    if (minutes < 1) {
                        lastMessageTime = "только что";
                    } else if (minutes < 60) {
                        lastMessageTime = `${minutes} мин назад`;
                    } else if (hours < 24) {
                        lastMessageTime = `${hours} ч назад`;
                    } else if (days < 7) {
                        lastMessageTime = `${days} дн назад`;
                    } else {
                        lastMessageTime = timestamp.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
                    }
                }
            }

            // Добавляем никнейм в отображение, если есть
            const usernameDisplay = bot.username ? `<span style="color: var(--color-text-inactive); font-size: 12px;">${bot.username}</span>` : "";

            btn.innerHTML = `
                <img src="${bot.avatar}" alt="${bot.name}" class="bot-avatar" style="cursor: pointer;" />
                <div class="chat-info">
                    <div class="chat-name">${bot.name} ${usernameDisplay}</div>
                    <div class="last-message" data-chat-id="${bot.chat_id || ''}" data-original-text="${lastMessageText}">${lastMessageText}</div>
                </div>
                <span class="chat-timestamp">
                    <span class="chat-list-time">${lastMessageTime}</span>
                </span>
            `;

            // Обработчик клика на аватар - открывает профиль
            const avatarImg = btn.querySelector('img');
            if (avatarImg) {
                avatarImg.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const botEmail = `bot_${bot.bot_id}@flicker.local`;
                    if (window.openProfileModal && typeof window.openProfileModal === 'function') {
                        window.openProfileModal(botEmail);
                    } else if (typeof openProfileModal === 'function') {
                        openProfileModal(botEmail);
                    }
                });
            }

            // Обработчик клика на кнопку чата - открывает чат
            btn.addEventListener("click", async (e) => {
                // Если клик был на аватар, не открываем чат (профиль уже открыт)
                if (e.target.tagName === 'IMG' || e.target.closest('img')) {
                    return;
                }
                // Иначе открываем чат
                await startBotChat(bot.bot_id);
            });

            li.appendChild(btn);
            chatListUl.appendChild(li);
        });
    } catch (error) {
        console.error("Ошибка загрузки ботов:", error);
    }
}

/**
 * Создает или открывает чат с ботом
 */
async function startBotChat(botId) {
    try {
        const response = await fetch(`/api/bots/${botId}/start_chat`, {
            method: "POST",
            credentials: 'include', // Используем cookies для аутентификации
            headers: {
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            throw new Error("Ошибка создания чата с ботом");
        }

        const data = await response.json();
        const chatId = data.chat_id;

        // НЕ переключаемся на "Чаты" - открываем чат прямо в разделе "Боты"
        const chatWindow = document.getElementById("chatWindow");
        const chatEmptyState = document.getElementById("chatEmptyState");

        // Показываем окно чата
        if (chatWindow) {
            chatWindow.classList.remove("hidden");
        }
        if (chatEmptyState) {
            chatEmptyState.classList.add("hidden");
        }

        // Загружаем чат - loadChat установит activeChatId
        // Используем window.loadChat, который должен быть доступен после загрузки main.js
        const tryLoadChat = () => {
            if (window.loadChat && typeof window.loadChat === 'function') {
                console.log("Используем window.loadChat для загрузки чата:", chatId);
                window.loadChat(chatId);
            } else {
                console.warn("loadChat не доступен, используем fallback");
                loadChatDirectly(chatId, data.bot);
            }
        };

        // Пробуем сразу, если не получилось - ждем немного
        tryLoadChat();
        if (!window.loadChat || typeof window.loadChat !== 'function') {
            setTimeout(tryLoadChat, 300);
        }

        // НЕ добавляем чат в список здесь - он уже будет в списке "Чаты" из базы данных
        // При переключении на "Чаты" список восстановится из originalChatListHTML
    } catch (error) {
        console.error("Ошибка создания чата с ботом:", error);
        alert("Не удалось создать чат с ботом");
    }
}

/**
 * Прямая загрузка чата (fallback если loadChat недоступен)
 */
async function loadChatDirectly(chatId, bot) {
    const chatWindow = document.getElementById("chatWindow");
    const chatEmptyState = document.getElementById("chatEmptyState");
    const chatMessages = document.getElementById("chatMessages");
    const currentChatTitle = document.getElementById("currentChatTitle");
    const currentChatAvatar = document.getElementById("currentChatAvatar");
    const currentChatStatus = document.getElementById("currentChatStatus");
    const messageInput = document.getElementById("messageInput");

    if (!chatWindow || !chatMessages) {
        console.error("Элементы чата не найдены");
        return;
    }

    // Показываем окно чата
    if (chatWindow) chatWindow.classList.remove("hidden");
    if (chatEmptyState) chatEmptyState.classList.add("hidden");

    // Устанавливаем activeChatId глобально
    window.activeChatId = chatId;
    console.log("activeChatId установлен в loadChatDirectly:", chatId);

    // Устанавливаем заголовок и аватар
    if (currentChatTitle && bot) {
        currentChatTitle.textContent = bot.name;
    }
    if (currentChatAvatar && bot) {
        currentChatAvatar.src = bot.avatar;
    }
    if (currentChatStatus) {
        currentChatStatus.textContent = "бот";
        currentChatStatus.dataset.originalText = "бот";
    }

    // Загружаем сообщения
    try {
        const response = await fetch(`/api/chat/${chatId}`, {
            credentials: 'include'
        });
        if (response.ok) {
            const chatData = await response.json();
            chatMessages.innerHTML = "";

            // Рендерим сообщения (упрощенная версия)
            if (chatData.messages && Array.isArray(chatData.messages)) {
                chatData.messages.forEach(msg => {
                    if (window.renderMessage && typeof window.renderMessage === 'function') {
                        window.renderMessage(msg, false);
                    } else {
                        // Простой рендеринг сообщения
                        const msgDiv = document.createElement("div");
                        const isMine = msg.sender_id === window.CURRENT_USER_EMAIL;
                        msgDiv.className = `message-row ${isMine ? 'outgoing' : 'incoming'}`;
                        const bubble = document.createElement("div");
                        bubble.className = `message ${isMine ? 'outgoing' : 'incoming'}`;
                        bubble.dataset.messageId = msg._id;
                        bubble.innerHTML = `
                            <div class="message-content">${(msg.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                            <div class="message-meta">
                                <span class="message-time">${new Date(msg.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                        `;
                        msgDiv.appendChild(bubble);
                        chatMessages.appendChild(msgDiv);
                    }
                });
            }

            // Прокручиваем вниз
            chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: "auto" });
        }
    } catch (error) {
        console.error("Ошибка загрузки чата:", error);
    }
}

// Экспортируем функции для использования в main.js
window.loadBotsList = loadBotsList;
window.startBotChat = startBotChat;
window.loadChatDirectly = loadChatDirectly;

/**
 * Инициализирует навигацию внутри настроек (особенно для мобильных)
 */
export function initSettingsNavigation() {
    const settingsContainer = document.querySelector('.settings-container');
    const settingsList = [
        { item: 'myProfileSettingsItem', panel: 'myProfileSettingsPanel', closeBtn: 'myProfileSettingsCloseBtn' },
        { item: 'privacySettingsItem', panel: 'privacySettingsPanel', closeBtn: 'privacySettingsCloseBtn' },
        { item: 'appearanceSettingsItem', panel: 'appearanceSettingsPanel', closeBtn: 'appearanceCloseBtn' },
        { item: 'notificationsSettingsItem', panel: 'notificationsSettingsPanel', closeBtn: 'notificationsSettingsCloseBtn' },
        { item: 'languageSettingsItem', panel: 'languageSettingsPanel', closeBtn: 'languageSettingsCloseBtn' },
        { item: 'helpSettingsItem', panel: 'helpSettingsPanel', closeBtn: 'helpSettingsCloseBtn' },
        // New Logout Panel
        { item: 'logoutSettingsItem', panel: 'logoutSettingsPanel', closeBtn: 'logoutSettingsCloseBtn' }
    ];

    settingsList.forEach(conf => {
        const itemBtn = document.getElementById(conf.item);
        const panelEl = document.getElementById(conf.panel);
        const closeBtn = document.getElementById(conf.closeBtn);

        if (itemBtn && panelEl) {
            itemBtn.addEventListener('click', () => {
                openSettingsPanel(panelEl);
            });
        }

        if (closeBtn && panelEl) {
            // Удаляем старые обработчики если были (клонирование не используем, просто добавляем свой)
            // Но лучше добавить атрибут, чтобы не дублировать
            if (!closeBtn.dataset.hasMobileNavListener) {
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // Чтобы не всплывало

                    // Special handling for appearance panel
                    if (conf.panel === 'appearanceSettingsPanel') {
                        if (typeof window.closeAppearancePanel === 'function') {
                            window.closeAppearancePanel();
                        } else {
                            closeSettingsPanel(panelEl);
                        }
                    } else {
                        closeSettingsPanel(panelEl);
                    }
                });
                closeBtn.dataset.hasMobileNavListener = "true";
            }
        }
    });

    // Logout Logic
    const logoutConfirmBtn = document.getElementById('logoutConfirmBtn');
    const logoutCancelBtn = document.getElementById('logoutCancelBtn');
    const logoutPanel = document.getElementById('logoutSettingsPanel');

    if (logoutConfirmBtn) {
        logoutConfirmBtn.addEventListener('click', () => {
            // Try to find default logout first
            window.location.href = '/logout';
        });
    }

    if (logoutCancelBtn && logoutPanel) {
        logoutCancelBtn.addEventListener('click', () => {
            closeSettingsPanel(logoutPanel);
        });
    }

    // Обработка кнопки "Назад" (физической или браузерной) на мобильных
    // Можно добавить history.pushState если хотим поддерживать аппаратную кнопку назад
}


/**
 * Открывает панель настроек
 */
function openSettingsPanel(panel) {
    const settingsContainer = document.querySelector('.settings-container');
    const settingsInfo = document.querySelector('.settings-info'); // Desktop setup
    const settingsInfoContent = document.querySelector('.settings-info-content');

    // Скрываем все другие панели сначала
    document.querySelectorAll('.my-profile-panel').forEach(p => {
        if (p !== panel) p.classList.add('hidden');
    });

    panel.classList.remove('hidden');

    // Логика для мобильных устройств (ширина < 900px, как в CSS)
    if (window.innerWidth <= 900) {
        if (settingsContainer) settingsContainer.classList.add('hidden');
        // Убеждаемся, что панель наверху
        panel.scrollTop = 0;
    } else {
        // Desktop: скрываем только информационный контент, но не саму панель settingsInfo
        if (settingsInfoContent) settingsInfoContent.classList.add('hidden');
        // Добавляем класс, чтобы показать, что панель активна
        if (settingsInfo) settingsInfo.classList.add('has-my-profile');
    }
}

/**
 * Закрывает панель настроек
 */
function closeSettingsPanel(panel) {
    const settingsContainer = document.querySelector('.settings-container');
    const settingsInfo = document.querySelector('.settings-info');
    const settingsInfoContent = document.querySelector('.settings-info-content');

    panel.classList.add('hidden');

    // Логика для мобильных
    if (window.innerWidth <= 900) {
        if (settingsContainer) settingsContainer.classList.remove('hidden');
    } else {
        // Desktop: показываем инфо-плейсхолдер обратно
        if (settingsInfo) settingsInfo.classList.remove('hidden');

        // Или если мы хотим, чтобы на десктопе панель закрывалась совсем
    }
}

// Делаем доступным
window.initSettingsNavigation = initSettingsNavigation;
