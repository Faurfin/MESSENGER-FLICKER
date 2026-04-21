// ===========================
// === Flicker Chats RealTime ===
// ===========================

import {
  initTabSwitching,
  initSettingsNavigation,
} from "./modules/settings.js";
import {
  initTheme,
  openAppearancePanel,
  closeAppearancePanel,
} from "./modules/theme.js";
import { generateAvatar, getAvatarDisplayName } from "./modules/avatar.js";
import CallManager from "./modules/calls.js";

const API_BASE_URL = window.location.origin;
const WS_PROTOCOL = location.protocol === "https:" ? "wss" : "ws";

const emojiPattern = /\[emoji:(.*?)\]/g;

function renderTextWithEmojis(container, textContent, isSidebar = false) {
  if (!textContent) return;
  const parts = textContent.split(emojiPattern);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 1) {
      // Если это боковая панель (список чатов), не грузим анимации вообще
      if (isSidebar) {
        const span = document.createElement("span");
        span.textContent = " [Стикер] ";
        span.style.color = "var(--color-primary)";
        span.style.fontSize = "0.9em";
        container.appendChild(span);
        continue;
      }

      // Для чата и поля ввода создаем стикер с Canvas-хаком (анимация по наведению)
      const wrapper = document.createElement("span");
      wrapper.className = "hover-emoji-wrapper";
      wrapper.style.display = "inline-block";
      wrapper.style.position = "relative";
      wrapper.style.width = "28px";
      wrapper.style.height = "28px";
      wrapper.style.verticalAlign = "middle";
      wrapper.style.margin = "0 2px";

      const img = document.createElement("img");
      img.src = part;
      img.alt = `[emoji:${part}]`;
      img.dataset.emoji = part;
      img.className = "emoji-inline";
      img.setAttribute("loading", "lazy"); // РЕШАЕТ ПРОБЛЕМУ ДОЛГОЙ ЗАГРУЗКИ!
      img.setAttribute("decoding", "async");
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.position = "absolute";
      img.style.top = "0";
      img.style.left = "0";
      img.style.opacity = "0"; // Скрыто по умолчанию
      img.style.transition = "opacity 0.2s ease";
      img.style.objectFit = "contain";

      const canvas = document.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.position = "absolute";
      canvas.style.top = "0";
      canvas.style.left = "0";

      // Рисуем первый кадр на Canvas, когда WebP загрузится
      img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
      };

      wrapper.appendChild(canvas);
      wrapper.appendChild(img);

      // Анимация при наведении
      wrapper.addEventListener("mouseenter", () => img.style.opacity = "1");
      wrapper.addEventListener("mouseleave", () => img.style.opacity = "0");

      container.appendChild(wrapper);
    } else if (part) {
      container.appendChild(document.createTextNode(part));
    }
  }
}

function syncMessageInputVisual() {
  // No-op for contenteditable
  return;
}

const chatListUl = document.getElementById("chatListUl");
// Список результатов поиска пользователей (мгновенный поиск)
const userSearchResultsUl = document.getElementById("userSearchResultsUl");
const chatEmptyState = document.getElementById("chatEmptyState");
const chatWindow = document.getElementById("chatWindow");
const chatMessages = document.getElementById("chatMessages");
const noMessagesState = document.getElementById("noMessagesState");
const chatSkeleton = document.getElementById("chatSkeleton");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");

// === PATCH FOR CONTENTEDITABLE ===
if (messageInput) {
  Object.defineProperty(messageInput, "value", {
    get: function () {
      let text = "";
      const traverse = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === "IMG" && node.dataset.emoji) {
            text += `[emoji:${node.dataset.emoji}]`;
          } else if (node.tagName === "BR") {
            // text += "\n"; 
          } else {
            node.childNodes.forEach(traverse);
          }
        }
      };
      this.childNodes.forEach(traverse);
      return text;
    },
    set: function (val) {
      this.innerHTML = "";
      if (val) renderTextWithEmojis(this, val);
    },
    configurable: true,
  });

  Object.defineProperty(messageInput, "placeholder", {
    get: function () {
      return this.getAttribute("placeholder") || "";
    },
    set: function (val) {
      this.setAttribute("placeholder", val);
    },
    configurable: true,
  });

  messageInput.setSelectionRange = function (start, end) {
    // Basic fallback: move cursor to end
    const range = document.createRange();
    range.selectNodeContents(this);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
}
// === END PATCH ===

const messageInputVisual = document.getElementById("messageInputVisual");
const sendButton = document.getElementById("sendButton");
const currentChatTitle = document.getElementById("currentChatTitle");
const currentChatAvatar = document.getElementById("currentChatAvatar");
const chatListAside = document.querySelector(".chat-list");
const backToChatListBtn = document.getElementById("backToChatListBtn");
const chatSearchBtn = document.getElementById("chatSearchBtn");
// === НОВЫЙ КОД ДЛЯ ПОИСКА ===
const searchInput = document.getElementById("searchInput");
const searchClearBtn = document.getElementById("searchClearBtn");
const chatListContainer = document.getElementById("chatListContainer");
const messageSearchResults = document.getElementById("messageSearchResults");
const messageSearchResultsList = document.getElementById(
  "messageSearchResultsList"
);
const messageSearchResultsEmpty = document.getElementById(
  "messageSearchResultsEmpty"
);
const chatListScroll = document.querySelector(".chat-list-scroll");
const bodyElement = document.body;
const currentUserDisplayName =
  (bodyElement && bodyElement.dataset.userName) || "Вы";
const currentUserAvatarUrl =
  (bodyElement && bodyElement.dataset.userAvatar) || generateAvatar(currentUserDisplayName, bodyElement.dataset.userId);
// Слаг чата, который сервер передал из URL (/@username)
const initialChatSlug =
  (bodyElement && bodyElement.dataset.initialChatSlug) || "";

// Prefers-reduced-motion: класс на body для отключения анимаций в CSS (доступность)
try {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (mq.matches && bodyElement) bodyElement.classList.add("reduce-motion");
  mq.addEventListener("change", (e) => {
    if (bodyElement) bodyElement.classList.toggle("reduce-motion", e.matches);
  });
} catch (e) {}

// === ОБНОВЛЕНО: Добавлен элемент статуса в хедере ===
const currentChatStatus = document.getElementById("currentChatStatus");
const chatUnblockContainer = document.getElementById("chat-unblock-container");
const unblockUserBtn = document.getElementById("unblockUserBtn");
const blockUserBtn = document.getElementById("blockUserBtn");

// Сохраняем изначальный placeholder поля ввода, чтобы можно было вернуть
if (messageInput && !messageInput.dataset.originalPlaceholder) {
  messageInput.dataset.originalPlaceholder = messageInput.placeholder || "";
}

const attachmentIcon = document.getElementById("attachmentIcon");
const attachmentMenu = document.getElementById("attachmentMenu");
const messageContextMenu = document.getElementById("messageContextMenu");
const contextMenuOverlay = document.getElementById("contextMenuOverlay");
const replyPreview = document.getElementById("replyPreview");
const replyPreviewInfo = document.getElementById("replyPreviewInfo");
const replyPreviewClose = document.getElementById("replyPreviewClose");
const chatSearchWrapper = document.getElementById("chatSearchWrapper");
const chatSearchBar = document.getElementById("chatSearchBar");
const chatSearchInnerIcon = document.getElementById("chatSearchInnerIcon");
const chatSearchInput = document.getElementById("chatSearchInput");
const chatSearchCount = document.getElementById("chatSearchCount");
const chatSearchEmptyLabel = document.getElementById("chatSearchEmptyLabel");
const chatSearchClearBtn = document.getElementById("chatSearchClearBtn");
const chatSearchIcon = document.getElementById("chatSearchIcon");
const chatSearchClearIcon = document.getElementById("chatSearchClearIcon");
const chatSearchPrevBtn = document.getElementById("chatSearchPrevBtn");
const chatSearchNextBtn = document.getElementById("chatSearchNextBtn");
const deleteConfirmOverlay = document.getElementById("deleteConfirmOverlay");
const deleteForAllOption = document.getElementById("deleteForAllOption");
const deleteForSelfOption = document.getElementById("deleteForSelfOption");
const clearChatConfirmOverlay = document.getElementById(
  "clearChatConfirmOverlay"
);
const clearForAllOption = document.getElementById("clearForAllOption");
const clearForSelfOption = document.getElementById("clearForSelfOption");

const forwardModal = document.getElementById("forwardModal");
const forwardForm = document.getElementById("forwardForm");
const forwardCloseBtn = document.getElementById("forwardCloseBtn");
const forwardCancelBtn = document.getElementById("forwardCancelBtn");
const forwardSendBtn = document.getElementById("forwardSendBtn");
const forwardSearchInput = document.getElementById("forwardSearchInput");
const forwardRecipientsList = document.getElementById("forwardRecipientsList");
const forwardSelectedRecipients = document.getElementById(
  "forwardSelectedRecipients"
);
const forwardError = document.getElementById("forwardError");

// Кэш для аудио сообщений (URL -> BlobURL)
const audioCache = new Map();
const deleteChatConfirmOverlay = document.getElementById(
  "deleteChatConfirmOverlay"
);
const deleteChatForAllOption = document.getElementById(
  "deleteChatForAllOption"
);
const deleteChatForSelfOption = document.getElementById(
  "deleteChatForSelfOption"
);

// === Элементы модального окна профиля ===
const profileSection = document.getElementById("profileSection");
const profileBackBtn = document.getElementById("profileBackBtn");
const profileHeaderBackground = document.getElementById(
  "profileHeaderBackground"
);
const profileHeaderBgImg = document.getElementById("profileHeaderBgImg");
const profileName = document.getElementById("profileName");
const profileUsername = document.getElementById("profileUsername");
const profileEmail = document.getElementById("profileEmail");
const profileQuote = document.getElementById("profileQuote");
const profileCallBtn = document.getElementById("profileCallBtn");
const profileVideoCallBtn = document.getElementById("profileVideoCallBtn");
const profileMessageBtn = document.getElementById("profileMessageBtn");
const profileGiftBtn = document.getElementById("profileGiftBtn");
const profileMenuBtn = document.getElementById("profileMenuBtn");
const profileContentArea = document.getElementById("profileContentArea");
const profileMediaTabs = document.querySelectorAll(".profile-media-tab");
const avatarContainer = document.getElementById("avatar-container");
// === Редактирование своего профиля ===
const myProfileSettingsItem = document.getElementById("myProfileSettingsItem");
const settingsInfo = document.getElementById("settingsInfo");
const settingsInfoContent = document.getElementById("settingsInfoContent");
const myProfileSettingsPanel = document.getElementById(
  "myProfileSettingsPanel"
);
const myProfileSettingsCloseBtn = document.getElementById(
  "myProfileSettingsCloseBtn"
);
// === Настройки конфиденциальности ===
const privacySettingsPanel = document.getElementById("privacySettingsPanel");
const privacySettingsCloseBtn = document.getElementById(
  "privacySettingsCloseBtn"
);
const privacySettingsForm = document.getElementById("privacySettingsForm");
const privacyLastSeenSelect = document.getElementById("privacyLastSeenSelect");
const privacyProfilePhotoSelect = document.getElementById(
  "privacyProfilePhotoSelect"
);
const privacyCurrentPassword = document.getElementById(
  "privacyCurrentPassword"
);
const privacyNewPassword = document.getElementById("privacyNewPassword");
const privacyChangePasswordBtn = document.getElementById(
  "privacyChangePasswordBtn"
);
const privacyEmailInput = document.getElementById("privacyEmailInput");
const privacyUpdateEmailBtn = document.getElementById("privacyUpdateEmailBtn");
const privacyBlockEmailInput = document.getElementById(
  "privacyBlockEmailInput"
);
const privacyBlockUserBtn = document.getElementById("privacyBlockUserBtn");
const privacyBlockedUsersList = document.getElementById(
  "privacyBlockedUsersList"
);
const privacySaveBtn = document.getElementById("privacySaveBtn");
const privacyStatus = document.getElementById("privacyStatus");
const myProfileAvatarImg = document.getElementById("myProfileAvatarImg");
const myProfileAvatarBtn = document.getElementById("myProfileAvatarBtn");
const myProfileAvatarInput = document.getElementById("myProfileAvatarInput");
const myProfileDisplayName = document.getElementById("myProfileDisplayName");
const myProfileEmailText = document.getElementById("myProfileEmailText");
const myProfileUsernameChip = document.getElementById("myProfileUsernameChip");
const myProfileForm = document.getElementById("myProfileForm");
const myProfileNameInput = document.getElementById("myProfileNameInput");
const myProfileUsernameInput = document.getElementById(
  "myProfileUsernameInput"
);
const myProfileEmailInput = document.getElementById("myProfileEmailInput");
const myProfileAboutInput = document.getElementById("myProfileAboutInput");
const myProfileStatus = document.getElementById("myProfileStatus");
const myProfileSaveBtn = document.getElementById("myProfileSaveBtn");
const profileEditSection = document.getElementById("profileEditSection");
const profileEditForm = document.getElementById("profileEditForm");
const profileEditNameInput = document.getElementById("profileEditNameInput");
const profileEditUsernameInput = document.getElementById(
  "profileEditUsernameInput"
);
const profileEditEmailInput = document.getElementById("profileEditEmailInput");
const profileEditAboutInput = document.getElementById("profileEditAboutInput");
const profileEditStatus = document.getElementById("profileEditStatus");
const profileEditSaveBtn = document.getElementById("profileEditSaveBtn");
const profileAvatarEditBtn = document.getElementById("profileAvatarEditBtn");
const profileAvatarInput = document.getElementById("profileAvatarInput");

/** Текущая сохранённая аватарка (с сервера). Для отката превью при закрытии без сохранения. */
let _myProfileSavedAvatarUrl = "";
/** Object URL превью выбранного файла. Нужно отзывать при смене/закрытии/успешном сохранении. */
let _myProfilePreviewObjectUrl = null;

// === Эти переменные передаются из chats.html ===
let currentUserEmail = window.CURRENT_USER_EMAIL;
const currentUserId = window.CURRENT_USER_ID;

let activeChatId = null;
let currentChatIsGroup = false; // Флаг, что текущий чат является групповым
let isChatOpenedFromUrl = false; // Флаг, что чат открыт по URL и не должен закрываться
let currentChatParticipants = []; // Участники текущего чата для упоминаний
let mentionsList = null; // Элемент списка упоминаний
let mentionsListContent = null; // Контент списка упоминаний
let currentMentionStart = -1; // Позиция начала упоминания (@)
let selectedMentionIndex = -1; // Индекс выбранного участника в списке
let isUserAtBottom = true; // Флаг, находится ли пользователь внизу чата
let newMessagesCount = 0; // Счетчик новых сообщений, когда пользователь не внизу
let scrollToBottomBtn = null; // Кнопка прокрутки вниз
let newMessagesCountEl = null; // Элемент счетчика новых сообщений
let currentProfileEmail = null; // Email открытого профиля (в панели справа)

let forwardSelected = new Set();
let forwardSource = null;
let allForwardContacts = [];
let forwardSearchTimer = null;

if (chatMessages) {
  chatMessages.addEventListener(
    "scroll",
    debounce(() => {
      if (activeChatId) {
        rememberScrollPosition(activeChatId);
      }
    }, 120)
  );
}

// Защита от закрытия чата: перехватываем все попытки закрыть чат, если он открыт по URL
let isProtectionActive = false;
let protectionInterval = null;
let protectionObserver = null;

// Храним позиции скролла, чтобы возвращать пользователя на то же место
const chatScrollPositions = new Map();

function rememberScrollPosition(chatId) {
  if (!chatId || !chatMessages) return;
  chatScrollPositions.set(chatId, chatMessages.scrollTop);
}

function restoreScrollPosition(chatId) {
  if (!chatId || !chatMessages) return;
  const y = chatScrollPositions.get(chatId);
  if (typeof y === "number") {
    requestAnimationFrame(() => {
      chatMessages.scrollTop = y;
    });
  }
}

// Предзагрузка чата (кэш с защитой от повторов)
function prefetchChat(chatId) {
  if (!chatId) return Promise.resolve(null);
  const cached = chatCacheMem.get(chatId);
  if (cached && Date.now() - cached.ts < CHAT_CACHE_TTL)
    return Promise.resolve(cached.data);
  if (inflightChatFetches.has(chatId)) return inflightChatFetches.get(chatId);

  const p = fetch(`${API_BASE_URL}/api/chat/${chatId}`, {
    credentials: "include",
  })
    .then((resp) => {
      if (!resp.ok) {
        console.error(
          `[prefetchChat] Ошибка загрузки чата ${chatId}:`,
          resp.status,
          resp.statusText
        );
        throw new Error(`Failed prefetch: ${resp.status} ${resp.statusText}`);
      }
      return resp.json();
    })
    .then((data) => {
      console.log(`[prefetchChat] Данные чата ${chatId} получены:`, data);
      console.log(
        `[prefetchChat] Количество сообщений:`,
        (data.messages || []).length
      );
      return data;
    })
    .then((data) => {
      writeCachedChat(chatId, data);
      return data;
    })
    .catch((err) => {
      console.warn("prefetchChat error", err);
      return null;
    })
    .finally(() => inflightChatFetches.delete(chatId));

  inflightChatFetches.set(chatId, p);
  return p;
}

// ===========================
// === Утилиты ===
// ===========================
function debounce(fn, delay) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ===========================
// === Кэш чатов (IndexedDB + память) ===
// ===========================
const CHAT_CACHE_TTL = 60_000; // 60 секунд
const CHAT_CACHE_LIMIT = 8; // максимум записей в памяти
const chatCacheMem = new Map(); // chatId -> {ts, data}
const inflightChatFetches = new Map(); // chatId -> Promise
let chatCacheDbPromise = null;

function openChatCacheDb() {
  if (!("indexedDB" in window)) return null;
  if (chatCacheDbPromise) return chatCacheDbPromise;
  chatCacheDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open("flickerChatCache", 1);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chats")) {
        db.createObjectStore("chats");
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return chatCacheDbPromise;
}

async function readCachedChat(chatId) {
  if (!chatId) return null;
  const hit = chatCacheMem.get(chatId);
  if (hit && Date.now() - hit.ts < CHAT_CACHE_TTL) return hit.data;

  try {
    const db = await openChatCacheDb();
    if (db) {
      const tx = db.transaction("chats", "readonly");
      const store = tx.objectStore("chats");
      const value = await new Promise((res, rej) => {
        const r = store.get(chatId);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      });
      if (value && value.ts && Date.now() - value.ts < CHAT_CACHE_TTL) {
        chatCacheMem.set(chatId, { ts: value.ts, data: value.data });
        return value.data;
      }
    } else {
      const raw = localStorage.getItem(`chat_cache_${chatId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.ts && Date.now() - parsed.ts < CHAT_CACHE_TTL) {
          chatCacheMem.set(chatId, { ts: parsed.ts, data: parsed.data });
          return parsed.data;
        }
      }
    }
  } catch (e) {
    console.warn("readCachedChat error", e);
  }
  return null;
}

async function writeCachedChat(chatId, data) {
  if (!chatId || !data) return;
  const ts = Date.now();
  chatCacheMem.set(chatId, { ts, data });
  // LRU eviction
  if (chatCacheMem.size > CHAT_CACHE_LIMIT) {
    const oldest = [...chatCacheMem.entries()].sort(
      (a, b) => a[1].ts - b[1].ts
    )[0];
    if (oldest) chatCacheMem.delete(oldest[0]);
  }
  try {
    const db = await openChatCacheDb();
    if (db) {
      const tx = db.transaction("chats", "readwrite");
      tx.objectStore("chats").put({ ts, data }, chatId);
    } else {
      localStorage.setItem(
        `chat_cache_${chatId}`,
        JSON.stringify({ ts, data })
      );
    }
  } catch (e) {
    console.warn("writeCachedChat error", e);
  }
}

function showChatSkeleton() {
  if (chatSkeleton) chatSkeleton.classList.remove("hidden");
  if (chatMessages) chatMessages.classList.add("hidden");
  if (chatWindow) {
    chatWindow.classList.add("fade-start");
    requestAnimationFrame(() => chatWindow.classList.add("fade-in"));
  }
}

function hideChatSkeleton() {
  if (chatSkeleton) chatSkeleton.classList.add("hidden");
  if (chatMessages) chatMessages.classList.remove("hidden");
  if (chatWindow) {
    chatWindow.classList.remove("fade-start");
    chatWindow.classList.add("fade-in");
  }
}

function protectChatFromClosing() {
  if (!isChatOpenedFromUrl || !activeChatId || !chatWindow) return;
  if (isProtectionActive) return; // Защита уже активна

  isProtectionActive = true;
  console.log(
    "[Telegram Logic] Активирована ПОЛНАЯ защита от закрытия чата. activeChatId:",
    activeChatId
  );

// Функция для принудительного открытия чата
  const isChatCloseAllowed = () => {
    // === ИСПРАВЛЕНИЕ: Разрешаем скрыть чат, если мы ушли с вкладки "Чаты" ===
    const chatsBtn = document.getElementById("chatsButton");
    if (chatsBtn && !chatsBtn.classList.contains("active")) {
      return true; // Вкладка "Чаты" не активна — смело прячем окно!
    }
    try { return window.allowChatClose === true; } catch { return false; }
  };

  const forceOpenChat = () => {
    if (isChatCloseAllowed()) return;
    if (isChatOpenedFromUrl && activeChatId && chatWindow) {
      chatWindow.classList.remove("hidden");
      chatWindow.style.display = "";
      chatWindow.style.visibility = "visible";
      chatWindow.style.opacity = "1";
      chatWindow.style.height = "";
      chatWindow.style.width = "";
    }
    if (isChatOpenedFromUrl && activeChatId && chatEmptyState) {
      chatEmptyState.classList.add("hidden");
      chatEmptyState.style.display = "none";
      chatEmptyState.style.visibility = "hidden";
      chatEmptyState.style.opacity = "0";
    }
  };

  // Перехватываем изменения класса hidden у chatWindow
  const originalAdd = chatWindow.classList.add.bind(chatWindow.classList);
  chatWindow.classList.add = function (...args) {
    if (args.includes("hidden") && isChatOpenedFromUrl && activeChatId && !isChatCloseAllowed()) {
      console.warn(
        "[Telegram Logic] БЛОКИРОВАНО: попытка закрыть чат через classList.add('hidden')"
      );
      forceOpenChat();
      return; // Блокируем добавление класса hidden
    }
    return originalAdd(...args);
  };

  // Перехватываем toggle
  const originalToggle = chatWindow.classList.toggle.bind(chatWindow.classList);
  chatWindow.classList.toggle = function (...args) {
    if (args.includes("hidden") && isChatOpenedFromUrl && activeChatId && !isChatCloseAllowed()) {
      console.warn(
        "[Telegram Logic] БЛОКИРОВАНО: попытка закрыть чат через classList.toggle('hidden')"
      );
      forceOpenChat();
      return false; // Возвращаем false (класс не добавлен)
    }
    return originalToggle(...args);
  };

  // Перехватываем изменения style.display
  const originalStyleDisplay = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "style"
  )?.get;
  if (chatWindow.style) {
    const styleDescriptor = Object.getOwnPropertyDescriptor(
      chatWindow.style,
      "display"
    );
    if (styleDescriptor && styleDescriptor.set) {
      const originalSet = styleDescriptor.set;
      Object.defineProperty(chatWindow.style, "display", {
        set: function (value) {
          if (
            (value === "none" || value === "") &&
            isChatOpenedFromUrl &&
            activeChatId &&
            !isChatCloseAllowed()
          ) {
            console.warn(
              "[Telegram Logic] БЛОКИРОВАНО: попытка закрыть чат через style.display"
            );
            forceOpenChat();
            return; // Блокируем установку display: none
          }
          originalSet.call(this, value);
        },
        get: styleDescriptor.get,
        configurable: true,
      });
    }
  }

  // Перехватываем изменения класса hidden у chatEmptyState
  if (chatEmptyState) {
    const originalRemove = chatEmptyState.classList.remove.bind(
      chatEmptyState.classList
    );
    chatEmptyState.classList.remove = function (...args) {
      if (args.includes("hidden") && isChatOpenedFromUrl && activeChatId && !isChatCloseAllowed()) {
        console.warn(
          "[Telegram Logic] БЛОКИРОВАНО: попытка показать пустое состояние"
        );
        forceOpenChat();
        return; // Блокируем удаление класса hidden
      }
      return originalRemove(...args);
    };

    const originalToggleEmpty = chatEmptyState.classList.toggle.bind(
      chatEmptyState.classList
    );
    chatEmptyState.classList.toggle = function (...args) {
      if (args.includes("hidden") && isChatOpenedFromUrl && activeChatId && !isChatCloseAllowed()) {
        console.warn(
          "[Telegram Logic] БЛОКИРОВАНО: попытка показать пустое состояние через toggle"
        );
        forceOpenChat();
        return true; // Возвращаем true (класс остается)
      }
      return originalToggleEmpty(...args);
    };
  }

  // Используем MutationObserver для отслеживания изменений в DOM
  if (typeof MutationObserver !== "undefined") {
    protectionObserver = new MutationObserver((mutations) => {
      if (!isChatOpenedFromUrl || !activeChatId) return;

      mutations.forEach((mutation) => {
        if (mutation.type === "attributes" && mutation.target === chatWindow) {
          if (
            mutation.attributeName === "class" &&
            chatWindow.classList.contains("hidden") &&
            !isChatCloseAllowed()
          ) {
            console.warn(
              "[Telegram Logic] БЛОКИРОВАНО: обнаружено изменение класса через DOM"
            );
            forceOpenChat();
          }
          if (mutation.attributeName === "style") {
            const display = chatWindow.style.display;
            if (
              (display === "none" ||
              (display === "" && chatWindow.classList.contains("hidden"))) &&
              !isChatCloseAllowed()
            ) {
              console.warn(
                "[Telegram Logic] БЛОКИРОВАНО: обнаружено изменение style через DOM"
              );
              forceOpenChat();
            }
          }
        }
      });
    });

    protectionObserver.observe(chatWindow, {
      attributes: true,
      attributeFilter: ["class", "style"],
      childList: false,
      subtree: false,
    });
  }

  // Постоянная проверка каждые 50мс (бесконечно, пока чат открыт по URL)
  protectionInterval = setInterval(() => {
    if (!isChatOpenedFromUrl || !activeChatId) {
      clearInterval(protectionInterval);
      protectionInterval = null;
      if (protectionObserver) {
        protectionObserver.disconnect();
        protectionObserver = null;
      }
      isProtectionActive = false;
      return;
    }

    // Проверяем и принудительно открываем чат, если он закрыт
    if (
      !isChatCloseAllowed() &&
      (chatWindow.classList.contains("hidden") ||
      chatWindow.style.display === "none" ||
      chatWindow.style.visibility === "hidden")
    ) {
      console.warn(
        "[Telegram Logic] Обнаружен закрытый чат, принудительно открываем. activeChatId:",
        activeChatId
      );
      forceOpenChat();
    }

    // Проверяем и скрываем пустое состояние, если оно показано
    if (!isChatCloseAllowed() && chatEmptyState && !chatEmptyState.classList.contains("hidden")) {
      console.warn(
        "[Telegram Logic] Обнаружено пустое состояние, скрываем его. activeChatId:",
        activeChatId
      );
      forceOpenChat();
    }
  }, 50); // Проверяем каждые 50мс
}
// Делаем activeChatId доступным глобально для других модулей
Object.defineProperty(window, "activeChatId", {
  get: () => activeChatId,
  set: (value) => {
    activeChatId = value;
    console.log("activeChatId установлен:", value);
  },
  configurable: true,
  enumerable: true,
});

let ws = null; // Это будет НАШЕ ЕДИНОЕ соединение
let callManager = null; // Менеджер звонков
const renderedMessageIds = new Set();
let shouldShowEmptyState = false; // Флаг для показа пустого состояния после переключения из настроек

// Глобальные переменные для анализа аудио в аудио-чатах
let audioChatAnalyserContext = null;
const audioChatAnalysers = new Map(); // email -> analyser

// === Состояние для ответа и редактирования ===
let replyingToMessage = null;
let editingMessageId = null;

// === Переменные и состояние для записи аудио ===
const micIcon = document.getElementById("micIcon");
const voiceRecordingButton = document.getElementById("voiceRecordingButton");
const voiceTimerEl = document.getElementById("voiceTimer");
const chatInputForm = document.querySelector(".chat-input-form");
let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let recordingStartTs = 0;
let recordingTimerId = null;
let isCancelling = false;
let startPointerX = 0;
let audioContext = null;
let analyser = null;
let sourceNode = null;
let rafWave = null;

// Глобальное управление воспроизведением аудио
let currentPlayingAudio = {
  element: null,
  audioBar: null,
  messageId: null,
};

// ===========================
// === Хелперы (ОБНОВЛЕНЫ) ===
// ===========================

// === Функции для работы с черновиками ===
function saveDraft(chatId, text) {
  if (!chatId) return;
  const key = `draft_${chatId}`;
  if (text && text.trim()) {
    localStorage.setItem(key, text.trim());
  } else {
    localStorage.removeItem(key);
  }
  updateChatListDraft(chatId, text && text.trim() ? text.trim() : null);
}

function loadDraft(chatId) {
  if (!chatId) return "";
  const key = `draft_${chatId}`;
  return localStorage.getItem(key) || "";
}

function clearDraft(chatId) {
  if (!chatId) return;
  const key = `draft_${chatId}`;
  localStorage.removeItem(key);
  updateChatListDraft(chatId, null);
}

function updateChatListDraft(chatId, draftText) {
  if (!chatId) return;
  const btn = document.querySelector(
    `.chat-list-item-btn[data-chat-id="${chatId}"]`
  );
  if (!btn) return;

  const lastMessageEl = btn.querySelector(".last-message");
  if (!lastMessageEl) return;

  if (draftText) {
    // Показываем черновик красным цветом
    lastMessageEl.textContent = draftText;
    lastMessageEl.style.color = "var(--color-accent-danger, #dc1010)";
    lastMessageEl.style.fontStyle = "italic";
    lastMessageEl.dataset.isDraft = "true";
    btn.dataset.hasDraft = "true";
  } else {
    // Возвращаем обычное сообщение
    const originalText = lastMessageEl.dataset.originalText || "Нет сообщений";
    lastMessageEl.textContent = originalText;
    lastMessageEl.style.color = "";
    lastMessageEl.style.fontStyle = "";
    lastMessageEl.removeAttribute("data-is-draft");
    btn.removeAttribute("data-has-draft");
  }

  // Пересортировываем список чатов
  sortChatList();
}

function formatTime(iso) {
  if (!iso) return "";
  // JavaScript Date автоматически конвертирует UTC время в локальный часовой пояс
  const d = new Date(iso);
  // Проверяем, что дата валидна
  if (isNaN(d.getTime())) return "";
  // Используем локальное время браузера (автоматически конвертируется из UTC)
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// === НОВЫЙ ХЕЛПЕР: Форматирование статуса "Был(а) в сети..." ===
function formatLastSeen(lastSeen, isOnline) {
  // 1. Если "Печатает...", он важнее (логика в setTypingStatus)
  if (
    currentChatStatus &&
    currentChatStatus.classList.contains("typing-status")
  ) {
    return currentChatStatus.textContent;
  }

  // 2. Если это бот, показываем "бот"
  if (lastSeen === "bot") {
    return "бот";
  }

  // 3. Если lastSeen равен null или undefined (скрыт настройками конфиденциальности)
  if (lastSeen === null || lastSeen === undefined || lastSeen === "") {
    return ""; // Не показываем статус, если он скрыт
  }

  // 4. Если в сети
  if (isOnline) {
    return "в сети";
  }

  // 5. Если не в сети, форматируем время
  if (!lastSeen || lastSeen === "online") {
    // "online" но isOnline=false значит только что вышел
    return "был(а) только что";
  }

  try {
    const d = new Date(lastSeen);
    if (isNaN(d.getTime())) return ""; // Невалидная дата

    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / (1000 * 60));
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffMin < 1) return "был(а) только что";
    if (diffMin < 60) return `был(а) ${diffMin} мин. назад`;
    if (diffHour < 24) return `был(а) ${diffHour} ч. назад`;
    if (diffDay === 1) return `был(а) вчера в ${formatTime(lastSeen)}`;
    return `был(а) ${d.toLocaleDateString("ru-RU")}`;
  } catch (e) {
    console.warn("Could not parse lastSeen date:", lastSeen);
    return "";
  }
}
// === КОНЕЦ НОВОГО ХЕЛПЕРА ===

// === scrollToBottom теперь по умолчанию "smooth" ===
function scrollToBottom(force = false) {
  if (!chatMessages) return;

  // Если пользователь не внизу и не принудительная прокрутка, не прокручиваем
  if (!force && !isUserAtBottom) {
    return;
  }

  chatMessages.scrollTo({
    top: chatMessages.scrollHeight,
    behavior: force ? "auto" : "smooth",
  });

  // После прокрутки обновляем состояние
  setTimeout(() => {
    checkIfUserAtBottom();
  }, 100);
}

/**
 * Проверяет, находится ли пользователь внизу чата
 */
function checkIfUserAtBottom() {
  if (!chatMessages) return;

  const threshold = 100; // Порог в пикселях от низа
  const scrollTop = chatMessages.scrollTop;
  const scrollHeight = chatMessages.scrollHeight;
  const clientHeight = chatMessages.clientHeight;

  const wasAtBottom = isUserAtBottom;
  isUserAtBottom = scrollHeight - scrollTop - clientHeight < threshold;

  // Если пользователь прокрутил вниз, сбрасываем счетчик и скрываем кнопку
  if (isUserAtBottom) {
    newMessagesCount = 0;
    updateScrollToBottomButton();
  } else if (wasAtBottom && !isUserAtBottom) {
    // Пользователь прокрутил вверх - показываем кнопку
    updateScrollToBottomButton();
  }
}

/**
 * Обновляет видимость кнопки прокрутки вниз и счетчика
 */
function updateScrollToBottomButton() {
  if (!scrollToBottomBtn || !newMessagesCountEl) return;

  if (!isUserAtBottom || newMessagesCount > 0) {
    scrollToBottomBtn.classList.remove("hidden");

    if (newMessagesCount > 0) {
      newMessagesCountEl.textContent =
        newMessagesCount > 99 ? "99+" : newMessagesCount;
      newMessagesCountEl.classList.remove("hidden");
    } else {
      newMessagesCountEl.classList.add("hidden");
    }
  } else {
    scrollToBottomBtn.classList.add("hidden");
    newMessagesCountEl.classList.add("hidden");
  }
}

function toggleSendButton() {
  sendButton.classList.toggle("hidden", messageInput.value.trim().length === 0);
}

function openForwardModalForMessage(messageEl) {
  if (!forwardModal) return;
  forwardSelected.clear();
  forwardSource = extractForwardSource(messageEl);
  forwardRecipientsList.innerHTML = "";
  forwardSelectedRecipients.innerHTML = "";
  if (forwardError) {
    forwardError.classList.add("hidden");
    forwardError.textContent = "";
  }
  if (forwardSearchInput) forwardSearchInput.value = "";
  loadForwardContacts().then(() => {
    renderForwardRecipients(allForwardContacts, "");
    renderForwardSelected();
  });
  forwardModal.classList.remove("hidden");
  forwardModal.style.display = "flex";
}

function closeForwardModal() {
  if (!forwardModal) return;
  forwardModal.classList.add("hidden");
  forwardModal.style.display = "none";
  forwardSelected.clear();
  forwardSource = null;
}

function extractForwardSource(messageEl) {
  const msgContent = messageEl.querySelector(".message-content");
  const msgImage = messageEl.querySelector(".message-image");
  const msgVideo = messageEl.querySelector(".message-video");
  const msgFile = messageEl.querySelector(".message-file-container");
  const msgAudioBar = messageEl.querySelector(".audio-bar");
  if (msgContent) {
    return { type: "text", text: msgContent.textContent || "" };
  }
  if (msgImage) {
    const src = msgImage.getAttribute("src") || "";
    const alt = msgImage.getAttribute("alt") || "";
    return { type: "image", text: alt || "Фото", url: src, filename: alt || null };
  }
  if (msgVideo) {
    const src = msgVideo.getAttribute("src") || "";
    // Имя файла попробуем извлечь из src
    return { type: "video", text: "Видео", url: src, filename: null };
  }
  if (msgFile) {
    const fileNameEl = msgFile.querySelector("[data-filename]");
    const fileUrlEl = msgFile.querySelector("a[href]");
    const name = fileNameEl
      ? fileNameEl.dataset.filename || fileNameEl.textContent
      : "Файл";
    const url = fileUrlEl ? fileUrlEl.getAttribute("href") : "";
    return { type: "file", text: name, url };
  }
  if (msgAudioBar) {
    const url = msgAudioBar.dataset.audioUrl || "";
    return { type: "audio", text: "Голосовое сообщение", url };
  }
  return { type: "text", text: "Сообщение" };
}

async function loadForwardContacts() {
  try {
    const resp = await fetch(`${API_BASE_URL}/api/contacts`, {
      credentials: "include",
    });
    if (!resp.ok) throw new Error();
    const data = await resp.json();
    allForwardContacts = data.contacts || [];
  } catch (e) {
    allForwardContacts = [];
  }
}

function renderForwardRecipients(users = [], query = "") {
  if (!forwardRecipientsList) return;
  forwardRecipientsList.innerHTML = "";
  const q = (query || "").trim().toLowerCase().replace(/^@+/, "");
  let list = users;
  if (q) {
    list = users.filter((u) => {
      const name =
        (u.display_name ||
          u.full_name ||
          u.username ||
          u.email ||
          "").toLowerCase();
      const un = (u.username || "").toLowerCase().replace(/^@+/, "");
      const em = (u.email || "").toLowerCase();
      return name.includes(q) || un.includes(q) || em.includes(q);
    });
  }
  const filtered = list.filter((u) => {
    const em = (u.email || "").toLowerCase();
    return !Array.from(forwardSelected).some(
      (e) => (e || "").toLowerCase() === em
    );
  });
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "group-participants-empty";
    empty.textContent = q
      ? "Ничего не найдено"
      : "Ваши контакты появятся здесь";
    forwardRecipientsList.appendChild(empty);
    return;
  }
  filtered.forEach((u) => {
    const item = document.createElement("div");
    item.className = "group-participant-item";
    const displayName =
      u.display_name || u.full_name || u.username || u.email;
    const un = (u.username || "").trim().replace(/^@+/, "");
    const usernameLine = un
      ? `<div class="group-participant-username">@${un}</div>`
      : "";
    item.innerHTML = `
      <div class="group-participant-checkbox">
        <input type="checkbox" id="forward-${u.email}" data-email="${u.email}"/>
        <label for="forward-${u.email}"></label>
      </div>
      <img src="${u.profile_picture || generateAvatar(displayName, u.user_id || u.email)}" alt="${displayName}"/>
      <div class="group-participant-info">
        <div class="group-participant-name">${displayName}</div>
        ${usernameLine}
        <div class="group-participant-email">${u.email}</div>
      </div>
    `;
    const cb = item.querySelector('input[type="checkbox"]');
    cb.addEventListener("change", (e) => {
      if (e.target.checked) {
        forwardSelected.add(u.email);
      } else {
        forwardSelected.delete(u.email);
      }
      renderForwardSelected();
    });
    forwardRecipientsList.appendChild(item);
  });
}

function renderForwardSelected() {
  if (!forwardSelectedRecipients) return;
  forwardSelectedRecipients.innerHTML = "";
  if (forwardSelected.size === 0) {
    forwardSelectedRecipients.innerHTML =
      '<div class="group-selected-empty">Выберите получателей</div>';
    return;
  }
  forwardSelected.forEach((email) => {
    const contact = allForwardContacts.find(
      (c) => (c.email || "").toLowerCase() === (email || "").toLowerCase()
    );
    const displayName =
      (contact &&
        (contact.display_name ||
          contact.full_name ||
          contact.username ||
          contact.email)) ||
      email;
    const avatar = (contact && contact.profile_picture) || generateAvatar(displayName, email);
    const chip = document.createElement("div");
    chip.className = "group-selected-chip";
    chip.innerHTML = `
      <img src="${avatar}" alt="${displayName}"/>
      <span>${displayName}</span>
      <button type="button" class="group-selected-remove" data-email="${email}">×</button>
    `;
    const removeBtn = chip.querySelector(".group-selected-remove");
    removeBtn.addEventListener("click", () => {
      forwardSelected.delete(email);
      renderForwardSelected();
      if (forwardSearchInput && forwardSearchInput.value.trim()) {
        triggerForwardSearch(forwardSearchInput.value);
      } else {
        renderForwardRecipients(allForwardContacts, "");
      }
    });
    forwardSelectedRecipients.appendChild(chip);
  });
}

function triggerForwardSearch(query) {
  const q = (query || "").trim();
  const qq = q.replace(/^@+/, "").trim();
  if (!qq) {
    renderForwardRecipients(allForwardContacts, "");
    return;
  }
  fetch(
    `${API_BASE_URL}/api/users/search?query=${encodeURIComponent(qq)}`,
    { credentials: "include" }
  )
    .then((r) => r.json())
    .then((data) => {
      const users = Array.isArray(data) ? data : data.users || [];
      const formatted = users.map((u) => ({
        email: u.email,
        display_name: u.full_name || u.username || u.email,
        full_name: u.full_name,
        username: u.username,
        profile_picture: u.profile_picture || generateAvatar(u.full_name || u.username || u.email, u.email),
      }));
      renderForwardRecipients(formatted, q);
    })
    .catch(() => {
      renderForwardRecipients([], q);
    });
}

async function ensureChatWith(email) {
  const form = new FormData();
  form.append("target_email", email);
  const resp = await fetch(`${API_BASE_URL}/start_chat`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err.detail || "Не удалось открыть чат";
    throw new Error(msg);
  }
  const data = await resp.json();
  return data.chat_id;
}

async function sendForwardToChat(chatId, payload) {
  const form = new FormData();
  form.append("message_content", payload);
  const resp = await fetch(`${API_BASE_URL}/api/send_message/${chatId}`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err.detail || "Ошибка отправки";
    throw new Error(msg);
  }
  return await resp.json();
}

function buildForwardPayload(src) {
  if (!src) return "";
  if (src.type === "text") return src.text || "";
  // Для изображений и видео — без подписи при пересылке
  if (src.type === "image") return "";
  if (src.type === "video") return "";
  if (src.type === "file") return src.text || "Файл";
  if (src.type === "audio") return "Голосовое сообщение";
  return src.text || "";
}

function filenameFromUrl(url, fallback = "file") {
  try {
    const u = new URL(url, window.location.origin);
    const base = u.pathname.split("/").filter(Boolean).pop() || "";
    if (base) return decodeURIComponent(base);
  } catch {}
  return fallback;
}

async function fetchBlobWithName(url, fallbackName) {
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error("Не удалось скачать медиа для пересылки");
  const blob = await resp.blob();
  const contentType = resp.headers.get("content-type") || blob.type || "";
  let name = fallbackName || filenameFromUrl(url, "file");
  if (!/\.[a-z0-9]{2,}$/i.test(name)) {
    // Добавим расширение из content-type, если его нет
    if (contentType.startsWith("image/")) {
      const ext = contentType.split("/")[1] || "png";
      name = `${name}.${ext}`;
    } else if (contentType.startsWith("video/")) {
      const ext = contentType.split("/")[1] || "mp4";
      name = `${name}.${ext}`;
    } else if (contentType.startsWith("audio/")) {
      const ext = contentType.split("/")[1] || "mp3";
      name = `${name}.${ext}`;
    }
  }
  // Создаем File для корректного имени на сервере
  try {
    const file = new File([blob], name, { type: contentType || blob.type });
    return { file, blob, name, contentType: contentType || blob.type };
  } catch {
    // В некоторых окружениях File может быть недоступен,fallback на Blob с name
    return { file: blob, blob, name, contentType: contentType || blob.type };
  }
}

async function pinMessage(messageId) {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/pin_message/${messageId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || "Ошибка закрепления сообщения");
    }
    const result = await response.json();
    console.log(result.message);
    closeContextMenu();
  } catch (error) {
    console.error("Ошибка закрепления сообщения:", error);
    alert(error.message || "Не удалось закрепить сообщение");
  }
}

function updatePinnedMessage(pinnedMessageId, pinnedMessage) {
  let pinnedContainer = document.getElementById("pinnedMessageContainer");

  if (!pinnedMessageId || !pinnedMessage) {
    // Удаляем контейнер, если сообщение откреплено
    if (pinnedContainer) {
      pinnedContainer.remove();
    }
    return;
  }

  // Если данных сообщения нет, пытаемся получить их из DOM
  if (!pinnedMessage.content && !pinnedMessage.type) {
    const messageEl = document.querySelector(
      `.message[data-message-id="${pinnedMessageId}"]`
    );
    if (messageEl) {
      const msgContent = messageEl.querySelector(".message-content");
      const isOutgoing = messageEl.classList.contains("outgoing");
      pinnedMessage = {
        sender_id: isOutgoing ? currentUserEmail : "other",
        content: msgContent ? msgContent.textContent : "",
        type: "text",
      };
    } else {
      // Если сообщение не найдено в DOM, не показываем закрепленное
      return;
    }
  }

  // Создаем контейнер, если его нет
  if (!pinnedContainer) {
    pinnedContainer = document.createElement("div");
    pinnedContainer.id = "pinnedMessageContainer";
    pinnedContainer.className = "pinned-message-container";
    const chatHeader = document.querySelector(".chat-header");
    if (chatHeader) {
      chatHeader.insertAdjacentElement("afterend", pinnedContainer);
    } else {
      const wrapper = document.querySelector(".chat-messages-wrapper");
      if (wrapper && wrapper.parentNode) {
        wrapper.parentNode.insertBefore(pinnedContainer, wrapper);
      }
    }
  }

  // Формируем контент закрепленного сообщения
  const senderName =
    pinnedMessage.sender_id === currentUserEmail ? "Вы" : "Собеседник";
  let contentText = pinnedMessage.content || "";
  if (pinnedMessage.type === "image") {
    contentText = contentText || "Фото";
  } else if (pinnedMessage.type === "video") {
    contentText = contentText || "Видео";
  } else if (pinnedMessage.type === "file") {
    contentText = pinnedMessage.filename || "Файл";
  } else if (pinnedMessage.type === "audio") {
    contentText = "Голосовое сообщение";
  }

  pinnedContainer.innerHTML = `
    <div class="pinned-message-content">
      <div class="pinned-message-icon">
        <svg width="14" height="19" viewBox="0 0 14 19" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4.85714 5.28571V11.2857C4.85714 12.4692 5.81653 13.4286 7 13.4286C8.18347 13.4286 9.14286 12.4692 9.14286 11.2857V5.07143C9.14286 2.82284 7.32002 1 5.07143 1C2.82284 1 1 2.82284 1 5.07143V11.7143C1 15.028 3.68629 17.7143 7 17.7143C10.3137 17.7143 13 15.028 13 11.7143V5.28571" stroke="#02060F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="pinned-message-info">
        <div class="pinned-message-sender">${senderName}</div>
        <div class="pinned-message-text">${contentText}</div>
      </div>
      <button class="pinned-message-close" aria-label="Открепить">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M13.5 4.5L4.5 13.5M4.5 4.5L13.5 13.5" stroke="#02060F" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `;

  // Добавляем обработчик клика для открепления
  const closeBtn = pinnedContainer.querySelector(".pinned-message-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pinMessage(pinnedMessageId);
    });
  }

  // Добавляем обработчик клика для прокрутки к сообщению
  const contentEl = pinnedContainer.querySelector(".pinned-message-content");
  if (contentEl) {
    contentEl.addEventListener("click", () => {
      const messageEl = document.querySelector(
        `.message[data-message-id="${pinnedMessageId}"]`
      );
      if (messageEl) {
        messageEl.scrollIntoView({ behavior: "smooth", block: "center" });
        messageEl.style.outline = "2px solid var(--color-primary)";
        setTimeout(() => {
          messageEl.style.outline = "";
        }, 2000);
      }
    });
  }
}

async function deleteMessage(messageId, deleteForAll, elementToRemove) {
  console.log(`Удаление ${messageId}, deleteForAll: ${deleteForAll}`);
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/delete_message/${messageId}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          delete_for_all: deleteForAll,
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || "Ошибка удаления сообщения");
    }
    const result = await response.json();
    console.log(result.message);

    // Локальное удаление сообщения из DOM
    if (elementToRemove) {
      const row = elementToRemove.closest(".message-row");
      if (row) {
        row.remove();
      }
    }

    // Если удаляем только у себя — нужно обновить превью и сортировку чатов
    if (!deleteForAll && activeChatId) {
      const btn = document.querySelector(
        `.chat-list-item-btn[data-chat-id="${activeChatId}"]`
      );
      if (btn) {
        const lastBubble = chatMessages.querySelector(".message:last-of-type");
        let previewText = "Нет сообщений";
        let previewTimestampIso = null;

        if (lastBubble) {
          // Проверяем тип сообщения по наличию элементов
          const imageEl = lastBubble.querySelector(".message-image");
          const videoEl = lastBubble.querySelector(".message-video");
          const fileEl = lastBubble.querySelector(".message-file-container");
          const audioEl = lastBubble.querySelector(".audio-message");

          if (imageEl) {
            previewText = "Фотография";
          } else if (videoEl) {
            previewText = "Видео";
          } else if (fileEl) {
            const fileNameEl = fileEl.querySelector("[data-filename]");
            previewText = fileNameEl
              ? fileNameEl.dataset.filename || fileNameEl.textContent
              : "Файл";
          } else if (audioEl) {
            previewText = "Голосовое сообщение";
          } else if (lastBubble.dataset.originalContent) {
            previewText = lastBubble.dataset.originalContent;
          } else {
            const contentEl = lastBubble.querySelector(".message-content");
            if (contentEl && contentEl.textContent.trim()) {
              previewText = contentEl.textContent;
            }
          }

          if (lastBubble.dataset.timestamp) {
            previewTimestampIso = lastBubble.dataset.timestamp;
          }
        }

        updateChatPreview(activeChatId, previewText);

        if (previewTimestampIso) {
          const timeEl = btn.querySelector(".chat-list-time");
          if (timeEl) {
            timeEl.textContent = formatTime(previewTimestampIso);
          }
          btn.dataset.lastTimestamp = previewTimestampIso;
        }

        // Пересортируем список чатов, чтобы чат "вернулся" на своё прошлое место
        if (typeof sortChatList === "function") {
          sortChatList();
        }
      }
    }
  } catch (err) {
    console.error("Ошибка при удалении сообщения:", err);
    alert(err.message);
  }
}

async function clearChat(deleteForAll) {
  if (!activeChatId) return;

  try {
    const response = await fetch(`${API_BASE_URL}/api/clear_chat/${activeChatId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete_for_all: deleteForAll }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || "Ошибка очистки чата");
    }

    if (deleteForAll) {
      if (chatMessages) chatMessages.innerHTML = "";
      const btn = document.querySelector(`.chat-list-item-btn[data-chat-id="${activeChatId}"]`);
      if (btn) {
        const lastMsg = btn.querySelector(".last-message");
        if (lastMsg) lastMsg.textContent = "Нет сообщений";
      }
    } else {
      // Удаляем (скрываем) чат у себя
      const btn = document.querySelector(`.chat-list-item-btn[data-chat-id="${activeChatId}"]`);
      if (btn) {
        const li = btn.closest("li");
        if (li) li.remove();
      }

      // === ИСПРАВЛЕНИЕ: Сбрасываем URL, чтобы чат не "воскрес" ===
      window.history.replaceState(null, "", "/");
      isChatOpenedFromUrl = false;
      isProtectionActive = false;
      if (typeof protectionInterval !== 'undefined' && protectionInterval) {
        clearInterval(protectionInterval);
        protectionInterval = null;
      }

      if (chatWindow) chatWindow.classList.add("hidden");
      if (chatEmptyState) chatEmptyState.classList.remove("hidden");
      activeChatId = null;
    }
  } catch (err) {
    console.error("Ошибка при очистке чата:", err);
    alert(err.message);
  }
}

async function deleteChat(deleteForAll) {
  if (!activeChatId) return;

  try {
    const response = await fetch(`${API_BASE_URL}/api/delete_chat/${activeChatId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete_for_all: deleteForAll }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.detail || "Ошибка удаления чата");
    }

    // Удаляем чат из списка
    const btn = document.querySelector(`.chat-list-item-btn[data-chat-id="${activeChatId}"]`);
    if (btn) {
      const li = btn.closest("li");
      if (li) li.remove();
    }

    // === ИСПРАВЛЕНИЕ: Сбрасываем URL, чтобы чат не "воскрес" ===
    window.history.replaceState(null, "", "/");
    isChatOpenedFromUrl = false;
    isProtectionActive = false;
    if (typeof protectionInterval !== 'undefined' && protectionInterval) {
      clearInterval(protectionInterval);
      protectionInterval = null;
    }

    // Закрываем окно чата
    if (chatWindow) chatWindow.classList.add("hidden");
    if (chatEmptyState) chatEmptyState.classList.remove("hidden");
    activeChatId = null;

  } catch (err) {
    console.error("Ошибка при удалении чата:", err);
    alert(err.message);
  }
}

function sortChatList() {
  // ... (без изменений) ...
  const items = Array.from(chatListUl.querySelectorAll("li"));
  const chatItems = items.filter((li) =>
    li.querySelector(".chat-list-item-btn")
  );
  const otherItems = items.filter(
    (li) => !li.querySelector(".chat-list-item-btn")
  );

  chatItems.sort((liA, liB) => {
    const btnA = liA.querySelector(".chat-list-item-btn");
    const btnB = liB.querySelector(".chat-list-item-btn");

    // Приоритет чатам с черновиками
    const hasDraftA = btnA.dataset.hasDraft === "true";
    const hasDraftB = btnB.dataset.hasDraft === "true";

    if (hasDraftA && !hasDraftB) return -1; // A выше
    if (!hasDraftA && hasDraftB) return 1; // B выше

    // Если оба с черновиками или оба без, сортируем по времени
    const timeA = btnA.dataset.lastTimestamp
      ? new Date(btnA.dataset.lastTimestamp)
      : new Date(0);
    const timeB = btnB.dataset.lastTimestamp
      ? new Date(btnB.dataset.lastTimestamp)
      : new Date(0);
    return timeB - timeA; // Новые вверху
  });

  chatListUl.innerHTML = "";
  otherItems.forEach((item) => chatListUl.appendChild(item));
  chatItems.forEach((item) => chatListUl.appendChild(item));
}

// ===================================
// === setUnreadCount ===
// ===================================
function setUnreadCount(chatId, count) {
  const btn = document.querySelector(`.chat-list-item-btn[data-chat-id="${chatId}"]`);
  if (!btn) return;

  let unreadEl = btn.querySelector(".unread-count");

  // Надежно парсим число, чтобы избежать багов со строками (например, "0")
  const numCount = parseInt(count, 10) || 0;

  // Если сообщений 0 или меньше, ЖЕСТКО скрываем кружок
  if (numCount <= 0) {
    if (unreadEl) {
      unreadEl.textContent = "0";
      unreadEl.classList.add("hidden");
    }
    return;
  }

  // Если count > 0, обновляем или создаем кружок
  if (!unreadEl) {
    unreadEl = document.createElement("div");
    unreadEl.classList.add("unread-count");
    const metaRight = btn.querySelector(".chat-meta-right");
    if (metaRight) {
      metaRight.appendChild(unreadEl);
    } else {
      btn.appendChild(unreadEl);
    }
  }

  unreadEl.textContent = numCount;
  unreadEl.classList.remove("hidden");
}

// ===================================
// === setChatListTicks (без изменений) ===
// ===================================
function setChatListTicks(chatId, status) {
  // ... (без изменений) ...
  const btn = document.querySelector(
    `.chat-list-item-btn[data-chat-id="${chatId}"]`
  );
  if (!btn) return;
  const ticksEl = btn.querySelector(".chat-list-ticks");
  if (!ticksEl) {
    console.warn(`No .chat-list-ticks found for chat ${chatId}`);
    return;
  }
  if (status === "read") {
    ticksEl.innerHTML = `<img src="/images/read.svg" alt="Прочитано">`;
  } else if (status === "sent") {
    ticksEl.innerHTML = `<img src="/images/no_read.svg" alt="Отправлено">`;
  } else {
    ticksEl.innerHTML = "";
  }
}

// ===================================
// === ХЕЛПЕРЫ ДЛЯ "TYPING" (ОБНОВЛЕН) ===
// ===================================

function setTypingStatus(chatId, isTyping) {
  // ... (без изменений, эта логика уже обновлена) ...
  const btn = document.querySelector(
    `.chat-list-item-btn[data-chat-id="${chatId}"]`
  );
  if (btn) {
    const lastMsg = btn.querySelector(".last-message");
    if (lastMsg) {
      if (isTyping) {
        if (!lastMsg.classList.contains("typing-status")) {
          lastMsg.textContent = "Печатает...";
          lastMsg.classList.add("typing-status");
        }
      } else {
        if (lastMsg.classList.contains("typing-status")) {
          const originalText = lastMsg.dataset.originalText || "Нет сообщений";
          lastMsg.textContent = originalText;
          lastMsg.classList.remove("typing-status");
        }
      }
    }
  }
  if (chatId === activeChatId && currentChatStatus) {
    if (isTyping) {
      if (!currentChatStatus.classList.contains("typing-status")) {
        currentChatStatus.dataset.originalText = currentChatStatus.textContent;
        currentChatStatus.textContent = "Печатает...";
        currentChatStatus.classList.add("typing-status");
      }
    } else {
      if (currentChatStatus.classList.contains("typing-status")) {
        const originalStatus = currentChatStatus.dataset.originalText || "";
        currentChatStatus.textContent = originalStatus;
        currentChatStatus.classList.remove("typing-status");
      }
    }
  }
}

let typingTimer = null;
let isCurrentlyTyping = false;

// === Состояние поиска по сообщениям ===
let chatSearchMatches = [];
let chatSearchIndex = 0;
const CHAT_SEARCH_STATES = {
  IDLE: "idle",
  EMPTY: "empty",
  RESULTS: "results",
};
let chatSearchState = CHAT_SEARCH_STATES.IDLE;

function clearChatSearchHighlights() {
  if (!chatMessages) return;
  chatMessages
    .querySelectorAll(".message.search-match, .message.search-match-current")
    .forEach((msg) => {
      msg.classList.remove("search-match", "search-match-current");
    });
}

function applyChatSearchHighlight() {
  clearChatSearchHighlights();
  if (!chatSearchMatches.length) return;
  chatSearchMatches.forEach((el, idx) => {
    const bubble = el.closest(".message");
    if (!bubble) return;
    if (idx === chatSearchIndex) {
      bubble.classList.add("search-match-current");
      bubble.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      bubble.classList.add("search-match");
    }
  });
}

function updateChatSearchSummary() {
  if (chatSearchCount) {
    if (!chatSearchMatches.length) {
      chatSearchCount.textContent = "";
    } else {
      chatSearchCount.textContent = `Найдено ${chatSearchIndex + 1} из ${
        chatSearchMatches.length
      }`;
    }
  }
}

function renderMessageSearchResults() {
  if (!messageSearchResultsList) return;

  messageSearchResultsList.innerHTML = "";

  if (!chatSearchMatches || chatSearchMatches.length === 0) {
    if (messageSearchResultsEmpty) {
      messageSearchResultsEmpty.classList.remove("hidden");
    }
    return;
  }

  if (messageSearchResultsEmpty) {
    messageSearchResultsEmpty.classList.add("hidden");
  }

  chatSearchMatches.forEach((contentEl, index) => {
    const messageEl = contentEl.closest(".message");
    if (!messageEl) return;

    const messageRow = messageEl.closest(".message-row");
    if (!messageRow) return;

    const messageId = messageEl.dataset.messageId;
    const messageText = contentEl.textContent || "";
    const previewText =
      messageText.length > 50
        ? messageText.substring(0, 50) + "..."
        : messageText;

    const timestamp = messageEl.dataset.timestamp;
    const timeStr = timestamp ? formatTime(timestamp) : "";

    const isMine = messageRow.classList.contains("outgoing");
    const groupSenderName = messageRow.querySelector(
      ".group-message-sender-name"
    )?.textContent;
    const isGroupRow =
      messageRow.classList.contains("group-message-row") ||
      Boolean(groupSenderName);

    const senderName = isMine
      ? currentUserDisplayName
      : groupSenderName || currentChatTitle?.textContent || "Собеседник";

    // Аватар автора: для групп берем из сообщения, для личных — из хедера чата
    let avatarSrc = generateAvatar(senderName, senderName);
    if (isMine) {
      avatarSrc = currentUserAvatarUrl || generateAvatar(currentUserDisplayName, currentUserEmail);
    } else if (isGroupRow) {
      avatarSrc =
        messageRow.querySelector(".group-message-avatar img")?.src ||
        generateAvatar(senderName, "group");
    } else if (currentChatAvatar?.src) {
      avatarSrc = currentChatAvatar.src;
    }

    const item = document.createElement("div");
    item.className = "message-search-result";
    if (index === chatSearchIndex) {
      item.classList.add("active");
    }
    item.innerHTML = `
      <div class="message-search-result-avatar">
        <img src="${avatarSrc}" alt="${senderName}" />
      </div>
      <div class="message-search-result-details">
        <div class="message-search-result-label">${senderName}${
      timeStr ? ` · ${timeStr}` : ""
    }</div>
        <div class="message-search-result-snippet">${previewText}</div>
      </div>
    `;

    item.addEventListener("click", () => {
      chatSearchIndex = index;
      applyChatSearchHighlight();
      updateChatSearchSummary();
    });

    messageSearchResultsList.appendChild(item);
  });
}

function setChatSearchState(state) {
  chatSearchState = state;
  if (chatSearchBar) {
    chatSearchBar.dataset.state = state;
  }
  if (chatSearchIcon) {
    chatSearchIcon.src =
      state === CHAT_SEARCH_STATES.EMPTY
        ? "/images/search-01-red.svg"
        : "/images/search-01.svg";
  }
  if (chatSearchClearIcon) {
    chatSearchClearIcon.src =
      state === CHAT_SEARCH_STATES.EMPTY
        ? "/images/x-02-red.svg"
        : "/images/x-02-blue.svg";
  }
  if (chatSearchEmptyLabel) {
    chatSearchEmptyLabel.setAttribute(
      "aria-hidden",
      state === CHAT_SEARCH_STATES.EMPTY ? "false" : "true"
    );
  }
}

setChatSearchState(CHAT_SEARCH_STATES.IDLE);

function toggleMessageSearchResultsPanel(active) {
  if (chatListScroll) {
    chatListScroll.classList.toggle("hidden", active);
  }
  if (messageSearchResults) {
    messageSearchResults.classList.toggle("hidden", !active);
  }
}

function updateChatSearchResults(query) {
  if (!chatMessages) return;
  const q = (query || "").trim();

  if (!q) {
    chatSearchMatches = [];
    chatSearchIndex = 0;
    clearChatSearchHighlights();
    updateChatSearchSummary();
    setChatSearchState(CHAT_SEARCH_STATES.IDLE);
    toggleMessageSearchResultsPanel(false);
    renderMessageSearchResults();
    return;
  }

  const lower = q.toLowerCase();
  const contents = chatMessages.querySelectorAll(".message .message-content");
  chatSearchMatches = [];

  contents.forEach((el) => {
    const text = (el.textContent || "").toLowerCase();
    if (text.includes(lower)) {
      chatSearchMatches.push(el);
    }
  });

  toggleMessageSearchResultsPanel(true);
  renderMessageSearchResults();

  if (!chatSearchMatches.length) {
    clearChatSearchHighlights();
    updateChatSearchSummary();
    if (chatSearchClearBtn) chatSearchClearBtn.classList.remove("hidden");
    setChatSearchState(CHAT_SEARCH_STATES.EMPTY);
    return;
  }

  chatSearchIndex = 0;
  applyChatSearchHighlight();

  updateChatSearchSummary();
  if (chatSearchClearBtn) chatSearchClearBtn.classList.remove("hidden");
  setChatSearchState(CHAT_SEARCH_STATES.RESULTS);
}

function moveChatSearchNext() {
  if (!chatSearchMatches.length) return;
  chatSearchIndex = (chatSearchIndex + 1) % chatSearchMatches.length;
  applyChatSearchHighlight();
  updateChatSearchSummary();
}

function moveChatSearchPrev() {
  if (!chatSearchMatches.length) return;
  chatSearchIndex =
    (chatSearchIndex - 1 + chatSearchMatches.length) % chatSearchMatches.length;
  applyChatSearchHighlight();
  updateChatSearchSummary();
}

function openChatSearch() {
  if (!chatSearchWrapper) return;
  chatSearchWrapper.classList.remove("hidden");
  if (chatSearchBtn) {
    const img = chatSearchBtn.querySelector("img");
    if (img) img.src = "/images/search-01.svg";
  }
  if (chatSearchInput) {
    chatSearchInput.focus();
    if (chatSearchClearBtn) chatSearchClearBtn.classList.remove("hidden");
    updateChatSearchResults(chatSearchInput.value || "");
  }
}

function closeChatSearch() {
  if (!chatSearchWrapper) return;
  chatSearchWrapper.classList.add("hidden");
  if (chatSearchInput) chatSearchInput.value = "";
  if (chatSearchCount) chatSearchCount.textContent = "";
  setChatSearchState(CHAT_SEARCH_STATES.IDLE);
  if (chatSearchClearBtn) chatSearchClearBtn.classList.add("hidden");
  chatSearchMatches = [];
  chatSearchIndex = 0;
  clearChatSearchHighlights();
  toggleMessageSearchResultsPanel(false);
  renderMessageSearchResults();

  // возвращаем иконку в хедере на обычную
  if (chatSearchBtn) {
    const img = chatSearchBtn.querySelector("img");
    if (img) img.src = "/images/лупа.svg";
  }
}

// Для групповых чатов: убедиться, что первая входящая в серии несет аватар + ник
function ensureGroupHeader(row) {
  if (!row || row.classList.contains("outgoing")) return;
  const senderId = row.dataset.senderId;
  if (!senderId) return;
  const bubble = row.querySelector(".message");
  if (!bubble) return;
  const hasName = bubble.querySelector(".group-message-sender-name");
  const hasAvatar = row.querySelector(".group-message-avatar");
  if (hasName && hasAvatar) return;

  let displayName = senderId;
  try {
    const contactsMap = window.CONTACTS_BY_EMAIL || {};
    if (contactsMap[senderId]) {
      const c = contactsMap[senderId];
      displayName =
        c.contact_name ||
        c.display_name ||
        c.full_name ||
        c.username ||
        displayName;
    }
  } catch (e) {}

  // Добавляем аватар слева, если его нет
  if (!hasAvatar) {
    const senderAvatar = document.createElement("div");
    senderAvatar.className = "group-message-avatar";
    const avatarImg = document.createElement("img");
    avatarImg.src = generateAvatar(displayName, senderId);
    avatarImg.alt = displayName;
    avatarImg.onerror = function () {
      this.src = generateAvatar(displayName, senderId);
    };
    avatarImg.style.cursor = "pointer";
    avatarImg.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof window.openProfileModal === "function") {
        window.openProfileModal(senderId);
      }
    });
    senderAvatar.appendChild(avatarImg);
    row.insertBefore(senderAvatar, bubble);
  }

  // Добавляем ник в начале пузыря, если его нет
  if (!hasName) {
    const senderNameEl = document.createElement("div");
    senderNameEl.className = "group-message-sender-name";
    senderNameEl.textContent = displayName;
    senderNameEl.style.cursor = "pointer";
    senderNameEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof window.openProfileModal === "function") {
        window.openProfileModal(senderId);
      }
    });
    bubble.prepend(senderNameEl);
  }
}

function sendTypingEvent() {
  // ... (без изменений) ...
  if (ws && activeChatId && !isCurrentlyTyping) {
    ws.send(JSON.stringify({ type: "typing", chat_id: activeChatId }));
    isCurrentlyTyping = true;
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    if (ws && activeChatId) {
      ws.send(
        JSON.stringify({ type: "stopped_typing", chat_id: activeChatId })
      );
      isCurrentlyTyping = false;
    }
  }, 2000);
}

// ===================================
// === НОВАЯ ФУНКЦИЯ: Обновление статуса ===
// ===================================
function updateUserStatus(userEmail, isOnline, lastSeen) {
  // 1. Обновляем список чатов
  // Находим кнопку чата по email'у собеседника
  const btn = document.querySelector(
    `.chat-list-item-btn[data-interlocutor-email="${userEmail}"]`
  );
  if (btn) {
    let dot = btn.querySelector(".online-status-dot");
    const avatar = btn.querySelector("img"); // Найти аватар

    // Проверяем, можно ли видеть статус онлайн
    // Если lastSeen равен null или пустой строке, значит статус скрыт настройками конфиденциальности
    const canSeeStatus =
      lastSeen !== null && lastSeen !== undefined && lastSeen !== "";

    if (isOnline && canSeeStatus) {
      if (!dot && avatar) {
        // Создаем, только если нет
        dot = document.createElement("div");
        dot.className = "online-status-dot";
        // Вставляем ПОСЛЕ аватара, как в HTML
        avatar.insertAdjacentElement("afterend", dot);
      }
    } else {
      if (dot) {
        // Удаляем, если есть
        dot.remove();
      }
    }
    // Обновляем data-атрибуты, чтобы loadChat их использовал
    btn.dataset.isOnline = isOnline && canSeeStatus ? "true" : "false";
    btn.dataset.lastSeen = lastSeen || "";
  }

  // 2. Обновляем хедер, ЕСЛИ ЭТОТ ЧАТ АКТИВЕН
  if (
    activeChatId &&
    btn &&
    btn.dataset.chatId === activeChatId &&
    currentChatStatus
  ) {
    // Не обновляем, если он "Печатает..."
    if (!currentChatStatus.classList.contains("typing-status")) {
      const statusText = formatLastSeen(lastSeen, isOnline);
      if (statusText) {
        currentChatStatus.textContent = statusText;
        currentChatStatus.dataset.originalText = statusText; // Сохраняем для 'typing'
        currentChatStatus.style.display = "block";
      } else {
        currentChatStatus.textContent = "";
        currentChatStatus.dataset.originalText = "";
        currentChatStatus.style.display = "none";
      }
    } else {
      // Если он печатал, но ушел в оффлайн, надо убрать "Печатает..."
      if (!isOnline) {
        const statusText = formatLastSeen(lastSeen, false);
        if (statusText) {
          currentChatStatus.textContent = statusText;
          currentChatStatus.dataset.originalText = statusText;
          currentChatStatus.style.display = "block";
        } else {
          currentChatStatus.textContent = "";
          currentChatStatus.dataset.originalText = "";
          currentChatStatus.style.display = "none";
        }
        currentChatStatus.classList.remove("typing-status");
      }
      // Если он печатает и пришел "online", ничего не делаем, "Печатает" важнее
    }
  }
}

// === Рендер сообщений (ИДЕАЛЬНАЯ ВЕРСИЯ) ===
function renderMessage(msg, doScroll = true, isGroupChat = false, isHistory = false) {
  if (noMessagesState && !noMessagesState.classList.contains("hidden")) {
    noMessagesState.classList.add("hidden");
  }
  if (chatMessages && chatMessages.classList.contains("hidden")) {
    chatMessages.classList.remove("hidden");
  }
  if (!msg) {
    return;
  }

  if (!msg._id) {
    msg._id = `temp_${Date.now()}_${Math.random()}`;
  }

  // 1. Ищем сообщение в HTML (в открытом чате)
  const existingMessage = document.getElementById(`msg-${msg._id}`);
  if (existingMessage) {
    if (typeof renderedMessageIds !== 'undefined') {
      renderedMessageIds.add(msg._id);
    }
    return;
  }

  // 2. Если сообщений нет на экране, проверяем, не сменился ли чат
  if (!chatMessages) {
    return;
  }

  // 3. Запоминаем, что мы его рисуем
  if (typeof renderedMessageIds !== 'undefined') {
    renderedMessageIds.add(msg._id);
  }

  const senderEmail = msg.sender_id || msg.sender_email || msg.senderId || msg.sender;
  const isSystemMessage = msg.type === "system" || senderEmail === "system";

  if (isSystemMessage) {
    const row = document.createElement("div");
    row.classList.add("message-row", "system-message");
    row.dataset.messageId = msg._id;
    if (msg.timestamp) {
      row.dataset.timestamp = msg.timestamp;
    }

    const systemBubble = document.createElement("div");
    systemBubble.classList.add("system-message-content");

    let contentText = msg.content || "";
    if (window.CONTACTS_BY_EMAIL) {
      for (const [emailKey, contact] of Object.entries(window.CONTACTS_BY_EMAIL)) {
        const emailRegex = new RegExp(emailKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        if (emailRegex.test(contentText)) {
          const cName = contact.contact_name || contact.display_name || contact.full_name || contact.username || emailKey;
          contentText = contentText.replace(emailRegex, cName);
        }
      }
    }

    if (msg.system_action === "avatar_changed" && msg.new_avatar) {
      const avatarContainer = document.createElement("div");
      avatarContainer.style.display = "inline-flex";
      avatarContainer.style.alignItems = "center";
      avatarContainer.style.gap = "8px";

      const avatarImg = document.createElement("img");
      avatarImg.src = msg.new_avatar;
      avatarImg.style.width = "24px";
      avatarImg.style.height = "24px";
      avatarImg.style.borderRadius = "50%";
      avatarImg.style.objectFit = "cover";
      avatarImg.style.border = "2px solid var(--color-primary)";
      avatarImg.onerror = function () {
        this.src = generateAvatar(contentText || "?", "system");
      };

      const textSpan = document.createElement("span");
      renderTextWithEmojis(textSpan, contentText);

      avatarContainer.appendChild(avatarImg);
      avatarContainer.appendChild(textSpan);
      systemBubble.appendChild(avatarContainer);
    } else {
      renderTextWithEmojis(systemBubble, contentText);
    }

    row.appendChild(systemBubble);

    try {
      chatMessages.appendChild(row);
    } catch (error) {
      renderedMessageIds.delete(msg._id);
      return;
    }

    if (doScroll) {
      scrollToBottom(true);
    }
    return;
  }

  const isMine = senderEmail === currentUserEmail;
  const row = document.createElement("div");
  row.classList.add("message-row", isMine ? "outgoing" : "incoming");
  row.dataset.messageId = msg._id;
  if (senderEmail) {
    row.dataset.senderId = senderEmail;
  }
  if (isGroupChat) {
    row.classList.add("group-message-row");
  }
  const bubble = document.createElement("div");
  bubble.classList.add("message", isMine ? "outgoing" : "incoming");
  bubble.id = `msg-${msg._id}`;
  bubble.dataset.messageId = msg._id;
  if (msg.timestamp) {
    bubble.dataset.timestamp = msg.timestamp;
  }
  bubble.dataset.originalContent = msg.content || "";

  if (isGroupChat && !isMine && (msg.sender_name || msg.sender_avatar || senderEmail)) {
    let shouldShowSenderInfo = true;
    if (chatMessages && senderEmail) {
      const lastRow = chatMessages.querySelector(".message-row:last-child");
      if (lastRow && lastRow.dataset.senderId === senderEmail && !lastRow.classList.contains("outgoing")) {
        shouldShowSenderInfo = false;
      }
    }

    if (shouldShowSenderInfo) {
      let displayName = msg.sender_name || senderEmail || msg.sender_id || "Участник";
      const normalizedEmail = senderEmail ? senderEmail.toLowerCase() : null;

      if (normalizedEmail && window.CONTACTS_BY_EMAIL && window.CONTACTS_BY_EMAIL[normalizedEmail]) {
          const contact = window.CONTACTS_BY_EMAIL[normalizedEmail];
          displayName = contact.contact_name || contact.display_name || contact.full_name || contact.username || displayName;
      }

      const senderAvatar = document.createElement("div");
      senderAvatar.className = "group-message-avatar";
      const avatarImg = document.createElement("img");

      let validAvatar = (msg.sender_avatar && !isDefaultAvatar(msg.sender_avatar)) ? msg.sender_avatar : null;
      const avatarToUse = validAvatar ? validAvatar : generateAvatar(displayName, senderEmail);

      avatarImg.src = avatarToUse;
      avatarImg.onerror = function () {
        this.src = generateAvatar(displayName, senderEmail);
      };
      senderAvatar.appendChild(avatarImg);
      row.appendChild(senderAvatar);

      const senderNameEl = document.createElement("div");
      senderNameEl.className = "group-message-sender-name";
      senderNameEl.textContent = displayName;
      bubble.prepend(senderNameEl);
    }
  }

  if (msg.reply_to && (msg.reply_to.content || msg.reply_to.filename)) {
    const replyBox = document.createElement("div");
    replyBox.style.borderLeft = "3px solid var(--color-primary)";
    replyBox.style.paddingLeft = "8px";
    replyBox.style.marginBottom = "6px";
    replyBox.style.fontSize = "14px";
    replyBox.style.color = "var(--color-text-inactive)";
    const author = document.createElement("div");
    author.style.color = "var(--color-primary)";
    author.style.fontWeight = "600";
    author.textContent = msg.reply_to.sender_id === currentUserEmail ? "Вы" : msg.reply_to.sender_id || "Собеседник";
    const snippet = document.createElement("div");
    renderTextWithEmojis(snippet, msg.reply_to.content || msg.reply_to.filename || "");
    replyBox.appendChild(author);
    replyBox.appendChild(snippet);
    bubble.appendChild(replyBox);
  }

  // --- Медиа контент ---
  if (msg.type === "image" && msg.file_url) {
    const imageContainer = document.createElement("div");
    imageContainer.classList.add("message-image-container");
    imageContainer.style.position = "relative";
    const img = document.createElement("img");
    img.src = msg.file_url;
    img.classList.add("message-image");
    img.style.maxWidth = "100%";
    img.style.height = "auto";
    img.style.borderRadius = "10px";
    imageContainer.appendChild(img);

    if (msg.content && msg.content.trim()) {
      const textContent = document.createElement("div");
      textContent.classList.add("message-content");
      textContent.style.marginTop = "8px";
      renderTextWithEmojis(textContent, msg.content);
      imageContainer.appendChild(textContent);
    }
    bubble.appendChild(imageContainer);
    bubble.classList.add("has-image");

  } else if (msg.type === "video" && msg.file_url) {
    const videoContainer = document.createElement("div");
    videoContainer.classList.add("message-video-container");
    videoContainer.style.position = "relative";
    const video = document.createElement("video");
    video.src = msg.file_url;
    video.controls = true;
    video.classList.add("message-video");
    video.style.maxWidth = "100%";
    video.style.height = "auto";
    video.style.borderRadius = "10px";
    videoContainer.appendChild(video);

    if (msg.content && msg.content.trim()) {
      const textContent = document.createElement("div");
      textContent.classList.add("message-content");
      renderTextWithEmojis(textContent, msg.content);
      videoContainer.appendChild(textContent);
    }
    bubble.appendChild(videoContainer);
    bubble.classList.add("has-video");

  } else if (msg.type === "file" && (msg.file_url || msg.is_uploading)) {
    const fileContainer = document.createElement("div");
    fileContainer.className = "message-file-container";
    const iconDiv = document.createElement("div");
    iconDiv.className = "file-icon";
    iconDiv.innerHTML = `<img src="/images/file.svg" alt="File" style="width:100%;height:100%">`;
    fileContainer.appendChild(iconDiv);

    const detailsDiv = document.createElement("div");
    detailsDiv.className = "file-details";
    const nameDiv = document.createElement("div");
    nameDiv.className = "file-name";
    nameDiv.textContent = msg.filename || "Файл";
    detailsDiv.appendChild(nameDiv);
    fileContainer.appendChild(detailsDiv);

    const actionBtn = document.createElement("button");
    actionBtn.className = "file-action-btn icon-download";
    actionBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
            const response = await fetch(msg.file_url);
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.style.display = "none";
            link.href = url;
            link.download = msg.filename || "downloaded_file";
            document.body.appendChild(link);
            link.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(link);
        } catch (err) {
            console.error("Ошибка тихого скачивания:", err);
            window.open(msg.file_url, "_blank");
        }
    };
    fileContainer.appendChild(actionBtn);
    bubble.appendChild(fileContainer);

    if (msg.content && msg.content.trim()) {
      const textContent = document.createElement("div");
      textContent.classList.add("message-content");
      textContent.style.marginTop = "8px";
      renderTextWithEmojis(textContent, msg.content);
      bubble.appendChild(textContent);
    }

  } else if (msg.type === "audio" && msg.file_url) {
    const audioBar = document.createElement("div");
    audioBar.classList.add("audio-bar");
    audioBar.innerHTML = `
      <button class="audio-play-button" type="button">
        <img src="/images/voice-play.svg" class="audio-play-icon">
        <img src="/images/voice-pause.svg" class="audio-pause-icon" style="display:none">
      </button>
      <div class="audio-waveform-container">
        <div class="audio-waveform">
          <div class="audio-progress-line"></div>
          <div class="audio-progress-bar"></div>
        </div>
        <div class="audio-time-container">
           <div class="audio-time-display">${formatAudioDuration(msg.duration || msg.audio_duration || 0)}</div>
        </div>
      </div>
      <audio src="${msg.file_url}" preload="metadata" style="display:none"></audio>
    `;

    const playBtn = audioBar.querySelector(".audio-play-button");
    const playIcon = audioBar.querySelector(".audio-play-icon");
    const pauseIcon = audioBar.querySelector(".audio-pause-icon");
    const audioEl = audioBar.querySelector("audio");
    const progressBar = audioBar.querySelector(".audio-progress-bar");
    const timeDisplay = audioBar.querySelector(".audio-time-display");
    const waveform = audioBar.querySelector(".audio-waveform");

    let duration = msg.duration || msg.audio_duration || 0;

    audioEl.addEventListener("loadedmetadata", () => {
        if (!duration || duration === 0) {
            duration = audioEl.duration;
            timeDisplay.textContent = formatAudioDuration(duration);
        }
    });

    audioEl.addEventListener("timeupdate", () => {
        const current = audioEl.currentTime;
        const total = duration || audioEl.duration || 1;
        const percent = (current / total) * 100;
        progressBar.style.width = `${percent}%`;
        timeDisplay.textContent = formatAudioDuration(current);
    });

    audioEl.addEventListener("ended", () => {
        playIcon.style.display = "";
        pauseIcon.style.display = "none";
        progressBar.style.width = "0%";
        timeDisplay.textContent = formatAudioDuration(duration);
    });

    waveform.addEventListener("click", (e) => {
        e.stopPropagation();
        const total = duration || audioEl.duration;
        if (!total) return;
        const rect = waveform.getBoundingClientRect();
        const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const percent = clickX / rect.width;
        audioEl.currentTime = percent * total;
        progressBar.style.width = `${percent * 100}%`;
    });

    playBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (audioEl.paused) {
            document.querySelectorAll(".audio-bar audio").forEach(a => {
                if (a !== audioEl) {
                    a.pause();
                    const p = a.closest('.audio-bar');
                    if (p) {
                        p.querySelector('.audio-play-icon').style.display = "";
                        p.querySelector('.audio-pause-icon').style.display = "none";
                    }
                }
            });
            audioEl.play();
            playIcon.style.display = "none";
            pauseIcon.style.display = "";
        } else {
            audioEl.pause();
            playIcon.style.display = "";
            pauseIcon.style.display = "none";
        }
    });

    bubble.appendChild(audioBar);
    bubble.classList.add("has-audio");

  } else {
    const content = document.createElement("div");
    content.classList.add("message-content");
    renderTextWithEmojis(content, msg.content || "");
    bubble.appendChild(content);
  }

  // --- Мета-данные (галочки и время) ---
  const meta = document.createElement("div");
  meta.classList.add("message-meta");
  const time = document.createElement("span");
  time.classList.add("message-timestamp");
  time.textContent = formatTime(msg.timestamp);
  meta.appendChild(time);

  if (msg.edited_at) {
    const edited = document.createElement("span");
    edited.style.fontSize = "11px";
    edited.style.color = "var(--color-text-inactive)";
    edited.textContent = "изменено";
    meta.appendChild(edited);
  }

  if (isMine) {
    const ticks = document.createElement("span");
    ticks.classList.add("message-ticks");
    const hasBeenRead = (msg.read_by || []).some((email) => email !== currentUserEmail);
    if (hasBeenRead) {
      ticks.innerHTML = `<img src="/images/read.svg" alt="Прочитано">`;
      ticks.classList.add("read");
    } else {
      ticks.innerHTML = `<img src="/images/no_read.svg" alt="Отправлено">`;
      ticks.classList.add("sent");
    }
    meta.appendChild(ticks);
  }
  bubble.appendChild(meta);

  row.appendChild(bubble);

  try {
    chatMessages.appendChild(row);
  } catch (error) {
    renderedMessageIds.delete(msg._id);
    return;
  }

  if (doScroll) {
    if (isMine) {
      scrollToBottom(true);
    } else if (!isUserAtBottom) {
      newMessagesCount++;
      updateScrollToBottomButton();
    } else {
      scrollToBottom();
    }
  }
}

// === НОВАЯ ФУНКЦИЯ: Показать/скрыть typing индикатор в чате ===
let botTypingIndicatorId = null;

function showBotTypingIndicator(chatId, botEmail) {
  // Убираем предыдущий индикатор, если есть
  hideBotTypingIndicator();

  // Проверяем, что это активный чат
  if (chatId !== activeChatId) return;

  // Проверяем, что это не наш email
  if (botEmail === currentUserEmail) return;

  // Создаем элемент typing индикатора
  const row = document.createElement("div");
  row.classList.add("message-row", "incoming");
  row.id = "bot-typing-indicator";

  const bubble = document.createElement("div");
  bubble.classList.add("message", "incoming", "typing-indicator");

  const content = document.createElement("div");
  content.classList.add("message-content", "typing-dots");
  content.innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';

  bubble.appendChild(content);
  row.appendChild(bubble);

  // Проверяем наличие chatMessages перед добавлением
  if (!chatMessages) {
    console.warn(
      "[showBotTypingIndicator] chatMessages не найден, индикатор не отображен"
    );
    return;
  }

  chatMessages.appendChild(row);

  botTypingIndicatorId = chatId;
  // Для индикатора печатания всегда прокручиваем
  scrollToBottom(true);
}

function hideBotTypingIndicator() {
  const indicator = document.getElementById("bot-typing-indicator");
  if (indicator) {
    indicator.remove();
  }
  botTypingIndicatorId = null;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function formatAudioDuration(totalSeconds) {
  // Форматирует время для аудио в формате MM:SS или HH:MM:SS для длинных записей
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const remainingM = m % 60;
  const r = s % 60;

  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(remainingM).padStart(
      2,
      "0"
    )}:${String(r).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function connectWebSocket(userEmail) {
  if (!userEmail) {
    console.error("Не удалось подключиться: userEmail не определен");
    return;
  }

  if (ws) {
    ws.onclose = null;
    ws.close();
  }

  const url = `${WS_PROTOCOL}://${location.host}/ws/${userEmail}`;
  ws = new WebSocket(url);

  ws.onclose = () => {
    console.warn("[WS] Disconnected. Reconnecting...");
    setTimeout(() => connectWebSocket(userEmail), 3000);
  };

  ws.onerror = (error) => {
    console.error("[WS] WebSocket Error:", error);
  };

  ws.onopen = () => {
    console.log("[WS] Connected as:", userEmail);
    if (callManager) {
      callManager.ws = ws;
    }
  };

  // Вспомогательная функция для надежного прибавления +1 к счетчику
  function incrementUnread(targetChatId) {
    const btn = document.querySelector(`.chat-list-item-btn[data-chat-id="${targetChatId}"]`);
    if (btn) {
      const unreadEl = btn.querySelector(".unread-count");
      let currentCount = 0;
      if (unreadEl && !unreadEl.classList.contains("hidden")) {
        currentCount = parseInt(unreadEl.textContent, 10) || 0;
      }
      setUnreadCount(targetChatId, currentCount + 1);
    }
  }

// ВОТ ЗДЕСЬ ИДЕАЛЬНЫЙ МОЗГ ВЕБСОКЕТА
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log("[WS] Получено сообщение:", data.type);

      const messageTypes = ["new_message", "text", "image", "video", "audio", "file", "system"];

      // 1. НОВОЕ СООБЩЕНИЕ
      if (messageTypes.includes(data.type)) {
        const msg = data.message || data.message_data || data;
        if (!msg) return;

        const isMine = (msg.sender_id || msg.sender_email || msg.sender) === currentUserEmail;
        const chatIdStr = String(msg.chat_id || data.chat_id);
        const activeChatIdStr = String(activeChatId);

        // Игнорируем дубли своих сообщений
        if (isMine && typeof renderedMessageIds !== 'undefined' && renderedMessageIds.has(msg._id)) {
          return;
        }

        // Превью в списке чатов
        let previewText = msg.content || "Новое сообщение";
        if (msg.type === "audio") previewText = "Голосовое сообщение";
        else if (msg.type === "image") previewText = "Фотография";
        else if (msg.type === "video") previewText = "Видео";
        else if (msg.type === "file") previewText = msg.filename || "Файл";

        updateChatPreview(chatIdStr, previewText);
        moveChatToTop(chatIdStr);

        // Логика отрисовки и счетчиков
        if (chatIdStr === activeChatIdStr) {
          if (!isMine) {
            renderMessage(msg, true, currentChatIsGroup);
          }
          // Если смотрим прямо в чат — сразу читаем
          if (!isMine && document.hasFocus()) {
            markActiveChatAsRead();
          } else if (!isMine) {
            incrementUnread(chatIdStr);
          }
        } else {
          // Чат закрыт — крутим счетчик
          if (!isMine) incrementUnread(chatIdStr);
        }
        return;
      }

// 2. ОБНОВЛЕНИЕ СЧЕТЧИКА НЕПРОЧИТАННЫХ
      if (data.type === "unread_count_update") {
        const targetChatId = String(data.chat_id);

        // ЗАЩИТА ОТ "МОРГАНИЯ": Если мы прямо сейчас смотрим в этот чат и он в фокусе,
        // мы уже всё прочитали. Игнорируем любые "запоздавшие" начисления от сервера.
        if (targetChatId === String(activeChatId) && document.hasFocus()) {
          setUnreadCount(targetChatId, 0); // Принудительно держим на нуле
          return;
        }

        setUnreadCount(targetChatId, data.count);
        return;
      }

      // 3. ПРОЧИТАНО (Смена галочек на синие)
      if (data.type === "message_read" || data.type === "messages_read") {
        setChatListTicks(data.chat_id, "read");
        if (String(data.chat_id) === String(activeChatId)) {
          const ticks = document.querySelectorAll('.message.outgoing .message-ticks');
          ticks.forEach(tick => {
            tick.innerHTML = '<img src="/images/read.svg" alt="Прочитано">';
            tick.classList.remove('sent');
            tick.classList.add('read');
          });
        }
        return;
      }

      // 4. СТАТУС "ПЕЧАТАЕТ..."
      if (data.type === "typing") {
        setTypingStatus(data.chat_id, true);
        return;
      }
      if (data.type === "stopped_typing") {
        setTypingStatus(data.chat_id, false);
        return;
      }

      // 5. ОНЛАЙН СТАТУС
      if (data.type === "user_status") {
        updateUserStatus(data.user_email, data.is_online, data.last_seen);
        return;
      }

// 6. ЗВОНКИ (ИСПРАВЛЕНО: Добавлены типы incoming_call и call_accepted)
      const callTypes = [
        "incoming_call", "call_accepted", "call_rejected", "call_ended",
        "call_offer", "call_answer", "call_ice_candidate",
        "audio_chat_created", "audio_chat_joined", "audio_chat_participant_joined",
        "audio_chat_participant_left", "audio_chat_ended", "audio_chat_offer",
        "audio_chat_answer", "audio_chat_ice_candidate"
      ];

      if (callTypes.includes(data.type)) {
        if (callManager && typeof callManager.handleWebSocketMessage === "function") {
          callManager.handleWebSocketMessage(data);
        }
        return;
      }

    } catch (error) {
      console.error("[WS] Ошибка обработки сообщения:", error);
    }
  };
}

function updateUrlForChat(chatButton) {
  if (!chatButton || !window.history || !window.location) return;

  let newUrl = "/"; // По умолчанию пустое состояние

  // Для "Избранного" всегда фиксированный URL /@favorit
  if (chatButton.dataset.isFavorite === "true") {
    newUrl = "/@favorit";
  } else {
    const interlocutorUsername = chatButton.dataset.interlocutorUsername || "";
    const interlocutorEmail = chatButton.dataset.interlocutorEmail || "";
    const isGroupChat = chatButton.dataset.isGroupChat === "true";

    // Приоритет: username > email > chat_id
    if (interlocutorUsername && !isGroupChat) {
      // Если есть username — формируем URL вида /@username
      const encoded = encodeURIComponent(interlocutorUsername);
      newUrl = `/@${encoded}`;
    } else if (interlocutorEmail && !isGroupChat) {
      // Если username нет, но есть email — используем email для URL
      const encoded = encodeURIComponent(interlocutorEmail);
      newUrl = `/${encoded}`;
    } else {
      // Для групп/ботов используем chat_id
      const chatId = chatButton.dataset.chatId || "";
      if (chatId) {
        newUrl = `/chat-${chatId}`;
      }
    }
  }

  // Обновляем URL без перезагрузки страницы (как в Telegram)
  if (window.location.pathname !== newUrl) {
    window.history.replaceState(null, "", newUrl);
    console.log("[Telegram Logic] URL обновлен на:", newUrl);
  }
}

const DEFAULT_AVATARS = [
  "/images/юзер.svg",
  "../images/юзер.svg",
  "images/юзер.svg",
  "http://localhost:8000/images/юзер.svg",
  "https://flicker.local/images/юзер.svg",
  "/static/images/юзер.svg",
  "images/user.png",
  "/images/user.png",
  "../images/user.png",
  null,
  "",
  "undefined"
];

function isDefaultAvatar(url) {
  if (!url) return true;
  if (url.includes('.svg')) return true;

  if (DEFAULT_AVATARS.includes(url)) return true;
  if (url.includes('user.png') || url.includes('default.png')) return true;
  return false;
}

function fixAvatars() {
  document.querySelectorAll(".chat-list-item-btn").forEach((btn) => {
    const img = btn.querySelector("img");
    if (img) {
      const src = img.getAttribute("src");
      const title = btn.dataset.chatName || btn.querySelector(".chat-name")?.textContent?.trim() || "Чат";
      const isGroup = btn.dataset.isGroupChat === "true" || btn.dataset.isGroup === "true";

      // ИСПРАВЛЕНИЕ: Достаем ID и почту прямо из кнопки
      const btnChatId = btn.dataset.chatId;
      const btnEmail = btn.dataset.interlocutorEmail;

      const avatarId = isGroup ? btnChatId : (btnEmail || btnChatId);

      if (isDefaultAvatar(src)) {
        img.src = generateAvatar(title, avatarId);
      }

      img.onerror = function() {
        this.onerror = null;
        this.src = generateAvatar(title, avatarId);
      };
    }
  });

  // Fix current chat header if needed
  if (window.activeChatId && window.CURRENT_CHAT_DATA && window.CURRENT_CHAT_DATA.chat_id === window.activeChatId) {
      const chatData = window.CURRENT_CHAT_DATA;
      if (isDefaultAvatar(chatData.chat_avatar)) {
          const currentChatAvatar = document.getElementById("currentChatAvatar");
          if (currentChatAvatar) {
            const isG = chatData.is_group || chatData.chat_type === "group";
            const aId = isG ? window.activeChatId : (chatData.interlocutor_email || window.activeChatId);
            const newAvatar = generateAvatar(chatData.chat_title || chatData.group_name || "Чат", aId);
            currentChatAvatar.src = newAvatar;
          }
      }
  }
}

async function ensureChatInList(chatId) {
  if (!chatListUl || !chatId) return;
  try {
    if (!window.__addingChatIds) {
      window.__addingChatIds = new Set();
    }
    if (window.__addingChatIds.has(chatId)) {
      return;
    }
    window.__addingChatIds.add(chatId);
  } catch (_) {}
  const existing = document.querySelector(
    `.chat-list-item-btn[data-chat-id="${chatId}"]`
  );
  if (existing) {
    sortChatList();
    try {
      window.__addingChatIds && window.__addingChatIds.delete(chatId);
    } catch (_) {}
    return;
  }
  try {
    const resp = await fetch(`${API_BASE_URL}/api/chat/${chatId}?limit=1&offset=0`, {
      credentials: "include",
    });
    if (!resp.ok) {
      console.warn("[ensureChatInList] Не удалось получить данные чата", chatId);
      return;
    }
    const chat = await resp.json();
    const isGroup =
      chat.chat_type === "group" ||
      chat.is_group === true;
    const title =
      chat.chat_title ||
      chat.group_name ||
      "Новый чат";
    const avatar =
      !isDefaultAvatar(chat.chat_avatar) ? chat.chat_avatar :
      !isDefaultAvatar(chat.group_avatar) ? chat.group_avatar :
      generateAvatar(title, chat.interlocutor_email || chatId);
    let lastMsgText = "Нет сообщений";
    let lastTs =
      chat.last_message_at ||
      chat.created_at ||
      new Date().toISOString();
    const msgs = Array.isArray(chat.messages) ? chat.messages : [];
    if (msgs.length > 0) {
      const m = msgs[msgs.length - 1];
      lastTs = m.timestamp || lastTs;
      if (m.type === "audio") lastMsgText = "Голосовое сообщение";
      else if (m.type === "image") lastMsgText = "Фотография";
      else if (m.type === "video") lastMsgText = "Видео";
      else if (m.type === "file") lastMsgText = m.filename || "Файл";
      else if (m.type === "system") lastMsgText = m.content || "Системное сообщение";
      else lastMsgText = m.content || "Нет сообщений";
    }
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-list-item-btn";
    btn.dataset.chatId = chatId;
    btn.dataset.chatName = title;
    btn.dataset.avatarUrl = avatar;
    btn.dataset.isGroupChat = isGroup ? "true" : "false";
    btn.dataset.isBlocked = "false";
    btn.dataset.lastTimestamp = lastTs;
    btn.dataset.lastSenderEmail = "";
    if (!isGroup && chat.interlocutor_email) {
      btn.dataset.interlocutorEmail = chat.interlocutor_email;
      btn.dataset.interlocutorUsername = chat.interlocutor_username || "";
    }
    btn.innerHTML = `
      <img src="${avatar}" alt="Chat Avatar" />
      <div class="chat-info">
        <div class="chat-name">${title}</div>
        <div class="last-message" data-chat-id="${chatId}" data-original-text="${lastMsgText}">
          ${lastMsgText}
        </div>
      </div>
      <div class="chat-meta-right">
        <span class="chat-timestamp">
          <span class="chat-list-ticks" data-chat-id="${chatId}"></span>
          <span class="chat-list-time">${formatTime(lastTs)}</span>
        </span>
      </div>
    `;
    btn.addEventListener("mouseenter", () => prefetchChat(chatId));
    btn.addEventListener("focus", () => prefetchChat(chatId));
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      document
        .querySelectorAll(".chat-list-item-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      updateUrlForChat(btn);
      await loadChat(chatId);
    });
    li.appendChild(btn);
    chatListUl.prepend(li);
    sortChatList();
  } catch (e) {
    console.warn("[ensureChatInList] Ошибка:", e);
  } finally {
    try {
      window.__addingChatIds && window.__addingChatIds.delete(chatId);
    } catch (_) {}
  }
}

// ========================================================
// === loadChat (ОБНОВЛЕН: исправление прокрутки) ===
// ========================================================

async function loadChat(chatId) {
  if (!chatId) return;

  // ОПТИМИЗАЦИЯ: Определяем renderChatData в начале функции, чтобы она была доступна
  // для использования в блоке кэша
  const renderChatData = (chatData) => {
    if (!chatData) return;

    // ОПТИМИЗАЦИЯ: Скрываем skeleton сразу при получении данных
    if (chatSkeleton) {
      chatSkeleton.classList.add("hidden");
    }

    const isGroup = chatData.is_group || chatData.chat_type === "group";
    currentChatIsGroup = isGroup;

    // Обновляем видимость кнопки подключения к аудио-чату
    if (callManager && callManager.updateAudioChatButtonVisibility) {
      callManager.updateAudioChatButtonVisibility();
    }

    currentChatParticipants = [];
    if (
      isGroup &&
      chatData.participants &&
      Array.isArray(chatData.participants)
    ) {
      for (const email of chatData.participants) {
        if (email !== currentUserEmail) {
          let displayName = email.split("@")[0];
          let username = email.split("@")[0];
          try {
            const contactsMap = window.CONTACTS_BY_EMAIL || {};
            const contactInfo = contactsMap[email];
            if (contactInfo) {
              displayName =
                contactInfo.contact_name ||
                contactInfo.display_name ||
                contactInfo.full_name ||
                contactInfo.username ||
                displayName;
              username = contactInfo.username || email.split("@")[0];
            }
          } catch (e) {}
          if (
            chatData.participants_usernames &&
            chatData.participants_usernames[email]
          ) {
            username = chatData.participants_usernames[email];
          }
          username = (username || "").trim().replace(/^@+/, "");

          currentChatParticipants.push({
            email: email,
            name: displayName,
            username: username,
          });
        }
      }
    }

    currentChatTitle.textContent = chatData.chat_title || "Чат";
    if (chatData.interlocutor_username) {
      document.title = chatData.interlocutor_username;
    } else {
      document.title = "";
    }

// === ИСПРАВЛЕНИЕ: Правильная генерация аватарки для группы ===
    const actualTitle = chatData.chat_title || chatData.group_name || "Чат";
    // Для групп мы НЕ должны использовать interlocutor_email, иначе сгенерируется аватарка создателя!
    const avatarId = isGroup ? chatId : (chatData.interlocutor_email || chatId);

    let validAvatar = (!isDefaultAvatar(chatData.chat_avatar)) ? chatData.chat_avatar : null;
    if (isGroup && !validAvatar && !isDefaultAvatar(chatData.group_avatar)) {
        validAvatar = chatData.group_avatar;
    }

    const avatarUrl = validAvatar ? validAvatar : generateAvatar(actualTitle, avatarId);

    currentChatAvatar.src = avatarUrl;
    currentChatAvatar.onerror = function () {
      this.src = generateAvatar(actualTitle, avatarId);
    };
    currentChatAvatar.onload = function () {
      this.style.display = "block";
    };

    updatePinnedMessage(chatData.pinned_message_id, chatData.pinned_message);

    const chatButton = document.querySelector(
      `.chat-list-item-btn[data-chat-id="${chatId}"]`
    );
    let isOnline = false;
    let lastSeen = "";
    let isBot = chatData.is_bot || false;
    const isFavorite = !!chatData.is_favorite;

    if (chatButton) {
      isOnline = chatButton.dataset.isOnline === "true";
      lastSeen = chatButton.dataset.lastSeen || "";
      if (chatData.is_bot) {
        isBot = true;
        lastSeen = "bot";
      }
    }

    if (isBot) {
      currentChatStatus.textContent = "бот";
      currentChatStatus.dataset.originalText = "бот";
      // Скрываем кнопки звонка для ботов
      const chatCallBtn = document.getElementById("chatCallBtn");
      if (chatCallBtn) chatCallBtn.style.display = "none";
    } else if (isFavorite) {
      currentChatStatus.textContent = "";
      currentChatStatus.dataset.originalText = "";
      // Возвращаем кнопки звонка для остальных
      const chatCallBtn = document.getElementById("chatCallBtn");
      if (chatCallBtn) chatCallBtn.style.display = "block";
    } else if (isGroup) {
      currentChatStatus.textContent = "";
      currentChatStatus.dataset.originalText = "";
      // Для групп показываем звонок (аудио-чат)
      const chatCallBtn = document.getElementById("chatCallBtn");
      if (chatCallBtn) chatCallBtn.style.display = "block";
    } else {
      const originalStatus = formatLastSeen(lastSeen, isOnline);
      if (originalStatus) {
        currentChatStatus.textContent = originalStatus;
        currentChatStatus.dataset.originalText = originalStatus;
        currentChatStatus.style.display = "block";
      } else {
        currentChatStatus.textContent = "";
        currentChatStatus.dataset.originalText = "";
        currentChatStatus.style.display = "none";
      }
      // Возвращаем кнопки звонка для обычных чатов
      const chatCallBtn = document.getElementById("chatCallBtn");
      if (chatCallBtn) chatCallBtn.style.display = "block";
    }

    const groupSettingsMenuItem = document.getElementById(
      "groupSettingsMenuItem"
    );

    if (isGroup) {
      if (groupSettingsMenuItem) {
        groupSettingsMenuItem.style.display = "block";
      }
    } else {
      if (groupSettingsMenuItem) {
        groupSettingsMenuItem.style.display = "none";
      }
    }

    // === ИСПРАВЛЕНИЕ: ЖЕСТКАЯ ОЧИСТКА КЭША И DOM ===
    if (typeof renderedMessageIds !== 'undefined') {
      renderedMessageIds.clear();
    }
    if (chatMessages) {
      chatMessages.innerHTML = "";
    }

    const messages = chatData.messages || [];

    if (noMessagesState) {
      if (messages.length === 0) {
        noMessagesState.classList.remove("hidden");
        if (chatMessages) chatMessages.classList.add("hidden");
      } else {
        noMessagesState.classList.add("hidden");
        if (chatMessages) chatMessages.classList.remove("hidden");
      }
    }

    if (!chatMessages) {
      console.error(
        "[loadChat] chatMessages не найден, сообщения не могут быть отображены"
      );
      return;
    }

    // === ИСПРАВЛЕНИЕ: ЕЩЕ РАЗ СБРАСЫВАЕМ КЭШ ПРЯМО ПЕРЕД РЕНДЕРОМ ЦИКЛА ===
    if (typeof renderedMessageIds !== 'undefined') {
      renderedMessageIds.clear();
    }

    if (noMessagesState) {
      if (messages.length === 0) {
        noMessagesState.classList.remove("hidden");
        if (chatMessages) chatMessages.classList.add("hidden");
      } else {
        noMessagesState.classList.add("hidden");
        if (chatMessages) chatMessages.classList.remove("hidden");
      }
    }

    // Убеждаемся, что chatMessages доступен перед рендерингом
    if (!chatMessages) {
      console.error(
        "[loadChat] chatMessages не найден, сообщения не могут быть отображены"
      );
      return;
    }

    // Проверяем наличие активного аудио-чата в сообщениях
    let activeAudioChatRoomId = null;
    let audioChatCreatorData = null;

    messages.forEach((msg) => {
      if (!msg || !msg._id) return;

      // Проверяем системное сообщение о создании аудио-чата
      if (
        msg.type === "system" &&
        msg.audio_chat_created &&
        msg.audio_room_id
      ) {
        activeAudioChatRoomId = msg.audio_room_id;
        audioChatCreatorData = {
          creator_email: msg.creator_email,
          creator_name: msg.creator_name,
          creator_avatar: msg.creator_avatar,
        };
      }

      // Рендерим сообщение
      try {
        renderMessage(msg, false, isGroup, true);
      } catch (error) {
        console.error(
          "[loadChat] Ошибка при рендеринге сообщения:",
          msg._id,
          error
        );
        renderedMessageIds.delete(msg._id);
      }
    });

    // === ОПТИМИЗАЦИЯ: Проверка активного аудио-чата из API ответа ===
    if (chatData.active_audio_chat && activeChatId === chatId && callManager) {
      const audioChat = chatData.active_audio_chat;
      const isUserInChat =
        callManager.currentAudioChat &&
        callManager.currentAudioChat.audio_room_id === audioChat.audio_room_id;

      if (!isUserInChat) {
        callManager.pendingAudioChat = {
          audio_room_id: audioChat.audio_room_id,
          chat_id: chatId,
          creator: audioChat.creator,
          creator_name: audioChat.creator_name,
          creator_avatar: audioChat.creator_avatar,
          participants: audioChat.participants || [],
        };
        callManager.showAudioChatBanner(callManager.pendingAudioChat);
        callManager.updateAudioChatButtonVisibility();
      }
    }
    // Fallback: проверка через сообщения
    else if (activeAudioChatRoomId && activeChatId === chatId && callManager) {
      const hasEndMessage = messages.some(
        (msg) =>
          msg.type === "system" &&
          msg.audio_chat_ended &&
          msg.audio_room_id === activeAudioChatRoomId &&
          new Date(msg.timestamp) >
            new Date(
              messages.find(
                (m) =>
                  m.audio_room_id === activeAudioChatRoomId &&
                  m.audio_chat_created
              )?.timestamp || 0
            )
      );

      if (!hasEndMessage && audioChatCreatorData) {
        callManager.pendingAudioChat = {
          audio_room_id: activeAudioChatRoomId,
          chat_id: chatId,
          creator: audioChatCreatorData.creator_email,
          creator_name: audioChatCreatorData.creator_name,
          creator_avatar: audioChatCreatorData.creator_avatar,
          participants: [],
        };
        callManager.showAudioChatBanner(callManager.pendingAudioChat);
        callManager.updateAudioChatButtonVisibility();
      }
    }

    isUserAtBottom = true;
    newMessagesCount = 0;
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: "auto" });
    setTimeout(() => {
      checkIfUserAtBottom();
    }, 100);

    if (profileSection && !profileSection.classList.contains("hidden")) {
      const chatButton = document.querySelector(
        `.chat-list-item-btn[data-chat-id="${chatId}"]`
      );
      if (chatButton) {
        const interlocutorEmail = chatButton.dataset.interlocutorEmail;
        if (interlocutorEmail) {
          openProfileModal(interlocutorEmail);
        }
      }
    }

    window.CURRENT_CHAT_DATA = chatData;

    if (!ws) {
      connectWebSocket(currentUserEmail);
    }

    if (avatarContainer) {
      avatarContainer.dataset.chatId = chatId;
      avatarContainer.dataset.chatTitle = actualTitle;
      avatarContainer.dataset.chatAvatar = avatarUrl; // Используем уже проверенный безопасный url
    }

    updateBlockButtons(chatData.is_blocked || null);

    if (isChatOpenedFromUrl) {
      protectChatFromClosing();
    }

    restoreScrollPosition(chatId);

    if (isChatOpenedFromUrl) {
      protectChatFromClosing();
    }

    restoreScrollPosition(chatId);

    // === ИСПРАВЛЕНИЕ: СБРАСЫВАЕМ СЧЕТЧИК ПРИ ОТКРЫТИИ ЧАТА ===
    if (document.hasFocus()) {
      markActiveChatAsRead();
    }
  };

  // ОПТИМИЗАЦИЯ: Сначала проверяем кэш для мгновенной загрузки
  const cachedData = await readCachedChat(chatId);
  if (cachedData) {
    // Используем кэшированные данные для мгновенного отображения
    console.log(
      `[loadChat] Используем кэш для мгновенной загрузки чата ${chatId}`
    );

    // ВАЖНО: Устанавливаем все необходимые переменные и состояния
    // Сохраняем черновик предыдущего чата
    if (activeChatId && activeChatId !== chatId && messageInput) {
      const currentDraft = messageInput.value.trim();
      if (currentDraft) {
        saveDraft(activeChatId, currentDraft);
      } else {
        clearDraft(activeChatId);
      }
    }

    // Очищаем renderedMessageIds
    renderedMessageIds.clear();

    // Устанавливаем activeChatId
    activeChatId = chatId;
    window.activeChatId = chatId;

    // Скрываем баннер аудио-чата если он не относится к новому чату
    if (callManager && callManager.pendingAudioChat) {
      if (callManager.pendingAudioChat.chat_id !== chatId) {
        callManager.hideAudioChatBanner();
      }
    }

    // Обновляем видимость кнопки подключения к аудио-чату
    if (callManager && callManager.updateAudioChatButtonVisibility) {
      callManager.updateAudioChatButtonVisibility();
    }

    // Показываем окно чата и скрываем пустое состояние
    if (chatWindow) {
      chatWindow.classList.remove("hidden");
      chatWindow.style.display = "";
      chatWindow.style.visibility = "visible";
      chatWindow.style.opacity = "1";
    }
    if (chatEmptyState) {
      chatEmptyState.classList.add("hidden");
      chatEmptyState.style.display = "none";
    }

    // Рендерим данные из кэша
    renderChatData(cachedData);

    // Загружаем свежие данные в фоне (не блокируем UI)
    fetch(`${API_BASE_URL}/api/chat/${chatId}?limit=50&offset=0`, {
      credentials: "include",
    })
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((data) => {
        if (data && activeChatId === chatId) {
          writeCachedChat(chatId, data);
          // Обновляем только если чат все еще открыт
          renderChatData(data);
        }
      })
      .catch((err) => console.warn("[loadChat] Ошибка фоновой загрузки:", err));

    return; // Выходим, используя кэш
  }

  showChatSkeleton();

  // ВАЖНО: Сразу показываем окно чата и скрываем пустое состояние
  // Это гарантирует, что переписка будет видна даже если загрузка данных займет время
  if (chatWindow) {
    chatWindow.classList.remove("hidden");
    chatWindow.style.display = "";
    chatWindow.style.visibility = "visible";
    chatWindow.style.opacity = "1";
  }
  if (chatEmptyState) {
    chatEmptyState.classList.add("hidden");
    chatEmptyState.style.display = "none";
  }

  // Сохраняем черновик предыдущего чата перед переключением
  if (activeChatId && activeChatId !== chatId && messageInput) {
    const currentDraft = messageInput.value.trim();
    if (currentDraft) {
      saveDraft(activeChatId, currentDraft);
    } else {
      clearDraft(activeChatId);
    }
  }

  // ВАЖНО: Очищаем renderedMessageIds ПЕРЕД установкой activeChatId,
  // чтобы WebSocket сообщения, пришедшие во время загрузки, не были пропущены
  renderedMessageIds.clear();

  activeChatId = chatId;
  window.activeChatId = chatId; // Обновляем глобальную переменную

  // ОПТИМИЗАЦИЯ: Скрываем баннер аудио-чата если он не относится к новому чату
  // Но не удаляем pendingAudioChat, так как он может быть нужен для другого чата
  if (callManager && callManager.pendingAudioChat) {
    if (callManager.pendingAudioChat.chat_id !== chatId) {
      callManager.hideAudioChatBanner();
      // НЕ удаляем pendingAudioChat, он будет проверен при загрузке данных чата через API
    }
  }

  // Обновляем видимость кнопки подключения к аудио-чату при смене чата
  if (callManager && callManager.updateAudioChatButtonVisibility) {
    // Небольшая задержка, чтобы currentChatIsGroup успел обновиться
    setTimeout(() => {
      callManager.updateAudioChatButtonVisibility();
    }, 100);
  }

  // Запоминаем последний открытый чат в localStorage,
  // чтобы после полной перезагрузки вернуться сразу в него
  try {
    localStorage.setItem("last_active_chat_id", String(chatId));
  } catch (e) {
    console.warn("Не удалось сохранить last_active_chat_id в localStorage:", e);
  }

  // Очищаем DOM только если chatMessages существует
  if (chatMessages) {
    chatMessages.innerHTML = "";
  } else {
    console.warn("[loadChat] chatMessages не найден при очистке");
  }

  // Сбрасываем состояние прокрутки при смене чата
  isUserAtBottom = true;
  newMessagesCount = 0;
  if (scrollToBottomBtn) scrollToBottomBtn.classList.add("hidden");
  if (newMessagesCountEl) newMessagesCountEl.classList.add("hidden");

  // сбрасываем поиск по чату при переключении
  closeChatSearch();

  // Загружаем черновик для нового чата
  if (messageInput) {
    const draft = loadDraft(chatId);
    messageInput.value = draft;
    toggleSendButton();
  }

  // Обработчики профиля установлены глобально на document, дополнительная установка не требуется

  // Сброс статуса "Печатает..." при смене чата
  if (
    currentChatStatus &&
    currentChatStatus.classList.contains("typing-status")
  ) {
    currentChatStatus.textContent =
      currentChatStatus.dataset.originalText || "";
    currentChatStatus.classList.remove("typing-status");
  }

  // Убираем typing индикатор бота при смене чата
  hideBotTypingIndicator();

  try {
    // Если дошли сюда, значит кэша не было - загружаем свежие данные
    const fresh = await prefetchChat(chatId);
    if (fresh) {
      console.log("[loadChat] Свежие данные получены:", fresh);
      console.log(
        "[loadChat] Количество сообщений в свежих данных:",
        (fresh.messages || []).length
      );
      renderChatData(fresh);
      writeCachedChat(chatId, fresh);

      // ВАЖНО: После загрузки свежих данных ВСЕГДА проверяем актуальное состояние блокировки с сервера
      // Это гарантирует, что состояние блокировки будет восстановлено после перезагрузки страницы
      if (!currentChatIsGroup && fresh.interlocutor_email) {
        // Небольшая задержка, чтобы UI успел обновиться перед запросом статуса
        setTimeout(() => {
          refreshBlockStatus();
        }, 150);
      }
    } else {
      console.warn(
        "[loadChat] Не удалось получить свежие данные для чата:",
        chatId
      );
      // Если не удалось загрузить свежие данные, но есть кэш и это личный чат, проверяем статус блокировки
      if (cached && !currentChatIsGroup && cached.interlocutor_email) {
        setTimeout(() => {
          refreshBlockStatus();
        }, 150);
      }
    }
  } catch (err) {
    console.error("Ошибка загрузки чата:", err);
    if (isChatOpenedFromUrl && chatWindow) {
      chatWindow.classList.remove("hidden");
      chatWindow.style.display = "";
      chatWindow.style.visibility = "visible";
      chatWindow.style.opacity = "1";
    }
    if (isChatOpenedFromUrl && chatEmptyState) {
      chatEmptyState.classList.add("hidden");
      chatEmptyState.style.display = "none";
    }
  } finally {
    hideChatSkeleton();
  }
}

// Экспортируем loadChat в window для использования в других модулях
window.loadChat = loadChat;
window.renderMessage = renderMessage;

// Предзагрузка по hover/focus списка чатов
document.querySelectorAll(".chat-list-item-btn").forEach((btn) => {
  const cid = btn.dataset.chatId;
  btn.addEventListener("mouseenter", () => prefetchChat(cid));
  btn.addEventListener("focus", () => prefetchChat(cid));
});

document.querySelectorAll(".last-message").forEach((el) => {
  if (el.classList.contains("typing-status")) return;
  const originalText = el.dataset.originalText || el.textContent || "";
  if (!originalText) return;
  el.textContent = "";
  renderTextWithEmojis(el, originalText, true);
});

// ===========================
// === БЛОКИРОВКА ПОЛЬЗОВАТЕЛЯ В ЧАТЕ ===
// ===========================

/**
 * Обновляет UI в зависимости от состояния блокировки в текущем чате.
 * blockState:
 *   - null/undefined  — блокировок нет
 *   - { blocked_by_me: bool, blocked_me: bool }
 */
function updateBlockButtons(blockState) {
  const hasState = !!blockState;
  const blockedByMe =
    hasState &&
    (blockState.blocked_by_me === true ||
      blockState.user_view_blocked === true);
  const blockedMe =
    hasState &&
    (blockState.blocked_me === true || blockState.other_view_blocked === true);

  // Блокировка доступна ТОЛЬКО в личных чатах (в группах — отключена полностью)
  if (
    currentChatIsGroup === true ||
    window.CURRENT_CHAT_DATA?.is_group === true ||
    window.CURRENT_CHAT_DATA?.chat_type === "group"
  ) {
    if (chatUnblockContainer) chatUnblockContainer.classList.add("hidden");
    if (messageForm) messageForm.style.display = "";
    if (messageInput) {
      messageInput.disabled = false;
      // восстанавливаем placeholder на всякий случай
      messageInput.placeholder =
        messageInput.dataset.originalPlaceholder || messageInput.placeholder;
    }
    if (blockUserBtn) {
      blockUserBtn.style.display = "none";
      blockUserBtn.textContent = "Заблокировать";
    }
    window.CURRENT_CHAT_BLOCK_STATE = { blockedByMe: false, blockedMe: false };
    return;
  } else {
    // В личных чатах пункт меню должен быть видимым
    if (blockUserBtn) blockUserBtn.style.display = "";
  }

  // Если нет активного чата или собеседника, сбрасываем UI
  if (
    !window.CURRENT_CHAT_DATA ||
    !window.CURRENT_CHAT_DATA.interlocutor_email
  ) {
    if (chatUnblockContainer) chatUnblockContainer.classList.add("hidden");
    if (messageForm) messageForm.style.display = "";
    if (messageInput) {
      messageInput.disabled = false;
    }
    if (blockUserBtn) {
      blockUserBtn.textContent = "Заблокировать";
    }
    return;
  }

  // Я заблокировал собеседника: прячем поле ввода, показываем кнопку "Разблокировать" в шапке
  if (blockedByMe) {
    if (messageForm) {
      messageForm.style.display = "none";
    }
    if (chatUnblockContainer) {
      chatUnblockContainer.classList.remove("hidden");
    }
    if (messageInput) {
      messageInput.disabled = true;
      messageInput.value = "";
    }
    if (blockUserBtn) {
      blockUserBtn.textContent = "Разблокировать";
    }
  } else {
    // Я не блокирую собеседника
    if (chatUnblockContainer) {
      chatUnblockContainer.classList.add("hidden");
    }
    if (messageForm) {
      messageForm.style.display = "";
    }
    if (messageInput) {
      messageInput.disabled = false;
    }
    if (blockUserBtn) {
      blockUserBtn.textContent = "Заблокировать";
    }
  }

  // Если собеседник заблокировал меня — не даём отправлять сообщения
  if (blockedMe && !blockedByMe) {
    if (messageForm) {
      messageForm.style.display = "";
    }
    if (messageInput) {
      messageInput.disabled = true;
      messageInput.placeholder =
        "Вы не можете отправлять сообщения: пользователь вас заблокировал";
    }
    if (chatUnblockContainer) {
      chatUnblockContainer.classList.add("hidden");
    }
  } else if (!blockedByMe && messageInput) {
    // Восстанавливаем placeholder, если блокировка снята
    messageInput.placeholder =
      messageInput.dataset.originalPlaceholder || messageInput.placeholder;
  }

  window.CURRENT_CHAT_BLOCK_STATE = { blockedByMe, blockedMe };
}

async function refreshBlockStatus() {
  if (!activeChatId || !window.CURRENT_CHAT_DATA?.interlocutor_email) return;
  if (currentChatIsGroup) return;

  try {
    const resp = await fetch(`${API_BASE_URL}/api/check_block_status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        user_id: window.CURRENT_CHAT_DATA.interlocutor_email,
        chat_id: activeChatId,
      }),
    });
    if (!resp.ok) {
      console.warn(
        "Не удалось получить статус блокировки для чата",
        activeChatId
      );
      return;
    }
    const data = await resp.json();
    const state = {
      blocked_by_me: !!data.user_view_blocked,
      blocked_me: !!data.other_view_blocked,
      // Добавляем поля для совместимости с форматом сервера
      user_view_blocked: !!data.user_view_blocked,
      other_view_blocked: !!data.other_view_blocked,
    };
    console.log("[refreshBlockStatus] Обновляем состояние блокировки:", state);
    updateBlockButtons(state);
  } catch (e) {
    console.warn("Ошибка обновления статуса блокировки:", e);
  }
}

if (blockUserBtn) {
  blockUserBtn.addEventListener("click", async () => {
    if (!activeChatId || !window.CURRENT_CHAT_DATA?.interlocutor_email) return;
    if (currentChatIsGroup) return;

    const currentState = window.CURRENT_CHAT_BLOCK_STATE || {};
    const alreadyBlocked = !!currentState.blockedByMe;
    const url = alreadyBlocked
      ? `${API_BASE_URL}/api/unblock_user`
      : `${API_BASE_URL}/api/block_user`;

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          user_id: window.CURRENT_CHAT_DATA.interlocutor_email,
          chat_id: activeChatId,
        }),
      });
      if (!resp.ok) {
        let msg = "Не удалось изменить состояние блокировки";
        try {
          const err = await resp.json();
          if (err?.detail) msg = err.detail;
        } catch (_) {}
        alert(msg);
        return;
      }

      await refreshBlockStatus();
    } catch (e) {
      console.error("Ошибка при изменении блокировки:", e);
      alert("Не удалось изменить состояние блокировки");
    }
  });
}

if (unblockUserBtn) {
  unblockUserBtn.addEventListener("click", async () => {
    if (!activeChatId || !window.CURRENT_CHAT_DATA?.interlocutor_email) return;
    if (currentChatIsGroup) return;
    try {
      const resp = await fetch(`${API_BASE_URL}/api/unblock_user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          user_id: window.CURRENT_CHAT_DATA.interlocutor_email,
          chat_id: activeChatId,
        }),
      });
      if (!resp.ok) {
        let msg = "Не удалось разблокировать пользователя";
        try {
          const err = await resp.json();
          if (err?.detail) msg = err.detail;
        } catch (_) {}
        alert(msg);
        return;
      }
      await refreshBlockStatus();
    } catch (e) {
      console.error("Ошибка при разблокировке:", e);
      alert("Не удалось разблокировать пользователя");
    }
  });
}

// ===========================
// === Отправка сообщений (без изменений) ===
// ===========================

// ===========================
// === Отправка сообщений ===
// ===========================

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeChatId) {
    console.warn("Не выбран активный чат, activeChatId:", activeChatId);
    return;
  }
  const text = messageInput.value.trim();
  if (!text) return;

  console.log("Отправка сообщения в чат:", activeChatId, "Текст:", text);

  // Очищаем черновик при отправке
  clearDraft(activeChatId);

  // 1. ЕСЛИ РЕДАКТИРУЕМ СООБЩЕНИЕ
  if (editingMessageId) {
    try {
      const fd = new FormData();
      fd.append("new_content", text);
      const response = await fetch(
        `${API_BASE_URL}/api/edit_message/${editingMessageId}`,
        {
          method: "PUT",
          body: fd,
        }
      );

      if (!response.ok) {
        throw new Error("Ошибка редактирования сообщения");
      }

      // Локально обновляем текст для скорости (Optimistic UI)
      const msgEl = document.querySelector(`.message[data-message-id="${editingMessageId}"]`);
      if (msgEl) {
        const contentEl = msgEl.querySelector(".message-content");
        if (contentEl) {
          contentEl.innerHTML = "";
          renderTextWithEmojis(contentEl, text);
        }
        if (!msgEl.querySelector(".message-edited")) {
          const editedLabel = document.createElement("span");
          editedLabel.classList.add("message-edited");
          editedLabel.style.fontSize = "11px";
          editedLabel.style.color = "var(--color-text-inactive)";
          editedLabel.textContent = "изменено";
          const meta = msgEl.querySelector(".message-meta");
          if (meta) meta.appendChild(editedLabel);
        }
      }
    } catch (err) {
      console.error("Ошибка при редактировании:", err);
    }

    editingMessageId = null;
    replyingToMessage = null;
    hideReplyPreview();
    messageInput.value = "";
    toggleSendButton();
    updateInputState();
    syncMessageInputVisual();
    return; // Завершаем функцию, чтобы не отправить как новое сообщение!
  }

  // 2. ОБЫЧНАЯ ОТПРАВКА СООБЩЕНИЯ
  messageInput.value = "";
  toggleSendButton();
  syncMessageInputVisual();
  updateChatPreview(activeChatId, text);
  moveChatToTop(activeChatId);

  const submitBtn = document.querySelector(
    `.chat-list-item-btn[data-chat-id="${activeChatId}"]`
  );
  if (submitBtn) submitBtn.dataset.lastSenderEmail = currentUserEmail;
  setChatListTicks(activeChatId, "sent");

  // Извлекаем упоминания из текста
  const mentions = extractMentions(text);

  const fd = new FormData();
  fd.append("message_content", text);
  if (replyingToMessage) {
    fd.append("reply_to_id", replyingToMessage._id);
  }
  if (mentions.length > 0) {
    fd.append("mentions", JSON.stringify(mentions));
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/api/send_message/${activeChatId}`,
      {
        method: "POST",
        body: fd,
      }
    );

    if (!response.ok) {
      console.error("Ошибка отправки, ставим 'sent' по умолчанию");
      setChatListTicks(activeChatId, "sent");
      throw new Error("Ошибка отправки сообщения");
    }

    const result = await response.json();
    const realMsg = result.message_data || result.message;

    if (realMsg) {
      const existingReal = document.getElementById(`msg-${realMsg._id}`);
      // Если сокет еще не успел это отрисовать, рисуем сами
      if (!existingReal) {
        console.log("[ОТПРАВКА] Отрисовываем своё сообщение мгновенно");
        renderMessage(realMsg, true, currentChatIsGroup);
        if (typeof renderedMessageIds !== 'undefined') {
          renderedMessageIds.add(realMsg._id);
        }
      }
    }

    replyingToMessage = null;
    hideReplyPreview();
  } catch (err) {
    console.error("Ошибка при отправке:", err);
  }

  // Закрываем панель эмодзи при отправке
  const emojiPicker = document.getElementById("emojiPicker");
  if (emojiPicker) {
    emojiPicker.classList.add("hidden");
  }

  // Обновляем состояние кнопок
  updateInputState();
});

// -----------------------------
// === ПРЕДПРОСМОТР И ОТПРАВКА ===
// -----------------------------
// Вставьте этот блок рядом с существующими функциями (например после sendFile или вверху initAttachmentHandlers)
// (1) Обновлённая sendFile: принимает необязательный caption
async function sendFile(file, chatId, caption = "") {
    if (!chatId || !file) {
      console.error("Не указан chatId или файл");
      if (!chatId) alert("Пожалуйста, выберите чат для отправки файла");
      return;
    }
    // Ограничение размера файла убрано по запросу
    // const maxSize = 50 * 1024 * 1024; // 50 МБ

  try {
    const xhr = new XMLHttpRequest(); // Создаем заранее

    // 1. Создаем временное сообщение для отображения прогресса
    const tempId = "temp_" + Date.now();
    
    // Создаем Blob URL для предпросмотра
    const blobUrl = URL.createObjectURL(file);

    const tempMsg = {
      xhr: xhr,
      _id: tempId,
      sender_id: currentUserEmail,
      content: caption || "",
      timestamp: new Date().toISOString(),
      type: "file", // Пока считаем файлом, уточним позже
      file_url: blobUrl,
      filename: file.name,
      file_size: file.size, // Добавляем размер
      is_uploading: true,   // Флаг загрузки
      upload_progress: 0    // Прогресс
    };
    
    // Определяем тип заранее для красивого отображения
    if (file.type.startsWith("image/")) tempMsg.type = "image";
    else if (file.type.startsWith("video/")) tempMsg.type = "video";

    // Добавляем во временный список (если есть) или просто рендерим
    // В данном коде мы просто добавим в DOM
    const chatMessages = document.querySelector(".chat-messages");
    if (chatMessages) {
        renderMessage(tempMsg, true, false); 
        // Найдем только что созданный элемент и сохраним ссылку
        // (Это упрощенно, в идеале лучше иметь state manager)
    }

    const formData = new FormData();
    formData.append("file", file);
    if (caption && caption.trim())
      formData.append("message_content", caption.trim());
    if (replyingToMessage)
      formData.append("reply_to_id", replyingToMessage._id);

    // Используем XHR для отслеживания прогресса
    // const xhr уже создан выше
    xhr.open("POST", `${API_BASE_URL}/api/send_message/${chatId}`, true);

    xhr.onabort = () => {
       const msgElement = document.getElementById(`msg-${tempId}`);
       if (msgElement) msgElement.remove();
       URL.revokeObjectURL(blobUrl);
       console.log("Загрузка отменена пользователем");
    };
    
    // Слушатель прогресса
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percentComplete = (event.loaded / event.total) * 100;
        // Находим сообщение в DOM и обновляем прогресс
        const msgElement = document.getElementById(`msg-${tempId}`);
        if (msgElement) {
            const progressBar = msgElement.querySelector(".file-progress-bar");
            const metaDiv = msgElement.querySelector(".file-meta");
            const uploadText = msgElement.querySelector(".upload-text"); // For media
            
            if (progressBar) {
                progressBar.style.width = `${percentComplete}%`;
                if (progressBar.parentElement) progressBar.parentElement.style.display = "block";
            }
            
            const progressText = `${formatFileSize(event.loaded)} / ${formatFileSize(event.total)}`;
            
            if (metaDiv) {
                metaDiv.textContent = progressText;
            }
            
            if (uploadText) {
                 uploadText.textContent = `${Math.round(percentComplete)}% (${progressText})`;
            }
        }
      }
    };

    xhr.onload = async () => {
      URL.revokeObjectURL(blobUrl);
      if (xhr.status >= 200 && xhr.status < 300) {
        const result = JSON.parse(xhr.responseText);
        console.log("Файл успешно отправлен:", result);
        
        // Получаем реальные данные сообщения
        const realMsg = result.message_data;
        const realId = realMsg._id;
        
        // Удаляем временное сообщение И рендерим настоящее
        // Это предотвращает дублирование и обеспечивает правильный UI (кнопки и т.д.)
        const tempMsgElement = document.getElementById(`msg-${tempId}`);
        if (tempMsgElement) tempMsgElement.remove();
        
        // Проверяем, не отрисовано ли уже реальное сообщение (через сокет)
        const existingReal = document.getElementById(`msg-${realId}`);
        if (!existingReal) {
             // Если сокет еще не пришел/не отрисовал, рендерим сами
             renderMessage(realMsg, true, false);
             // Добавляем в Set, чтобы сокет не дублировал
             if (typeof renderedMessageIds !== 'undefined') {
                 renderedMessageIds.add(realId);
             }
        }

        // Обновляем preview списка чатов
        let previewText = file.name || "Файл";
        if (file.type && file.type.startsWith("image/")) previewText = "Фотография";
        else if (file.type && file.type.startsWith("video/")) previewText = "Видео";

        updateChatPreview(chatId, previewText);
        moveChatToTop(chatId);

        const submitBtn = document.querySelector(
          `.chat-list-item-btn[data-chat-id="${chatId}"]`
        );
        if (submitBtn) submitBtn.dataset.lastSenderEmail = currentUserEmail;
        setChatListTicks(chatId, "sent");

        messageInput.value = "";
        toggleSendButton();
        updateInputState();
        attachmentMenu.classList.add("hidden");
      } else {
        const msgElement = document.getElementById(`msg-${tempId}`);
        if (msgElement) msgElement.remove();
        console.error("Ошибка при отправке файла:", xhr.statusText);
        alert(`Не удалось отправить файл: ${xhr.statusText}`);
      }
    };

    xhr.onerror = () => {
       URL.revokeObjectURL(blobUrl);
       const msgElement = document.getElementById(`msg-${tempId}`);
       if (msgElement) msgElement.remove();
       console.error("Ошибка сети при отправке файла");
       alert("Ошибка сети при отправке файла");
    };

    xhr.send(formData);

  } catch (error) {
    console.error("Ошибка при отправке файла:", error);
    alert(`Не удалось отправить файл: ${error.message}`);
  }
}

// (2) Функция, создающая модалку предпросмотра (single/multiple)
function openFilePreviewModal(files) {
  if (!files || files.length === 0) return;

  // Создаём затемнённый фон
  const overlay = document.createElement("div");
  overlay.className = "file-preview-overlay";
  overlay.style.position = "fixed";
  overlay.style.left = 0;
  overlay.style.top = 0;
  overlay.style.width = "100%";
  overlay.style.height = "100%";
  overlay.style.background = "rgba(0,0,0,0.6)";
  overlay.style.zIndex = 11000;
  overlay.style.display = "flex";
  overlay.style.justifyContent = "center";
  overlay.style.alignItems = "center";
  overlay.style.padding = "20px";

  // Контейнер модалки
  const modal = document.createElement("div");
  modal.className = "file-preview-modal";
  modal.style.maxWidth = "920px";
  modal.style.width = "100%";
  modal.style.maxHeight = "90vh";
  modal.style.overflow = "auto";
  modal.style.background = "var(--color-surface, #fff)";
  modal.style.borderRadius = "12px";
  modal.style.padding = "16px";
  modal.style.boxShadow = "0 10px 40px rgba(0,0,0,0.4)";

  // Заголовок + кнопка закрыть
  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";
  header.style.marginBottom = "12px";
  const h = document.createElement("h3");
  h.textContent =
    files.length > 1
      ? `Отправить ${files.length} файлов`
      : "Предпросмотр файла";
  h.style.margin = 0;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.style.fontSize = "22px";
  closeBtn.style.border = "none";
  closeBtn.style.background = "transparent";
  closeBtn.style.cursor = "pointer";
  header.appendChild(h);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Список превью
  const list = document.createElement("div");
  list.style.display = "grid";
  list.style.gridTemplateColumns = "1fr";
  list.style.gap = "12px";

  const fileItems = []; // { file, captionInput }

  files.forEach((file, idx) => {
    const item = document.createElement("div");
    item.style.display = "flex";
    item.style.gap = "12px";
    item.style.alignItems = "flex-start";
    item.style.padding = "8px";
    item.style.border = "1px solid rgba(0,0,0,0.06)";
    item.style.borderRadius = "8px";

    const previewWrap = document.createElement("div");
    previewWrap.style.width = "160px";
    previewWrap.style.flex = "0 0 160px";
    previewWrap.style.maxHeight = "120px";
    previewWrap.style.display = "flex";
    previewWrap.style.alignItems = "center";
    previewWrap.style.justifyContent = "center";
    previewWrap.style.overflow = "hidden";
    previewWrap.style.borderRadius = "8px";
    previewWrap.style.background = "rgba(0,0,0,0.03)";

    // Рендер превью в зависимости от типа
    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.style.maxWidth = "100%";
      img.style.maxHeight = "120px";
      img.style.objectFit = "cover";
      img.src = URL.createObjectURL(file);
      previewWrap.appendChild(img);
    } else if (file.type.startsWith("video/")) {
      const vid = document.createElement("video");
      vid.style.maxWidth = "100%";
      vid.style.maxHeight = "120px";
      vid.src = URL.createObjectURL(file);
      vid.controls = true;
      previewWrap.appendChild(vid);
    } else {
      const icon = document.createElement("div");
      icon.textContent = "📎";
      icon.style.fontSize = "36px";
      previewWrap.appendChild(icon);
    }

    const meta = document.createElement("div");
    meta.style.flex = "1";
    meta.style.display = "flex";
    meta.style.flexDirection = "column";

    const name = document.createElement("div");
    name.textContent = file.name || `Файл ${idx + 1}`;
    name.style.fontWeight = 600;
    name.style.marginBottom = "6px";
    name.style.whiteSpace = "nowrap";
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";

    const captionInput = document.createElement("input");
    captionInput.type = "text";
    captionInput.placeholder = "Добавить подпись (необязательно)";
    captionInput.style.width = "100%";
    captionInput.style.padding = "8px";
    captionInput.style.border = "1px solid rgba(0,0,0,0.1)";
    captionInput.style.borderRadius = "6px";

    meta.appendChild(name);
    meta.appendChild(captionInput);

    item.appendChild(previewWrap);
    item.appendChild(meta);
    list.appendChild(item);

    fileItems.push({ file, captionInput });
  });

  modal.appendChild(list);

  // Кнопки: Отправить и Отмена
  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "8px";
  actions.style.marginTop = "12px";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Отмена";
  cancel.style.padding = "8px 12px";
  cancel.style.borderRadius = "8px";
  cancel.style.border = "1px solid rgba(0,0,0,0.08)";
  cancel.style.background = "transparent";
  cancel.style.cursor = "pointer";

  const sendAll = document.createElement("button");
  sendAll.type = "button";
  sendAll.textContent =
    files.length > 1 ? `Отправить все (${files.length})` : "Отправить";
  sendAll.style.padding = "8px 14px";
  sendAll.style.borderRadius = "8px";
  sendAll.style.border = "none";
  sendAll.style.background = "var(--color-primary, #2f80ed)";
  sendAll.style.color = "#fff";
  sendAll.style.cursor = "pointer";

  actions.appendChild(cancel);
  actions.appendChild(sendAll);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Фокус на первом инпуте подписи
  const firstInput = fileItems[0] && fileItems[0].captionInput;
  if (firstInput) firstInput.focus();

  // Обработчики
  function closeModal() {
    // очистка blob URLs
    fileItems.forEach(({ file }) => {
      try {
        URL.revokeObjectURL(file && file.preview);
      } catch (_) {}
    });
    document.body.removeChild(overlay);
  }
  closeBtn.addEventListener("click", closeModal);
  cancel.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  sendAll.addEventListener("click", async () => {
    // Деактивируем кнопку, чтобы избежать дублей
    sendAll.disabled = true;
    sendAll.textContent = "Отправка...";
    try {
      // Отправляем по очереди (чтобы не перегружать сеть)
      for (const item of fileItems) {
        const caption = item.captionInput.value || "";
        await sendFile(item.file, activeChatId, caption);
      }
    } catch (err) {
      console.error("Ошибка отправки из превью:", err);
      alert("Ошибка при отправке одного из файлов");
    } finally {
      closeModal();
    }
  });
}

// ===========================
// === Работа со списком чатов (ОБНОВЛЕНО) ===
// ===========================

if (chatListUl) {
  chatListUl.addEventListener("click", async (e) => {
    const btn = e.target.closest(".chat-list-item-btn");
    if (!btn) return;
    const chatId = btn.dataset.chatId;
    if (!chatId) return;

    // Если установлен флаг показа пустого состояния, показываем его вместо загрузки чата
    // НО: НИКОГДА не закрываем чат, если он открыт по URL
    if (shouldShowEmptyState && !isChatOpenedFromUrl && !activeChatId) {
      shouldShowEmptyState = false;
      // Убираем выделение со всех чатов
      document
        .querySelectorAll(".chat-list-item-btn")
        .forEach((b) => b.classList.remove("active"));
      // Показываем пустое состояние
      // НО: НИКОГДА не закрываем чат, если он открыт по URL
      if (!isChatOpenedFromUrl || !activeChatId) {
        chatWindow.classList.add("hidden");
        chatEmptyState.classList.remove("hidden");
        activeChatId = null;
      } else {
        console.log(
          "[Telegram Logic] БЛОКИРОВАНО: попытка закрыть чат через shouldShowEmptyState, но чат открыт по URL"
        );
      }
      // Устанавливаем пустой заголовок страницы для списка чатов
      document.title = "";
      // Закрываем профиль, если он открыт
      if (profileSection && !profileSection.classList.contains("hidden")) {
        closeProfileModal();
      }
      return;
    }

    // Telegram логика: сначала обновляем URL, потом открываем чат
    // URL = единственный источник правды
    document
      .querySelectorAll(".chat-list-item-btn")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    // ВАЖНО: Сначала обновляем URL (как в Telegram)
    updateUrlForChat(btn);

    // Затем загружаем чат (loadChat покажет окно чата)
    await loadChat(chatId);

    // Дополнительная гарантия: показываем окно чата
    if (chatWindow) chatWindow.classList.remove("hidden");
    if (chatEmptyState) chatEmptyState.classList.add("hidden");

    if (window.matchMedia("(max-width: 768px)").matches) {
      if (chatListAside) chatListAside.classList.add("view-hidden");
      if (chatWindow) chatWindow.classList.add("view-active");
    }
  });
}

// === ИЗМЕНЕНИЕ: Логика кнопки "Назад" для десктопа и мобильных ===
backToChatListBtn.addEventListener("click", () => {
  // Сбрасываем флаг открытия по URL при нажатии "Назад"
  // (пользователь явно хочет вернуться к списку чатов)
  const wasOpenedFromUrl = isChatOpenedFromUrl;
  isChatOpenedFromUrl = false;
  isProtectionActive = false; // Отключаем защиту
  if (protectionInterval) {
    clearInterval(protectionInterval);
    protectionInterval = null;
  }
  if (protectionObserver) {
    protectionObserver.disconnect();
    protectionObserver = null;
  }

  // Сначала убираем выделение с активного чата в списке
  const currentActiveBtn = document.querySelector(".chat-list-item-btn.active");
  if (currentActiveBtn) {
    currentActiveBtn.classList.remove("active");
  }

  // Закрываем поиск в чате
  closeChatSearch();

  // Очищаем поиск в списке чатов и показываем полный список
  if (searchInput) {
    searchInput.value = "";
    filterChatList("");
  }
  if (searchClearBtn) {
    searchClearBtn.classList.add("hidden");
  }
  // Скрываем результаты поиска пользователей
  if (userSearchResultsUl) {
    userSearchResultsUl.style.display = "none";
    userSearchResultsUl.innerHTML = "";
  }
  // Показываем список чатов
  if (chatListUl) {
    chatListUl.style.display = "block";
  }

  if (window.matchMedia("(max-width: 900px)").matches) {
    // --- Мобильная логика: возврат в список чатов (не в пустое состояние) ---
    if (typeof window.switchToListView === "function") {
      window.switchToListView();
    }
    chatListAside.classList.remove("view-hidden");
    chatWindow.classList.remove("view-active");
  } else {
    // --- Десктопная логика: ---
    // ВСЕГДА показываем пустое состояние (картинку с надписью) при нажатии "Назад"
    // Это нормальное поведение - пользователь хочет вернуться к списку чатов
    if (chatWindow) {
      chatWindow.classList.add("hidden");
      chatWindow.style.display = "";
    }
    if (chatEmptyState) {
      chatEmptyState.classList.remove("hidden");
      chatEmptyState.style.display = "";
      chatEmptyState.style.visibility = "visible";
      chatEmptyState.style.opacity = "1";
    }
    activeChatId = null;
  }

  // Устанавливаем пустой заголовок страницы для списка чатов
  document.title = "";

  // Возвращаемся на общий список чатов: /
  const basePath = "/";
  if (window.location.pathname !== basePath) {
    history.replaceState(null, "", `${basePath}${window.location.search}`);
  }

  // Закрываем профиль, если он открыт
  if (profileSection && !profileSection.classList.contains("hidden")) {
    closeProfileModal();
  }
});
// === КОНЕЦ ИЗМЕНЕНИЯ ===

function updateChatPreview(chatId, text) {
  const btn = document.querySelector(
    `.chat-list-item-btn[data-chat-id="${chatId}"]`
  );
  if (!btn) return;

  // Не обновляем превью, если есть черновик (черновик имеет приоритет)
  if (btn.dataset.hasDraft === "true") {
    return;
  }
  const lastMsg = btn.querySelector(".last-message");
  if (lastMsg) {
    const newText = text || "Новое сообщение";
    lastMsg.textContent = "";
    renderTextWithEmojis(lastMsg, newText, true);
    lastMsg.dataset.originalText = newText;
    lastMsg.classList.remove("typing-status");
  }
  const newTimestamp = new Date().toISOString();
  const timeEl = btn.querySelector(".chat-list-time");
  if (timeEl) {
    timeEl.textContent = formatTime(newTimestamp);
  }
  btn.dataset.lastTimestamp = newTimestamp;
}

function moveChatToTop(chatId) {
  // ... (без изменений) ...
  const btn = document.querySelector(
    `.chat-list-item-btn[data-chat-id="${chatId}"]`
  );
  if (!btn) return;
  const li = btn.closest("li");
  const firstChatItem = chatListUl.querySelector("li .chat-list-item-btn");
  if (firstChatItem) {
    chatListUl.insertBefore(li, firstChatItem.closest("li"));
  } else {
    chatListUl.prepend(li);
  }
}

// ===========================
// === Инициализация (ОБНОВЛЕНО) ===
// ===========================

messageInput.addEventListener("input", (e) => {
  toggleSendButton();
  updateInputState(); // Добавлен вызов updateInputState
  syncMessageInputVisual();

  if (!attachmentMenu.classList.contains("hidden")) {
    attachmentMenu.classList.add("hidden");
  }
  sendTypingEvent();

  // Обработка упоминаний через @
  handleMentionsInput(e);

  // Сохраняем черновик при вводе
  if (activeChatId && messageInput) {
    saveDraft(activeChatId, messageInput.value);
  }
});

// Обработка клавиатуры для упоминаний
messageInput.addEventListener("keydown", (e) => {
  handleMentionsKeydown(e);

  if (mentionsList && !mentionsList.classList.contains("hidden")) {
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    messageForm.dispatchEvent(new Event("submit", { cancelable: true }));
  }
});
toggleSendButton();

attachmentIcon.addEventListener("click", (e) => {
  e.stopPropagation();

  // Закрываем панель эмодзи если открыта
  const emojiPicker = document.getElementById("emojiPicker");
  if (emojiPicker && !emojiPicker.classList.contains("hidden")) {
    emojiPicker.classList.add("hidden");
    updateInputState();
  }

  attachmentMenu.classList.toggle("hidden");
});

function initAttachmentHandlers() {
  const fileInput = document.getElementById("fileInput");
  const imageVideoInput = document.getElementById("imageVideoInput");
  const photoVideoBtn = document.getElementById("photoVideoBtn");
  const fileBtn = document.getElementById("fileBtn");

  if (photoVideoBtn && imageVideoInput) {
    photoVideoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      attachmentMenu.classList.add("hidden");
      // Сбрасываем значение, чтобы выбор того же файла повторно триггерил событие change
      imageVideoInput.value = "";
      imageVideoInput.click();
    });
  }
  if (fileBtn && fileInput) {
    fileBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      attachmentMenu.classList.add("hidden");
      // Аналогично сбрасываем значение для обычных файлов
      fileInput.value = "";
      fileInput.click();
    });
  }

  if (imageVideoInput) {
    imageVideoInput.addEventListener("change", (e) => {
      const files = Array.from(e.target.files).filter(Boolean);
      if (files.length > 0 && activeChatId) {
        // вместо мгновенной отправки — показываем превью
        openFilePreviewModal(files);
        e.target.value = "";
      }
    });
  }

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file && activeChatId) {
        openFilePreviewModal([file]);
        e.target.value = "";
      }
    });
  }
}

document.addEventListener("click", (e) => {
  // ... (без изменений) ...
  if (!attachmentMenu.contains(e.target) && e.target !== attachmentIcon) {
    if (!attachmentMenu.classList.contains("hidden")) {
      attachmentMenu.classList.add("hidden");
    }
  }
});

// ===========================
// === Запись аудио (новое) ===
// ===========================
function stopWaveDraw() {
  if (rafWave) {
    cancelAnimationFrame(rafWave);
    rafWave = null;
  }
}

let waveformAnimationId = null;

function startWaveformAnimation() {
  const voiceWaveformRecording = document.getElementById(
    "voiceWaveformRecording"
  );
  if (!voiceWaveformRecording) return;

  // Очищаем содержимое
  voiceWaveformRecording.innerHTML = "";

  // Создаем полоски для визуализации (белые полоски на синем фоне) - как в отправленных сообщениях
  const numBars = 40;
  for (let i = 0; i < numBars; i++) {
    const bar = document.createElement("div");
    bar.classList.add("audio-wave-bar");
    bar.style.width = "5px";
    bar.style.height = "5px";
    bar.style.background = "#FFFFFF";
    bar.style.borderRadius = "2.5px";
    bar.style.transition = "height 0.1s ease, opacity 0.1s ease";
    bar.style.opacity = "0.5";
    voiceWaveformRecording.appendChild(bar);
  }

  const dataArray = analyser
    ? new Uint8Array(analyser.frequencyBinCount)
    : null;
  const bars = voiceWaveformRecording.querySelectorAll(".audio-wave-bar");

  function animate() {
    if (!recordingStartTs) {
      if (waveformAnimationId) {
        cancelAnimationFrame(waveformAnimationId);
        waveformAnimationId = null;
      }
      return;
    }

    if (analyser && dataArray) {
      // Получаем данные частотного анализа
      analyser.getByteFrequencyData(dataArray);

      // Берем несколько частотных диапазонов для создания волны
      const step = Math.floor(dataArray.length / numBars);

      bars.forEach((bar, index) => {
        const dataIndex = Math.min(index * step, dataArray.length - 1);
        const value = dataArray[dataIndex] / 255; // Нормализуем 0-1

        // Высота полоски зависит от громкости (от 5px до 25px)
        const height = 5 + value * 20;
        bar.style.height = `${Math.max(5, Math.min(25, height))}px`;
        bar.style.opacity = "1";
      });
    } else {
      // Fallback: простая анимация
      bars.forEach((bar) => {
        const height = 5 + Math.random() * 20;
        bar.style.height = `${Math.max(5, Math.min(25, height))}px`;
        bar.style.opacity = "1";
      });
    }

    waveformAnimationId = requestAnimationFrame(animate);
  }

  animate();
}

function stopWaveformAnimation() {
  if (waveformAnimationId) {
    cancelAnimationFrame(waveformAnimationId);
    waveformAnimationId = null;
  }
  const voiceWaveformRecording = document.getElementById(
    "voiceWaveformRecording"
  );
  if (voiceWaveformRecording) {
    const bars = voiceWaveformRecording.querySelectorAll(".audio-wave-bar");
    bars.forEach((bar) => {
      bar.style.height = "5px";
      bar.style.opacity = "0.5";
    });
  }
}

function updateRecordingTimer() {
  const elapsed = Math.floor((Date.now() - recordingStartTs) / 1000);
  voiceTimerEl.textContent = formatDuration(elapsed);
}
async function startRecording() {
  // Проверка secure context: getUserMedia требует HTTPS или localhost
  if (
    !window.isSecureContext &&
    location.hostname !== "localhost" &&
    location.hostname !== "127.0.0.1"
  ) {
    alert(
      "Доступ к микрофону заблокирован: откройте сайт по HTTPS или через http://localhost."
    );
    return;
  }
  // Явная проверка Permissions API (если поддерживается)
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const res = await navigator.permissions.query({ name: "microphone" });
      if (res.state === "denied") {
        alert(
          "Доступ к микрофону запрещён в настройках браузера. Разрешите доступ в настройках сайта и попробуйте снова."
        );
        return;
      }
    }
  } catch (_) {
    // Игнорируем, не все браузеры поддерживают
  }

  // Пытаемся запросить медиапоток с расширенными параметрами, затем с упрощёнными
  const tryGetStream = async () => {
    const advanced = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: 48000,
      },
    };
    const simple = { audio: true };
    try {
      return await navigator.mediaDevices.getUserMedia(advanced);
    } catch (e1) {
      try {
        return await navigator.mediaDevices.getUserMedia(simple);
      } catch (e2) {
        throw e2;
      }
    }
  };

  try {
    mediaStream = await tryGetStream();
  } catch (e) {
    const msg = explainMicError(e);
    alert(msg);
    return;
  }
  audioChunks = [];
  isCancelling = false;

  // Показываем кнопку записи и скрываем форму ввода
  if (voiceRecordingButton) voiceRecordingButton.classList.remove("hidden");
  if (chatInputForm) chatInputForm.classList.add("hidden");

  // Микрофон остается без изменений

  recordingStartTs = Date.now();
  updateRecordingTimer();
  recordingTimerId = setInterval(updateRecordingTimer, 250);

  // Инициализируем Web Audio API для анализа аудио
  if (mediaStream && !audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;

      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);
    } catch (e) {
      console.error("Ошибка инициализации Web Audio API:", e);
    }
  }

  // Запускаем визуализацию волны при записи
  startWaveformAnimation();

  // Динамически определяем поддерживаемый MIME‑тип для лучшей совместимости (Chrome, Firefox, Safari/iOS)
  let mimeType = "";
  if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
    const candidates = [
      "audio/webm;codecs=opus", // Chrome / Edge / Firefox
      "audio/ogg;codecs=opus", // Альтернатива для некоторых браузеров
      "audio/mp4;codecs=mp4a.40.2", // Safari / iOS (предпочтительно)
      "audio/mp4", // fallback для Safari
    ];
    for (const cand of candidates) {
      if (MediaRecorder.isTypeSupported(cand)) {
        mimeType = cand;
        break;
      }
    }
  }

  try {
    mediaRecorder = new MediaRecorder(
      mediaStream,
      mimeType ? { mimeType } : undefined
    );
  } catch (e) {
    alert(
      "Запись не поддерживается в этом браузере. Попробуйте другой браузер (Chrome/Firefox/Safari 14+)."
    );
    stopRecording(true);
    return;
  }
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    try {
      // Проверяем, что есть данные для отправки
      if (audioChunks.length === 0) {
        console.warn("Нет данных для отправки");
        cleanupRecording();
        return;
      }

      const blob = new Blob(audioChunks, {
        type: mimeType || "audio/webm",
      });

      // Проверяем размер файла
      if (blob.size === 0) {
        console.warn("Файл пуст");
        cleanupRecording();
        return;
      }

      let durationSec = Math.floor((Date.now() - recordingStartTs) / 1000);

      // Проверяем условия отмены
      if (isCancelling || durationSec <= 0 || !activeChatId) {
        cleanupRecording();
        return;
      }

      // Минимальная длительность - 0.5 секунды
      if (durationSec < 0.5) {
        console.warn("Запись слишком короткая");
        cleanupRecording();
        return;
      }

      // --- OPTIMISTIC UI: Render immediately ---
      const tempId = "temp-" + Date.now();
      const blobUrl = URL.createObjectURL(blob);
      
      // Store in cache so we don't try to download it
      audioCache.set(blobUrl, blobUrl);

      const tempMsg = {
        _id: tempId,
        chat_id: activeChatId,
        sender_id: currentUserEmail,
        sender_email: currentUserEmail,
        type: "audio",
        file_url: blobUrl,
        audio_duration: durationSec,
        timestamp: new Date(),
        read_by: [],
        isSending: true
      };

      // Render optimistic message
      renderMessage(tempMsg, true, currentChatIsGroup);
      
      // Scroll to bottom
      chatMessages.scrollTo({
        top: chatMessages.scrollHeight,
        behavior: "smooth",
      });

      // Создаем FormData
      let extension = "webm";
      if (mimeType.startsWith("audio/ogg")) {
        extension = "ogg";
      } else if (mimeType.startsWith("audio/mp4")) {
        // Для Safari / iOS лучше использовать расширение .mp4
        extension = "mp4";
      }

      const fd = new FormData();
      const fileName = `voice_${Date.now()}.${extension}`;
      const audioFile = new File([blob], fileName, {
        type: blob.type || mimeType || "audio/webm",
      });

      fd.append("file", audioFile);
      fd.append("duration", String(durationSec));

      console.log(
        `Отправка голосового сообщения: размер=${blob.size} байт, длительность=${durationSec} сек`
      );

      // Отправляем на сервер
      const resp = await fetch(
        `${API_BASE_URL}/api/upload_audio/${activeChatId}`,
        {
          method: "POST",
          body: fd,
          credentials: "include",
        }
      );

      if (!resp.ok) {
        let errorMessage = "Ошибка отправки голосового сообщения";
        try {
          const err = await resp.json();
          errorMessage = err.detail || err.message || errorMessage;
        } catch (e) {
          errorMessage = `Ошибка ${resp.status}: ${resp.statusText}`;
        }
        
        // Remove temp message on error
        const tempBubble = document.getElementById(`msg-${tempId}`);
        if (tempBubble) {
            const row = tempBubble.closest('.message-row');
            if (row) row.remove();
        }
        
        throw new Error(errorMessage);
      }

      // Получаем данные сообщения от сервера
      const result = await resp.json();
      if (!result || !result.message_data) {
        throw new Error("Сервер не вернул данные сообщения");
      }

      const messageData = result.message_data;

      // Преобразуем timestamp если это строка
      if (typeof messageData.timestamp === "string") {
        messageData.timestamp = new Date(messageData.timestamp);
      }

      // Убеждаемся, что есть sender_email для правильного отображения
      if (!messageData.sender_email && messageData.sender_id) {
        messageData.sender_email = messageData.sender_id;
      }
      
      // Update the optimistic message with real data
      const tempBubble = document.getElementById(`msg-${tempId}`);
      
      // Check for race condition: WS might have already rendered the real message
      const existingRealBubble = document.getElementById(`msg-${messageData._id}`);
      if (existingRealBubble && tempBubble) {
          // WS beat us to it. Remove the WS version to keep the optimistic one 
          // (which preserves playback state if user is listening)
          const row = existingRealBubble.closest('.message-row');
          if (row) row.remove();
      }

      if (tempBubble) {
          // Update IDs
          tempBubble.id = `msg-${messageData._id}`;
          tempBubble.dataset.messageId = messageData._id;
          
          // Remove sending class and spinner
          tempBubble.classList.remove("sending");
          const ticks = tempBubble.querySelector(".audio-ticks");
          if (ticks) {
              ticks.innerHTML = `<img src="/images/no_read.svg" alt="Отправлено">`;
              ticks.classList.add("sent");
          }
          
          // Add to renderedMessageIds to prevent duplication from WS
          if (renderedMessageIds) {
              renderedMessageIds.add(messageData._id);
          }
          
          // Cache the real URL to point to the local blob (to avoid re-downloading)
          if (messageData.file_url) {
              audioCache.set(messageData.file_url, blobUrl);
          }
      } else {
          // Fallback if temp bubble lost: Render normally
          // НЕ рендерим сообщение здесь, если оно от текущего пользователя
          // Оно придет через WebSocket и будет отрендерено там
          // Это предотвращает двойное отображение
          const isFromCurrentUser =
            (messageData.sender_id || messageData.sender_email) ===
            currentUserEmail;
    
          if (!isFromCurrentUser && messageData.chat_id === activeChatId) {
            // Рендерим только если сообщение не от текущего пользователя
            renderMessage(messageData, true, currentChatIsGroup);
          }
      }

      // Отмечаем как прочитанное (если сообщение от нас, оно придет через WS и будет отмечено там)
      /* 
      // This part is redundant if we rely on WS for read status updates
      if (ws && ws.readyState === WebSocket.OPEN && !isFromCurrentUser) {
        ws.send(
          JSON.stringify({ type: "mark_as_read", chat_id: activeChatId })
        );
      }
      */

      console.log("Голосовое сообщение успешно отправлено");
    } catch (e) {
      console.error("Ошибка отправки голосового сообщения:", e);
      alert(e.message || "Ошибка отправки голосового сообщения");
    } finally {
      cleanupRecording();
    }
  };
  mediaRecorder.start(100);
}
function cleanupRecording() {
  // Скрываем кнопку записи и показываем форму ввода
  if (voiceRecordingButton) voiceRecordingButton.classList.add("hidden");
  if (chatInputForm) chatInputForm.classList.remove("hidden");

  // Микрофон остается без изменений

  // Останавливаем анимацию волны
  stopWaveformAnimation();

  clearInterval(recordingTimerId);
  recordingTimerId = null;
  stopWaveDraw();
  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (_) {}
    sourceNode = null;
  }
  if (analyser) analyser = null;
  if (audioContext) {
    try {
      audioContext.close();
    } catch (_) {}
    audioContext = null;
  }
  if (mediaRecorder) {
    if (mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch (_) {}
    }
    mediaRecorder = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  audioChunks = [];
  isCancelling = false;
  recordingStartTs = 0;
}
function stopRecording(cancel = false) {
  isCancelling = cancel;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    } else {
      cleanupRecording();
    }
  } catch (e) {
    cleanupRecording();
  }
}
// Press-and-hold + swipe-to-cancel
if (micIcon) {
  const start = (clientX) => {
    startPointerX = clientX;
    startRecording();
  };
  const move = (clientX) => {
    if (!voiceRecordingButton || !recordingStartTs) return;
    const dx = clientX - startPointerX;
    // свайп влево для отмены
    isCancelling = dx < -60;
    if (voiceRecordingButton) {
      voiceRecordingButton.classList.toggle("cancelling", isCancelling);
    }
  };
  const end = () => {
    stopRecording(isCancelling);
  };
  // Mouse
  micIcon.addEventListener("mousedown", (e) => {
    e.preventDefault();
    start(e.clientX);
    const onMove = (ev) => move(ev.clientX);
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      end();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  // Touch
  micIcon.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      start(t.clientX);
    },
    { passive: true }
  );
  micIcon.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      move(t.clientX);
    },
    { passive: true }
  );
  micIcon.addEventListener("touchend", () => end(), { passive: true });
}

// Детальная расшифровка ошибок микрофона
function explainMicError(err) {
  const name = (err && (err.name || err.code)) || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Доступ к микрофону запрещён. Разрешите доступ в настройках сайта и перезагрузите страницу.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Микрофон не найден. Проверьте, что микрофон подключён и не занят другим приложением.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Не удалось получить доступ к микрофону. Возможно, он используется другим приложением.";
  }
  if (
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError"
  ) {
    return "Требуемые параметры микрофона недоступны. Попробуйте другой микрофон.";
  }
  if (name === "SecurityError") {
    return "Браузер заблокировал доступ к микрофону. Откройте сайт по HTTPS или через localhost.";
  }
  return "Не удалось получить доступ к микрофону. Проверьте разрешения и попробуйте снова.";
}

// ===========================
// === Функции для ответа и редактирования ===
// ===========================

function showReplyPreview(senderName, content, isEdit) {
  if (!replyPreview || !replyPreviewInfo) return;
  const baseText = typeof content === "string" ? content : "";
  const cleanText = baseText.replace(emojiPattern, "");
  const shortText = cleanText.substring(0, 50);
  const suffix = cleanText.length > 50 ? "..." : "";
  replyPreviewInfo.innerHTML = isEdit
    ? `<strong>Редактирование:</strong> ${shortText}${suffix}`
    : `<strong>Ответ ${senderName}:</strong> ${shortText}${suffix}`;
  replyPreview.classList.remove("hidden");
}

function hideReplyPreview() {
  if (replyPreview) replyPreview.classList.add("hidden");
  replyingToMessage = null;
  editingMessageId = null;
}

if (replyPreviewClose) {
  replyPreviewClose.addEventListener("click", () => {
    messageInput.value = "";
    hideReplyPreview();
    toggleSendButton();
    updateInputState();
    syncMessageInputVisual();
  });
}

// ===========================
// === Контекстное меню (без изменений) ===
// ===========================

let activeMessageElement = null;

function closeContextMenu() {
  if (activeMessageElement) {
    activeMessageElement.classList.remove("selected");
    activeMessageElement = null;
  }
  contextMenuOverlay.classList.add("hidden");
  messageContextMenu.classList.add("hidden");
}

function openDeleteConfirmModal() {
  if (!activeMessageElement || !deleteConfirmOverlay) return;

  const isOutgoing = activeMessageElement.classList.contains("outgoing");

  if (deleteForAllOption) {
    if (isOutgoing) {
      deleteForAllOption.classList.remove("disabled");
    } else {
      deleteForAllOption.classList.add("disabled");
    }
  }

  // позиционируем модалку слева от пункта "Удалить" в контекстном меню, как в Figma
  const modal = document.getElementById("deleteConfirmModal");
  const deleteItem = messageContextMenu.querySelector(
    ".context-menu-item.delete"
  );
  const deleteBtn = deleteItem ? deleteItem.querySelector("button") : null;

  if (modal && chatWindow && deleteBtn) {
    const containerRect = chatWindow.getBoundingClientRect();
    const deleteRect = deleteBtn.getBoundingClientRect();
    const modalRect = { width: 270, height: 96 }; // приблизительные размеры

    // по вертикали выравниваем по центру пункта "Удалить"
    let top =
      deleteRect.top -
      containerRect.top +
      deleteRect.height / 2 -
      modalRect.height / 2;
    // панель всегда слева от "Удалить"
    let left = deleteRect.left - containerRect.left - modalRect.width - 8;

    const padding = 10;
    const maxWidth = containerRect.width;
    const maxHeight = containerRect.height;

    if (left < padding) left = padding;
    if (left + modalRect.width + padding > maxWidth) {
      left = maxWidth - modalRect.width - padding;
    }
    if (top + modalRect.height + padding > maxHeight) {
      top = maxHeight - modalRect.height - padding;
    }

    modal.style.left = `${left}px`;
    modal.style.top = `${top}px`;
  }

  deleteConfirmOverlay.style.pointerEvents = "auto";
  deleteConfirmOverlay.classList.remove("hidden");
}

function closeDeleteConfirmModal() {
  if (!deleteConfirmOverlay) return;
  deleteConfirmOverlay.style.pointerEvents = "none";
  deleteConfirmOverlay.classList.add("hidden");
}

function openClearChatConfirmModal() {
  console.log("Открываю модалку очистки чата, activeChatId:", activeChatId);

  if (!clearChatConfirmOverlay) {
    console.error("clearChatConfirmOverlay не найден!");
    alert("Ошибка: модалка не найдена");
    return;
  }

  if (!activeChatId) {
    alert("Нет активного чата для очистки");
    return;
  }

  // Позиционируем модалку относительно кнопки меню
  const modal = document.getElementById("clearChatConfirmModal");
  const menuBtn = document.getElementById("menuToggleBtn");

  if (modal && chatWindow && menuBtn) {
    const containerRect = chatWindow.getBoundingClientRect();
    const menuRect = menuBtn.getBoundingClientRect();
    const modalRect = { width: 270, height: 96 };

    let top =
      menuRect.top -
      containerRect.top +
      menuRect.height / 2 -
      modalRect.height / 2;
    let left = menuRect.left - containerRect.left - modalRect.width - 8;

    const padding = 10;
    const maxWidth = containerRect.width;
    const maxHeight = containerRect.height;

    if (left < padding) left = padding;
    if (left + modalRect.width + padding > maxWidth) {
      left = maxWidth - modalRect.width - padding;
    }
    if (top + modalRect.height + padding > maxHeight) {
      top = maxHeight - modalRect.height - padding;
    }

    modal.style.left = `${left}px`;
    modal.style.top = `${top}px`;
  }

  // Показываем модалку
  clearChatConfirmOverlay.style.pointerEvents = "auto";
  clearChatConfirmOverlay.style.display = "flex";
  clearChatConfirmOverlay.classList.remove("hidden");
  console.log("Модалка очистки чата открыта");
}

function closeClearChatConfirmModal() {
  if (!clearChatConfirmOverlay) return;
  clearChatConfirmOverlay.style.pointerEvents = "none";
  clearChatConfirmOverlay.style.display = "none";
  clearChatConfirmOverlay.classList.add("hidden");
  console.log("Модалка очистки чата закрыта");
}

function openDeleteChatConfirmModal() {
  console.log("Открываю модалку удаления чата, activeChatId:", activeChatId);

  if (!deleteChatConfirmOverlay) {
    console.error("deleteChatConfirmOverlay не найден!");
    alert("Ошибка: модалка не найдена");
    return;
  }

  if (!activeChatId) {
    alert("Нет активного чата для удаления");
    return;
  }

  // Позиционируем модалку относительно кнопки меню
  const modal = document.getElementById("deleteChatConfirmModal");
  const menuBtn = document.getElementById("menuToggleBtn");

  if (modal && chatWindow && menuBtn) {
    const containerRect = chatWindow.getBoundingClientRect();
    const menuRect = menuBtn.getBoundingClientRect();
    const modalRect = { width: 270, height: 96 };

    let top =
      menuRect.top -
      containerRect.top +
      menuRect.height / 2 -
      modalRect.height / 2;
    let left = menuRect.left - containerRect.left - modalRect.width - 8;

    const padding = 10;
    const maxWidth = containerRect.width;
    const maxHeight = containerRect.height;

    if (left < padding) left = padding;
    if (left + modalRect.width + padding > maxWidth) {
      left = maxWidth - modalRect.width - padding;
    }
    if (top + modalRect.height + padding > maxHeight) {
      top = maxHeight - modalRect.height - padding;
    }

    modal.style.left = `${left}px`;
    modal.style.top = `${top}px`;
  }

  // Показываем модалку
  deleteChatConfirmOverlay.style.pointerEvents = "auto";
  deleteChatConfirmOverlay.style.display = "flex";
  deleteChatConfirmOverlay.classList.remove("hidden");
  console.log("Модалка удаления чата открыта");
}

function closeDeleteChatConfirmModal() {
  if (!deleteChatConfirmOverlay) return;
  deleteChatConfirmOverlay.style.pointerEvents = "none";
  deleteChatConfirmOverlay.style.display = "none";
  deleteChatConfirmOverlay.classList.add("hidden");
  console.log("Модалка удаления чата закрыта");
}

function showContextMenu(e) {
  // ... (без изменений) ...
  e.preventDefault();
  const messageElement = e.target.closest(".message");
  if (!messageElement) {
    closeContextMenu();
    return;
  }
  closeContextMenu();
  activeMessageElement = messageElement;
  activeMessageElement.classList.add("selected");

  // Определяем, является ли сообщение нашим
  const isOutgoing = activeMessageElement.classList.contains("outgoing");

  // Скрываем/показываем кнопку "Изменить" в зависимости от того, наше ли это сообщение
  const editMenuItem = messageContextMenu.querySelector('[data-action="edit"]');
  if (editMenuItem) {
    if (isOutgoing) {
      editMenuItem.classList.remove("hidden");
    } else {
      editMenuItem.classList.add("hidden");
    }
  }

  contextMenuOverlay.classList.remove("hidden");
  messageContextMenu.style.visibility = "hidden";
  messageContextMenu.classList.remove("hidden");
  const menuWidth = messageContextMenu.offsetWidth;
  const menuHeight = messageContextMenu.offsetHeight;
  messageContextMenu.classList.add("hidden");
  messageContextMenu.style.visibility = "visible";
  const containerRect = chatWindow.getBoundingClientRect();
  const messageRect = activeMessageElement.getBoundingClientRect();
  let top = messageRect.bottom - containerRect.top + 8;
  let left;
  if (isOutgoing) {
    left = messageRect.right - containerRect.left - menuWidth;
  } else {
    left = messageRect.left - containerRect.left;
  }
  const padding = 10;
  if (left < padding) left = padding;
  if (left + menuWidth + padding > containerRect.width)
    left = containerRect.width - menuWidth - padding;
  if (top + menuHeight + padding > containerRect.height)
    top = messageRect.top - containerRect.top - menuHeight - 8;
  messageContextMenu.style.top = `${top}px`;
  messageContextMenu.style.left = `${left}px`;
  messageContextMenu.classList.remove("hidden");
}
chatMessages.addEventListener("contextmenu", showContextMenu);
contextMenuOverlay.addEventListener("click", closeContextMenu);
document.addEventListener("click", (e) => {
  if (!messageContextMenu.contains(e.target)) {
    closeContextMenu();
  }
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !contextMenuOverlay.classList.contains("hidden")) {
    closeContextMenu();
  }
});
messageContextMenu.addEventListener("click", (e) => {
  // ... (без изменений) ...
  const actionButton = e.target.closest(".context-menu-item");
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (activeMessageElement) {
    const messageId = activeMessageElement.dataset.messageId;
    if (action === "copy") {
      const content = activeMessageElement.querySelector(".message-content");
      if (content) {
        navigator.clipboard.writeText(content.textContent);
      }
    }
    if (action === "reply") {
      // Находим сообщение в DOM и извлекаем данные
      const messageRow = activeMessageElement.closest(".message-row");
      const msgContent = activeMessageElement.querySelector(".message-content");
      const msgImage = activeMessageElement.querySelector(".message-image");
      const msgVideo = activeMessageElement.querySelector(".message-video");
      const msgFile = activeMessageElement.querySelector(
        ".message-file-container"
      );
      const msgAudio = activeMessageElement.querySelector(".audio-message");

      const msgSender = activeMessageElement.closest(".outgoing")
        ? currentUserEmail
        : null;
      const senderName = msgSender ? "Вы" : "Собеседник";

      // Определяем контент для ответа
      let contentText = "Сообщение";
      if (msgContent) {
        contentText = msgContent.textContent || "";
      } else if (msgImage) {
        contentText = "Фото";
      } else if (msgVideo) {
        contentText = "Видео";
      } else if (msgFile) {
        const fileNameEl = msgFile.querySelector("[data-filename]");
        contentText = fileNameEl
          ? fileNameEl.dataset.filename || fileNameEl.textContent
          : "Файл";
      } else if (msgAudio) {
        contentText = "Голосовое сообщение";
      }

      replyingToMessage = {
        _id: messageId,
        sender_id: msgSender || "other",
        content: contentText,
      };
      showReplyPreview(senderName, contentText, false);
      messageInput.focus();
    }
    if (action === "edit") {
      const isMine = activeMessageElement.classList.contains("outgoing");
      if (!isMine) {
        alert("Вы можете редактировать только свои сообщения.");
        closeContextMenu();
        return;
      }
      const msgContent = activeMessageElement.querySelector(".message-content");
      if (!msgContent) {
        alert("Это сообщение нельзя редактировать.");
        closeContextMenu();
        return;
      }
      editingMessageId = messageId;
      messageInput.value = msgContent.textContent;
      messageInput.focus();
      showReplyPreview("Редактирование", msgContent.textContent, true);
    }
    if (action === "delete") {
      if (messageId) {
        openDeleteConfirmModal();
      }
      return; // не закрываем контекстное меню через closeContextMenu, это делает модалка
    }
    if (action === "pin") {
      if (messageId) {
        pinMessage(messageId);
      }
    }
    if (action === "forward") {
      openForwardModalForMessage(activeMessageElement);
      return;
    }
  }
  closeContextMenu();
});

// Обработчики модалки удаления
if (deleteConfirmOverlay) {
  deleteConfirmOverlay.addEventListener("click", (e) => {
    if (e.target === deleteConfirmOverlay) {
      closeDeleteConfirmModal();
      closeContextMenu();
    }
  });
}

if (deleteForAllOption) {
  deleteForAllOption.addEventListener("click", () => {
    if (!activeMessageElement) return;
    if (deleteForAllOption.classList.contains("disabled")) return;

    const messageId = activeMessageElement.dataset.messageId;
    if (!messageId) return;

    deleteMessage(messageId, true, activeMessageElement);
    closeDeleteConfirmModal();
    closeContextMenu();
  });
}

if (deleteForSelfOption) {
  deleteForSelfOption.addEventListener("click", () => {
    if (!activeMessageElement) return;
    const messageId = activeMessageElement.dataset.messageId;
    if (!messageId) return;

    deleteMessage(messageId, false, activeMessageElement);
    closeDeleteConfirmModal();
    closeContextMenu();
  });
}

// ============================================
// === ОБРАБОТЧИКИ МОДАЛКИ ОЧИСТКИ ЧАТА ===
// ============================================

// Закрытие модалки при клике на overlay
if (clearChatConfirmOverlay) {
  clearChatConfirmOverlay.addEventListener("click", (e) => {
    if (e.target === clearChatConfirmOverlay) {
      closeClearChatConfirmModal();
    }
  });
}

// Обработчик "Очистить у всех"
if (clearForAllOption) {
  clearForAllOption.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("Нажата кнопка 'Очистить у всех'");

    if (!activeChatId) {
      alert("Нет активного чата");
      return;
    }

    if (clearForAllOption.classList.contains("disabled")) {
      console.warn("Опция отключена");
      return;
    }

    console.log("Выполняю очистку чата для всех");
    clearChat(true);
    closeClearChatConfirmModal();
  });
}

// Обработчик "Очистить у себя"
if (clearForSelfOption) {
  clearForSelfOption.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("Нажата кнопка 'Очистить у себя'");

    if (!activeChatId) {
      alert("Нет активного чата");
      return;
    }

    console.log("Выполняю очистку чата для себя");
    clearChat(false);
    closeClearChatConfirmModal();
  });
}

if (forwardCloseBtn) {
  forwardCloseBtn.addEventListener("click", () => {
    closeForwardModal();
  });
}
if (forwardCancelBtn) {
  forwardCancelBtn.addEventListener("click", () => {
    closeForwardModal();
  });
}
if (forwardModal) {
  forwardModal.addEventListener("click", (e) => {
    if (e.target === forwardModal) {
      closeForwardModal();
    }
  });
}
if (forwardSearchInput) {
  forwardSearchInput.addEventListener("input", (e) => {
    const v = e.target.value;
    if (forwardSearchTimer) clearTimeout(forwardSearchTimer);
    forwardSearchTimer = setTimeout(() => {
      if (!v.trim()) {
        renderForwardRecipients(allForwardContacts, "");
        return;
        }
      triggerForwardSearch(v);
    }, 300);
  });
}
if (forwardForm) {
  forwardForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!forwardSource || forwardSelected.size === 0) {
      if (forwardError) {
        forwardError.textContent = "Выберите получателей";
        forwardError.classList.remove("hidden");
      }
      return;
    }
    const emails = Array.from(forwardSelected);
    forwardSendBtn.disabled = true;
    try {
      for (const email of emails) {
        const chatId = await ensureChatWith(email);
        if (forwardSource.type === "text") {
          const payloadText = buildForwardPayload(forwardSource);
          await sendForwardToChat(chatId, payloadText);
        } else if (
          forwardSource.type === "image" ||
          forwardSource.type === "video" ||
          forwardSource.type === "file"
        ) {
          if (!forwardSource.url) throw new Error("Нет URL медиа");
          const media = await fetchBlobWithName(
            forwardSource.url,
            forwardSource.filename || filenameFromUrl(forwardSource.url)
          );
          const fd = new FormData();
          // Добавим короткий префикс, если есть текст
          const caption = buildForwardPayload(forwardSource);
          if (caption && forwardSource.type !== "file") {
            fd.append("message_content", caption);
          }
          fd.append("file", media.file, media.name);
          const resp = await fetch(`${API_BASE_URL}/api/send_message/${chatId}`, {
            method: "POST",
            credentials: "include",
            body: fd,
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const msg = err.detail || "Ошибка отправки медиа";
            throw new Error(msg);
          }
        } else if (forwardSource.type === "audio") {
          if (!forwardSource.url) throw new Error("Нет URL аудио");
          const media = await fetchBlobWithName(
            forwardSource.url,
            filenameFromUrl(forwardSource.url, "voice_message.mp3")
          );
          const fd = new FormData();
          fd.append("file", media.file, media.name);
          const resp = await fetch(`${API_BASE_URL}/api/upload_audio/${chatId}`, {
            method: "POST",
            credentials: "include",
            body: fd,
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const msg = err.detail || "Ошибка пересылки голосового";
            throw new Error(msg);
          }
        } else {
          const payloadText = buildForwardPayload(forwardSource);
          await sendForwardToChat(chatId, payloadText);
        }
      }
      closeForwardModal();
    } catch (err) {
      if (forwardError) {
        forwardError.textContent = err.message || "Ошибка пересылки";
        forwardError.classList.remove("hidden");
      }
    } finally {
      forwardSendBtn.disabled = false;
    }
  });
}

// ============================================
// === ОБРАБОТЧИКИ МОДАЛКИ УДАЛЕНИЯ ЧАТА ===
// ============================================

// Закрытие модалки при клике на overlay
if (deleteChatConfirmOverlay) {
  deleteChatConfirmOverlay.addEventListener("click", (e) => {
    if (e.target === deleteChatConfirmOverlay) {
      closeDeleteChatConfirmModal();
    }
  });
}

// Обработчик "Удалить у всех"
if (deleteChatForAllOption) {
  deleteChatForAllOption.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("Нажата кнопка 'Удалить у всех'");

    if (!activeChatId) {
      alert("Нет активного чата");
      return;
    }

    if (deleteChatForAllOption.classList.contains("disabled")) {
      console.warn("Опция отключена");
      return;
    }

    console.log("Выполняю удаление чата для всех");
    deleteChat(true);
    closeDeleteChatConfirmModal();
  });
}

// Обработчик "Удалить у себя"
if (deleteChatForSelfOption) {
  deleteChatForSelfOption.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("Нажата кнопка 'Удалить у себя'");

    if (!activeChatId) {
      alert("Нет активного чата");
      return;
    }

    console.log("Выполняю удаление чата для себя");
    deleteChat(false);
    closeDeleteChatConfirmModal();
  });
}

// ========================================================
// === Загрузка страницы (без изменений) ===
// ========================================================

// ====================================
// === ПЕРЕКЛЮЧЕНИЕ МЕЖДУ ВКЛАДКАМИ ===
// ====================================
// === МОДАЛЬНОЕ ОКНО ПРОФИЛЯ ===
// ====================================

/**
 * Открывает профиль пользователя (правая боковая панель по Figma)
 * @param {string} userEmail - Email пользователя для загрузки данных
 */
async function openProfileModal(userEmail) {
  if (!profileSection || !userEmail) return;
  currentProfileEmail = userEmail;
  // Сохраняем email в dataset для использования в обработчиках
  profileSection.dataset.userEmail = userEmail;

  // Проверяем, является ли это ботом
  const isBot =
    userEmail &&
    userEmail.startsWith("bot_") &&
    userEmail.endsWith("@flicker.local");

  if (isBot) {
    // Обработка профиля бота
    const botId = userEmail.replace("bot_", "").replace("@flicker.local", "");

    try {
      // Загружаем информацию о боте
      const response = await fetch(`${API_BASE_URL}/api/bots`, {
        credentials: "include",
      });

      if (response.ok) {
        const data = await response.json();
        const bot = data.bots?.find((b) => b.bot_id === botId);

        if (bot) {
          // Заполняем данные профиля бота
          if (profileName) {
            profileName.textContent = bot.name || "Бот";
          }
          if (profileUsername) {
            profileUsername.textContent = "";
            profileUsername.classList.add("hidden");
          }
          if (profileEmail) {
            profileEmail.textContent =
              bot.description || "Нейросеть для общения";
          }
          if (profileQuote) {
            profileQuote.textContent = "бот";
          }
          if (profileHeaderBgImg) {
            const botName = bot.name || "Бот";
            const avatarUrl = (bot.avatar && !bot.avatar.includes("юзер.svg")) ? bot.avatar : generateAvatar(botName, botId);
            profileHeaderBgImg.src = avatarUrl;
            profileHeaderBgImg.onerror = function () {
              this.src = generateAvatar(botName, botId);
              this.onerror = null;
            };
          }

          // Скрываем кнопки звонков для ботов
          if (profileCallBtn) profileCallBtn.style.display = "none";
          if (profileVideoCallBtn) profileVideoCallBtn.style.display = "none";
          if (profileGiftBtn) profileGiftBtn.style.display = "none";

          // Скрываем кнопку "Добавить участника" для ботов
          const profileAddMemberBtn = document.getElementById(
            "profileAddMemberBtn"
          );
          if (profileAddMemberBtn) {
            profileAddMemberBtn.classList.add("hidden");
            profileAddMemberBtn.style.display = "none";
          }

          // Скрываем вкладку участников для ботов
          const profileParticipantsTab = document.querySelector(
            ".profile-participants-tab"
          );
          if (profileParticipantsTab) {
            profileParticipantsTab.classList.add("hidden");
          }

          // Очищаем данные участников группы
          window.currentGroupParticipantsData = null;

          // Блок редактирования профиля скрываем для ботов
          if (profileEditSection) {
            profileEditSection.classList.add("hidden");
          }

          // Показываем профиль
          profileSection.classList.remove("hidden");
          const app = document.querySelector(".app");
          if (app) {
            app.classList.add("profile-open");
          }
          return;
        }
      }
    } catch (error) {
      console.error("Ошибка загрузки данных бота:", error);
    }
  }

  try {
    // Загружаем данные пользователя
    const response = await fetch(
      `${API_BASE_URL}/api/user_profile?email=${encodeURIComponent(userEmail)}`,
      {
        credentials: "include", // Включаем cookies для аутентификации
      }
    );
    if (!response.ok) {
      throw new Error("Не удалось загрузить данные пользователя");
    }

    const userData = await response.json();
    const isSelfProfile = userData.email === currentUserEmail;

    // Для своего профиля скрываем "Звонок/Видео/Подарок/Сообщение/меню" (не звонят/не пишут сами себе)
    if (isSelfProfile) {
      if (profileCallBtn) profileCallBtn.style.display = "none";
      if (profileVideoCallBtn) profileVideoCallBtn.style.display = "none";
      if (profileGiftBtn) profileGiftBtn.style.display = "none";
      if (profileMessageBtn) profileMessageBtn.style.display = "none";
      if (profileMenuBtn) profileMenuBtn.style.display = "none";
    } else {
      if (profileCallBtn) profileCallBtn.style.display = "";
      if (profileVideoCallBtn) profileVideoCallBtn.style.display = "";
      if (profileGiftBtn) profileGiftBtn.style.display = "";
      if (profileMessageBtn) profileMessageBtn.style.display = "";
      if (profileMenuBtn) profileMenuBtn.style.display = "";
    }

    // Скрываем кнопку "Добавить участника" для обычных пользователей
    const profileAddMemberBtn = document.getElementById("profileAddMemberBtn");
    if (profileAddMemberBtn) {
      profileAddMemberBtn.classList.add("hidden");
      profileAddMemberBtn.style.display = "none";
    }

    // Скрываем вкладку участников для обычных чатов
    const profileParticipantsTab = document.querySelector(
      ".profile-participants-tab"
    );
    if (profileParticipantsTab) {
      profileParticipantsTab.classList.add("hidden");
    }

    // Очищаем данные участников группы
    window.currentGroupParticipantsData = null;

    // Вычисляем отображаемое имя для использования в заголовке и аватаре
    let displayName = userData.full_name || userData.username || userData.email.split("@")[0];

    // Если пользователь есть в контактах — используем то имя, как он записан в контактах
    try {
      const contactsMap = window.CONTACTS_BY_EMAIL || {};
      const contactInfo = contactsMap[userData.email];
      if (contactInfo) {
        displayName =
          contactInfo.contact_name ||
          contactInfo.display_name ||
          contactInfo.full_name ||
          contactInfo.username ||
          displayName;
      }
    } catch (e) {
      // Не ломаем модалку, если что-то с картой контактов
    }

    // Заполняем данные профиля
    if (profileName) {
      profileName.textContent = displayName;
    }

    if (profileUsername) {
      const un = (userData.username || "").trim();
      if (un) {
        profileUsername.textContent = un.startsWith("@") ? un : `@${un}`;
        profileUsername.classList.remove("hidden");
      } else {
        profileUsername.textContent = "";
        profileUsername.classList.add("hidden");
      }
    }

    if (profileEmail) {
      profileEmail.textContent = userData.email || "user@example.com";
    }

    if (profileQuote) {
      // В своём профиле показываем "О себе" (если есть)
      profileQuote.textContent =
        isSelfProfile && userData.about ? userData.about : "Цитата дня!";
    }

    // Устанавливаем фоновое изображение (аватар как фон)
    if (profileHeaderBgImg) {
      const avatarUrl = (!isDefaultAvatar(userData.profile_picture))
        ? userData.profile_picture
        : generateAvatar(displayName, userData.email);

      profileHeaderBgImg.src = avatarUrl;
      profileHeaderBgImg.onerror = function () {
        this.src = generateAvatar(displayName, userData.email);
        this.onerror = null;
      };
    }

    // === Показываем/заполняем форму редактирования только для своего профиля ===
    if (profileEditSection) {
      if (isSelfProfile) {
        profileEditSection.classList.remove("hidden");
        if (profileEditNameInput) {
          profileEditNameInput.value =
            userData.full_name || userData.first_name || "";
        }
        if (profileEditUsernameInput) {
          profileEditUsernameInput.value = userData.username || "";
        }
        if (profileEditEmailInput) {
          profileEditEmailInput.value = userData.email || "";
        }
        if (profileEditAboutInput) {
          profileEditAboutInput.value = userData.about || "";
        }
        if (profileEditStatus) {
          profileEditStatus.textContent = "";
          profileEditStatus.classList.add("hidden");
          profileEditStatus.classList.remove(
            "profile-edit-status--success",
            "profile-edit-status--error"
          );
        }
      } else {
        profileEditSection.classList.add("hidden");
      }
    }

    // Загружаем контент (медиа по умолчанию) из текущего чата
    loadProfileContent("media", userEmail);

    // Показываем профиль (правая боковая панель)
    profileSection.classList.remove("hidden");
    // Добавляем класс к app для уменьшения чата
    const app = document.querySelector(".app");
    if (app) {
      app.classList.add("profile-open");
    }
  } catch (error) {
    console.error("Ошибка загрузки профиля:", error);
    // На всякий случай скрываем блок редактирования
    if (profileEditSection) {
      profileEditSection.classList.add("hidden");
    }
    // Показываем профиль с базовыми данными из текущего чата
    const chatButton = document.querySelector(
      `.chat-list-item-btn[data-chat-id="${activeChatId}"]`
    );

    if (chatButton) {
      const interlocutorEmail = chatButton.dataset.interlocutorEmail;
      const isBot =
        interlocutorEmail &&
        interlocutorEmail.startsWith("bot_") &&
        interlocutorEmail.endsWith("@flicker.local");

      if (isBot) {
        // Для ботов используем данные из кнопки чата
        if (profileName) {
          profileName.textContent = chatButton.dataset.chatName || "Бот";
        }
        if (profileUsername) {
          profileUsername.textContent = "";
          profileUsername.classList.add("hidden");
        }
        if (profileEmail) {
          profileEmail.textContent = "бот";
        }
        if (profileHeaderBgImg && currentChatAvatar) {
          profileHeaderBgImg.src = currentChatAvatar.src;
        }
        // Скрываем кнопки звонков для ботов
        if (profileCallBtn) profileCallBtn.style.display = "none";
        if (profileVideoCallBtn) profileVideoCallBtn.style.display = "none";
        if (profileGiftBtn) profileGiftBtn.style.display = "none";

        // Скрываем вкладку участников для ботов
        const profileParticipantsTab = document.querySelector(
          ".profile-participants-tab"
        );
        if (profileParticipantsTab) {
          profileParticipantsTab.classList.add("hidden");
        }

        // Очищаем данные участников группы
        window.currentGroupParticipantsData = null;
      } else {
        // Для обычных пользователей
        const interlocutorUsername = (
          chatButton.dataset.interlocutorUsername || ""
        ).trim();
        if (profileName) {
          profileName.textContent =
            chatButton.dataset.chatName || "Пользователь";
        }
        if (profileUsername) {
          if (interlocutorUsername) {
            profileUsername.textContent = interlocutorUsername.startsWith("@")
              ? interlocutorUsername
              : `@${interlocutorUsername}`;
            profileUsername.classList.remove("hidden");
          } else {
            profileUsername.textContent = "";
            profileUsername.classList.add("hidden");
          }
        }
        if (profileEmail) {
          profileEmail.textContent = interlocutorEmail || "user@example.com";
        }
        if (profileHeaderBgImg && currentChatAvatar) {
          profileHeaderBgImg.src = currentChatAvatar.src;
        }
        // Показываем кнопки для обычных пользователей
        if (profileCallBtn) profileCallBtn.style.display = "";
        if (profileVideoCallBtn) profileVideoCallBtn.style.display = "";
        if (profileGiftBtn) profileGiftBtn.style.display = "";

        // Скрываем вкладку участников для обычных пользователей
        const profileParticipantsTab = document.querySelector(
          ".profile-participants-tab"
        );
        if (profileParticipantsTab) {
          profileParticipantsTab.classList.add("hidden");
        }

        // Очищаем данные участников группы
        window.currentGroupParticipantsData = null;
      }
    }

    profileSection.classList.remove("hidden");
    // Добавляем класс к app для уменьшения чата
    const app = document.querySelector(".app");
    if (app) {
      app.classList.add("profile-open");
    }
  }
}

// Делаем доступной глобально (используется из других мест, например из settings)
window.openProfileModal = openProfileModal;

/**
 * Получает активную вкладку профиля
 * @returns {string|null} - Тип активной вкладки или null
 */
function getActiveProfileTab() {
  if (!profileMediaTabs || profileMediaTabs.length === 0) return null;
  const activeTab = Array.from(profileMediaTabs).find((tab) =>
    tab.classList.contains("active")
  );
  return activeTab ? activeTab.dataset.tab : null;
}

// Глобальная переменная для хранения данных участников группы
window.currentGroupParticipantsData = null;

/**
 * Загружает контент для профиля (медиа/ссылки/файлы/голосовые/участники) из текущего чата
 * @param {string} tabType - Тип вкладки: 'media', 'links', 'files', 'voice', 'participants'
 * @param {string} userEmail - Email пользователя (для поиска чата) или chat_id для групп
 */
async function loadProfileContent(tabType, userEmail) {
  if (!profileContentArea) return;

  // Очищаем область
  profileContentArea.innerHTML = "";

  // Для вкладки участников используем сохраненные данные
  if (tabType === "participants") {
    if (window.currentGroupParticipantsData) {
      renderParticipants(
        window.currentGroupParticipantsData.participants || [],
        window.currentGroupParticipantsData.owner
      );
    } else {
      profileContentArea.innerHTML =
        '<div class="profile-participants-error">Не удалось загрузить участников</div>';
    }
    return;
  }

  // Если нет активного чата, не загружаем контент
  if (!activeChatId) {
    return;
  }

  try {
    let response;
    let data;

    switch (tabType) {
      case "media":
        response = await fetch(
          `${API_BASE_URL}/api/chat/${activeChatId}/media`,
          {
            credentials: "include",
          }
        );
        if (!response.ok) throw new Error("Не удалось загрузить медиа");
        data = await response.json();
        renderMedia(data.media || []);
        break;

      case "links":
        response = await fetch(
          `${API_BASE_URL}/api/chat/${activeChatId}/links`,
          {
            credentials: "include",
          }
        );
        if (!response.ok) throw new Error("Не удалось загрузить ссылки");
        data = await response.json();
        renderLinks(data.links || []);
        break;

      case "files":
        response = await fetch(
          `${API_BASE_URL}/api/chat/${activeChatId}/files`,
          {
            credentials: "include",
          }
        );
        if (!response.ok) throw new Error("Не удалось загрузить файлы");
        data = await response.json();
        renderFiles(data.files || []);
        break;

      case "voice":
        response = await fetch(
          `${API_BASE_URL}/api/chat/${activeChatId}/voice`,
          {
            credentials: "include",
          }
        );
        if (!response.ok)
          throw new Error("Не удалось загрузить голосовые сообщения");
        data = await response.json();
        renderVoice(data.voice || []);
        break;
    }
  } catch (error) {
    console.error(`Ошибка загрузки ${tabType}:`, error);
  }
}

/**
 * Отображает медиа в сетке
 */
function renderMedia(mediaItems) {
  if (!profileContentArea) return;

  profileContentArea.className = "profile-content-area profile-media-grid";

  if (mediaItems.length === 0) {
    return;
  }

  mediaItems.forEach((media) => {
    const mediaItem = document.createElement("div");
    mediaItem.className = "profile-media-item";

    if (media.type === "image" || media.type === "video") {
      const mediaContainer = document.createElement("div");
      mediaContainer.style.width = "100%";
      mediaContainer.style.height = "100%";
      mediaContainer.style.position = "relative";
      mediaContainer.style.overflow = "hidden";

      if (media.type === "video") {
        const video = document.createElement("video");
        video.src = media.file_url;
        video.style.width = "100%";
        video.style.height = "100%";
        video.style.objectFit = "cover";
        video.muted = true;
        video.preload = "metadata"; // Load metadata to show first frame
        // video.playsInline = true; // For iOS

        // Add duration badge if available
        if (media.duration) {
            const durationBadge = document.createElement("div");
            durationBadge.className = "media-duration-badge";
            durationBadge.textContent = formatDuration(media.duration);
            mediaContainer.appendChild(durationBadge);
        }

        mediaContainer.appendChild(video);
        
        const videoIcon = document.createElement("div");
        videoIcon.className = "profile-media-video-icon";
        videoIcon.innerHTML = "▶";
        mediaContainer.appendChild(videoIcon);
      } else {
        const img = document.createElement("img");
        img.src = media.file_url;
        img.alt = media.filename || "Медиа";
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "cover";
        img.onerror = function () {
            mediaItem.style.display = "none";
        };
        mediaContainer.appendChild(img);
      }

      mediaItem.appendChild(mediaContainer);

      // Добавляем обработчик клика для лайтбокса
      mediaItem.addEventListener("click", () => {
        openLightbox(media.file_url, media.type);
      });
    }

    profileContentArea.appendChild(mediaItem);
  });
}

// === Lightbox Logic ===
const mediaLightbox = document.getElementById("mediaLightbox");
const mediaLightboxImg = document.getElementById("mediaLightboxImg");
const mediaLightboxVideo = document.getElementById("mediaLightboxVideo");
const mediaLightboxClose = document.getElementById("mediaLightboxClose");

function openLightbox(url, type) {
  if (!mediaLightbox) return;
  mediaLightbox.classList.remove("hidden");
  
  if (type === "video") {
    if (mediaLightboxImg) mediaLightboxImg.classList.add("hidden");
    if (mediaLightboxVideo) {
      mediaLightboxVideo.classList.remove("hidden");
      mediaLightboxVideo.src = url;
      mediaLightboxVideo.play();
    }
  } else {
    if (mediaLightboxVideo) {
      mediaLightboxVideo.classList.add("hidden");
      mediaLightboxVideo.pause();
    }
    if (mediaLightboxImg) {
      mediaLightboxImg.classList.remove("hidden");
      mediaLightboxImg.src = url;
    }
  }
}

if (mediaLightboxClose) {
  mediaLightboxClose.addEventListener("click", () => {
    if (mediaLightbox) mediaLightbox.classList.add("hidden");
    if (mediaLightboxVideo) {
      mediaLightboxVideo.pause();
      mediaLightboxVideo.src = "";
    }
  });
}

if (mediaLightbox) {
  mediaLightbox.addEventListener("click", (e) => {
    if (e.target === mediaLightbox) {
      mediaLightbox.classList.add("hidden");
      if (mediaLightboxVideo) {
        mediaLightboxVideo.pause();
        mediaLightboxVideo.src = "";
      }
    }
  });
}

/**
 * Отображает ссылки по Figma
 */
function renderLinks(links) {
  if (!profileContentArea) return;

  profileContentArea.className = "profile-content-area profile-links-list";

  if (links.length === 0) {
    return;
  }

  // Группируем по датам
  const groupedByDate = {};
  links.forEach((link) => {
    const date = new Date(link.timestamp);
    const dateKey = date.toDateString();
    if (!groupedByDate[dateKey]) {
      groupedByDate[dateKey] = {
        date: date,
        items: [],
      };
    }
    groupedByDate[dateKey].items.push(link);
  });

  // Сортируем даты (новые сначала)
  const sortedDates = Object.keys(groupedByDate).sort((a, b) => {
    return groupedByDate[b].date - groupedByDate[a].date;
  });

  sortedDates.forEach((dateKey) => {
    // Заголовок даты
    const dateHeader = document.createElement("div");
    dateHeader.className = "profile-links-date-header";
    dateHeader.textContent = formatDateForLinks(groupedByDate[dateKey].date);
    profileContentArea.appendChild(dateHeader);

    // Ссылки этой даты
    groupedByDate[dateKey].items.forEach((link) => {
      const linkItem = document.createElement("button");
      linkItem.className = "profile-link-item";
      linkItem.type = "button";

      // Изображение превью (всегда показываем)
      const previewImg = document.createElement("div");
      previewImg.className = "profile-link-preview";
      const img = document.createElement("img");
      if (link.preview_image) {
        img.src = link.preview_image;
        img.style.display = "block";
      } else {
        // Получаем реальное Open Graph изображение через Microlink API
        img.style.display = "none"; // Скрываем до загрузки
        fetch(
          `https://api.microlink.io/data?url=${encodeURIComponent(link.url)}`
        )
          .then((response) => response.json())
          .then((data) => {
            if (data.data && data.data.image && data.data.image.url) {
              img.src = data.data.image.url;
              img.style.display = "block";
            } else {
              // Fallback на прямое изображение через Microlink
              img.src = `https://api.microlink.io/image?url=${encodeURIComponent(
                link.url
              )}`;
              img.style.display = "block";
            }
          })
          .catch(() => {
            // Если API недоступен, пробуем прямое изображение
            img.src = `https://api.microlink.io/image?url=${encodeURIComponent(
              link.url
            )}`;
            img.style.display = "block";
          });
        img.onerror = function () {
          // Если не удалось загрузить превью, скрываем изображение
          this.style.display = "none";
        };
      }
      img.alt = "";
      img.onload = function () {
        this.style.display = "block";
      };
      previewImg.appendChild(img);
      linkItem.appendChild(previewImg);

      // Информация о ссылке
      const linkInfo = document.createElement("div");
      linkInfo.className = "profile-link-info";

      // Заголовок (название сайта/домен)
      const linkTitle = document.createElement("div");
      linkTitle.className = "profile-link-title";
      // Извлекаем домен из URL для отображения
      try {
        const urlObj = new URL(link.url);
        linkTitle.textContent =
          link.title || urlObj.hostname.replace("www.", "");
      } catch {
        linkTitle.textContent = link.title || link.url;
      }
      linkInfo.appendChild(linkTitle);

      // URL ссылки
      const linkUrl = document.createElement("div");
      linkUrl.className = "profile-link-url";
      linkUrl.textContent = link.url;
      linkInfo.appendChild(linkUrl);

      linkItem.appendChild(linkInfo);

      // Обработчик клика
      linkItem.addEventListener("click", () => {
        window.open(link.url, "_blank");
      });

      profileContentArea.appendChild(linkItem);
    });
  });
}

/**
 * Отображает файлы по Figma (аналогично ссылкам)
 */
function renderFiles(files) {
  if (!profileContentArea) return;

  profileContentArea.className = "profile-content-area profile-files-list";

  if (files.length === 0) {
    return;
  }

  // Группируем по датам
  const groupedByDate = {};
  files.forEach((file) => {
    const date = new Date(file.timestamp);
    const dateKey = date.toDateString();
    if (!groupedByDate[dateKey]) {
      groupedByDate[dateKey] = {
        date: date,
        items: [],
      };
    }
    groupedByDate[dateKey].items.push(file);
  });

  // Сортируем даты (новые сначала)
  const sortedDates = Object.keys(groupedByDate).sort((a, b) => {
    return groupedByDate[b].date - groupedByDate[a].date;
  });

  sortedDates.forEach((dateKey) => {
    // Заголовок даты
    const dateHeader = document.createElement("div");
    dateHeader.className = "profile-files-date-header";
    dateHeader.textContent = formatDateForLinks(groupedByDate[dateKey].date);
    profileContentArea.appendChild(dateHeader);

    // Файлы этой даты
    groupedByDate[dateKey].items.forEach((file) => {
      const fileItem = document.createElement("button");
      fileItem.className = "profile-file-item";
      fileItem.type = "button";

      // Иконка файла
      const fileIcon = document.createElement("div");
      fileIcon.className = "profile-file-icon";
      fileIcon.innerHTML = "📎";
      fileItem.appendChild(fileIcon);

      // Информация о файле
      const fileInfo = document.createElement("div");
      fileInfo.className = "profile-file-info";

      // Название файла
      const fileName = document.createElement("div");
      fileName.className = "profile-file-name";
      fileName.textContent = file.filename || "Файл";
      fileInfo.appendChild(fileName);

      // Размер файла
      const fileSize = document.createElement("div");
      fileSize.className = "profile-file-size";
      fileSize.textContent = formatFileSize(file.size || 0);
      fileInfo.appendChild(fileSize);

      fileItem.appendChild(fileInfo);

      // Обработчик клика
      fileItem.addEventListener("click", () => {
        window.open(file.file_url, "_blank");
      });

      profileContentArea.appendChild(fileItem);
    });
  });
}

/**
 * Отображает голосовые сообщения согласно дизайну Figma
 */
function renderVoice(voiceItems) {
  if (!profileContentArea) return;

  profileContentArea.className = "profile-content-area profile-voice-list";

  if (voiceItems.length === 0) {
    return;
  }

  // Группируем по датам
  const groupedByDate = {};

  voiceItems.forEach((voice) => {
    const date = new Date(voice.timestamp);
    const dateKey = `${date.getFullYear()}-${String(
      date.getMonth() + 1
    ).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

    if (!groupedByDate[dateKey]) {
      groupedByDate[dateKey] = {
        date: date,
        items: [],
      };
    }
    groupedByDate[dateKey].items.push(voice);
  });

  // Сортируем даты (новые сначала)
  const sortedDates = Object.keys(groupedByDate).sort((a, b) => {
    return groupedByDate[b].date - groupedByDate[a].date;
  });

  sortedDates.forEach((dateKey, dateIndex) => {
    // Заголовок даты
    const dateHeader = document.createElement("div");
    dateHeader.className = "profile-voice-date-header";
    dateHeader.textContent = formatDateForLinks(groupedByDate[dateKey].date);
    profileContentArea.appendChild(dateHeader);

    // Голосовые сообщения этой даты
    const dateGroup = document.createElement("div");
    dateGroup.className = "profile-voice-date-group";

    groupedByDate[dateKey].items.forEach((voice, itemIndex) => {
      const voiceItem = document.createElement("button");
      voiceItem.className = "profile-voice-item";
      voiceItem.type = "button";

      // Первое сообщение имеет другой фон
      if (dateIndex === 0 && itemIndex === 0) {
        voiceItem.style.background = "#DAE0F2";
      }

      // SVG иконка голосового сообщения
      const voiceIcon = document.createElement("div");
      voiceIcon.className = "profile-voice-icon";
      voiceIcon.innerHTML = `<img src="/images/voise_messege.svg" alt="Голосовое сообщение" />`;

      voiceItem.appendChild(voiceIcon);

      // Информация о голосовом сообщении
      const voiceInfo = document.createElement("div");
      voiceInfo.className = "profile-voice-info";

      // Текст с датой
      const voiceTitle = document.createElement("div");
      voiceTitle.className = "profile-voice-title";
      const voiceDate = new Date(voice.timestamp);
      const formattedDate = `${String(voiceDate.getDate()).padStart(
        2,
        "0"
      )}.${String(voiceDate.getMonth() + 1).padStart(
        2,
        "0"
      )}.${voiceDate.getFullYear()}`;
      voiceTitle.textContent = `Голосовое сообщение от ${formattedDate}`;
      voiceInfo.appendChild(voiceTitle);

      // Время и визуализация
      const voiceMeta = document.createElement("div");
      voiceMeta.className = "profile-voice-meta";

      // Время
      const voiceTime = document.createElement("div");
      voiceTime.className = "profile-voice-time";
      const hours = String(voiceDate.getHours()).padStart(2, "0");
      const minutes = String(voiceDate.getMinutes()).padStart(2, "0");
      voiceTime.textContent = `${hours}:${minutes}`;
      voiceMeta.appendChild(voiceTime);

      // Визуализация волны
      const waveform = document.createElement("div");
      waveform.className = "profile-voice-waveform";
      for (let i = 0; i < 20; i++) {
        const bar = document.createElement("div");
        bar.className = "profile-voice-wave-bar";
        const height = 5 + Math.random() * 20;
        bar.style.height = `${Math.max(5, Math.min(25, height))}px`;
        waveform.appendChild(bar);
      }
      voiceMeta.appendChild(waveform);

      voiceInfo.appendChild(voiceMeta);
      voiceItem.appendChild(voiceInfo);

      // Обработчик клика
      voiceItem.addEventListener("click", () => {
        // Можно добавить воспроизведение аудио
        const audio = new Audio(voice.file_url);
        audio.play();
      });

      dateGroup.appendChild(voiceItem);
    });

    profileContentArea.appendChild(dateGroup);
  });
}

/**
 * Отображает участников группы
 * @param {Array} participants - Массив участников группы
 * @param {string} ownerEmail - Email владельца группы
 */
function renderParticipants(participants, ownerEmail) {
  if (!profileContentArea) return;

  profileContentArea.className =
    "profile-content-area profile-participants-list";

  if (participants.length === 0) {
    profileContentArea.innerHTML =
      '<div class="profile-participants-empty">Нет участников</div>';
    return;
  }

  participants.forEach((participant) => {
    const item = document.createElement("div");
    item.className = "profile-participant-item";

    let role = "Участник";
    if (participant.is_owner || participant.email === ownerEmail) {
      role = "Владелец";
    } else if (participant.is_admin) {
      role = "Админ";
    }

    item.innerHTML = `
      <img src="${participant.profile_picture || "/images/юзер.svg"}" alt="${
      participant.name
    }" />
      <div class="profile-participant-info">
        <div class="profile-participant-name">${participant.name}</div>
        <div class="profile-participant-role">${role}</div>
      </div>
    `;

    // Клик на участника открывает его профиль
    item.style.cursor = "pointer";
    item.addEventListener("click", () => {
      if (typeof window.openProfileModal === "function") {
        window.openProfileModal(participant.email);
      }
    });

    profileContentArea.appendChild(item);
  });
}

/**
 * Форматирует размер файла
 */
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Б";
  const k = 1024;
  const sizes = ["Б", "КБ", "МБ", "ГБ"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

/**
 * Форматирует дату для отображения в ссылках/файлах
 */
function formatDateForLinks(date) {
  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ];
  const day = date.getDate();
  const month = months[date.getMonth()];
  return `${day} ${month}`;
}

// ===================================
// === ФУНКЦИИ ДЛЯ РАБОТЫ С УПОМИНАНИЯМИ ===
// ===================================

/**
 * Инициализация элементов для упоминаний
 */
function initMentionsElements() {
  mentionsList = document.getElementById("mentionsList");
  mentionsListContent = document.getElementById("mentionsListContent");
}

/**
 * Обработка ввода для обнаружения @ и показа списка участников
 */
function handleMentionsInput(e) {
  if (!mentionsList || !mentionsListContent || !messageInput) return;

  // Показываем список участников только для групповых чатов
  if (!currentChatIsGroup) {
    hideMentionsList();
    return;
  }

  const text = messageInput.value;
  const cursorPos = messageInput.selectionStart;

  // Ищем @ перед курсором
  const textBeforeCursor = text.substring(0, cursorPos);
  const lastAtIndex = textBeforeCursor.lastIndexOf("@");

  // Проверяем, что @ не является частью другого слова (нет пробела между @ и курсором)
  if (lastAtIndex !== -1) {
    const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);
    // Проверяем, что после @ нет пробела или переноса строки
    if (!textAfterAt.includes(" ") && !textAfterAt.includes("\n")) {
      // Показываем список участников группы
      const searchQuery = textAfterAt.toLowerCase();
      showMentionsList(searchQuery, lastAtIndex);
      return;
    }
  }

  // Скрываем список, если @ не найден или уже есть пробел
  hideMentionsList();
}

/**
 * Показывает список участников для упоминаний
 */
function showMentionsList(searchQuery = "", mentionStart = -1) {
  if (!mentionsList || !mentionsListContent) return;
  if (!currentChatParticipants || currentChatParticipants.length === 0) {
    hideMentionsList();
    return;
  }

  currentMentionStart = mentionStart;
  selectedMentionIndex = -1;

  const queryNorm = (searchQuery || "").trim().toLowerCase().replace(/^@+/, "");
  const filtered = currentChatParticipants.filter((p) => {
    const name = (p.name || "").toLowerCase();
    const username = (p.username || "").toLowerCase().replace(/^@+/, "");
    const email = (p.email || "").toLowerCase();
    if (!queryNorm) return true;
    return (
      name.includes(queryNorm) ||
      username.includes(queryNorm) ||
      email.includes(queryNorm)
    );
  });

  if (filtered.length === 0) {
    hideMentionsList();
    return;
  }

  // Очищаем и заполняем список
  mentionsListContent.innerHTML = "";

  filtered.forEach((participant, index) => {
    const item = document.createElement("div");
    item.className = `mention-item ${index === 0 ? "selected" : ""}`;
    item.dataset.index = index;
    const u = (participant.username || "").replace(/^@+/, "");
    item.innerHTML = `
      <img src="${generateAvatar(participant.name, participant.email)}" alt="${participant.name}" />
      <div class="mention-item-info">
        <div class="mention-item-name">${participant.name}</div>
        <div class="mention-item-username">${u ? `@${u}` : ""}</div>
      </div>
    `;

    item.addEventListener("click", () => {
      insertMention(participant, mentionStart);
    });

    item.addEventListener("mouseenter", () => {
      selectedMentionIndex = index;
      updateMentionsSelection();
    });

    mentionsListContent.appendChild(item);
  });

  mentionsList.classList.remove("hidden");
  selectedMentionIndex = 0;
  updateMentionsSelection();
}

/**
 * Скрывает список упоминаний
 */
function hideMentionsList() {
  if (mentionsList) {
    mentionsList.classList.add("hidden");
  }
  currentMentionStart = -1;
  selectedMentionIndex = -1;
}

/**
 * Обновляет выделение в списке упоминаний
 */
function updateMentionsSelection() {
  const items = mentionsListContent?.querySelectorAll(".mention-item");
  if (!items) return;

  items.forEach((item, index) => {
    if (index === selectedMentionIndex) {
      item.classList.add("selected");
    } else {
      item.classList.remove("selected");
    }
  });
}

/**
 * Вставляет упоминание в поле ввода
 */
function insertMention(participant, mentionStart) {
  if (!messageInput || mentionStart === -1) return;

  const text = messageInput.value;
  const cursorPos = messageInput.selectionStart;

  let u = (participant.username || "").trim().replace(/^@+/, "");
  if (!u && participant.email) {
    const local = participant.email.split("@")[0];
    if (local) u = local;
  }
  const mentionText = u ? `@${u} ` : "";

  const textBefore = text.substring(0, mentionStart);
  const textAfter = text.substring(cursorPos);
  const newText = textBefore + mentionText + textAfter;

  messageInput.value = newText;

  const newCursorPos = mentionStart + mentionText.length;
  messageInput.setSelectionRange(newCursorPos, newCursorPos);

  hideMentionsList();

  // Триггерим событие input для обновления состояния
  messageInput.dispatchEvent(new Event("input"));
  messageInput.focus();
}

/**
 * Извлекает упоминания из текста сообщения
 */
function extractMentions(text) {
  const mentions = [];
  if (!text || !currentChatParticipants) return mentions;

  // Ищем все @username в тексте
  const mentionRegex = /@(\w+)/g;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    const username = match[1];
    // Находим участника по username
    const participant = currentChatParticipants.find(
      (p) => p.username === username || p.email.split("@")[0] === username
    );
    if (participant) {
      mentions.push({
        email: participant.email,
        username: participant.username || username,
      });
    }
  }

  return mentions;
}

/**
 * Обрабатывает текст сообщения и подсвечивает упоминания
 */
function processMessageTextWithMentions(text) {
  if (!text) return document.createTextNode("");

  // Создаем контейнер для фрагмента
  const fragment = document.createDocumentFragment();
  const mentionRegex = /@(\w+)/g;
  let lastIndex = 0;
  let match;

  while ((match = mentionRegex.exec(text)) !== null) {
    // Добавляем текст до упоминания (с поддержкой эмодзи)
    if (match.index > lastIndex) {
      renderTextWithEmojis(fragment, text.substring(lastIndex, match.index));
    }

    // Создаем элемент для упоминания
    const mentionSpan = document.createElement("span");
    mentionSpan.className = "message-mention";
    mentionSpan.textContent = match[0]; // @username
    mentionSpan.title = `Упоминание @${match[1]}`;

    // Сохраняем username для перехода в чат
    const username = match[1];
    mentionSpan.dataset.mentionUsername = username;

    // Находим участника по username для получения email
    let foundEmail = null;

    // Сначала ищем в участниках текущего чата
    if (currentChatParticipants && currentChatParticipants.length > 0) {
      const participant = currentChatParticipants.find(
        (p) => p.username === username || p.email.split("@")[0] === username
      );
      if (participant) {
        foundEmail = participant.email;
      }
    }

    // Если не нашли в участниках чата, ищем в контактах
    if (!foundEmail) {
      try {
        const contactsMap = window.CONTACTS_BY_EMAIL || {};
        for (const [email, contact] of Object.entries(contactsMap)) {
          const contactUsername = contact.username || email.split("@")[0];
          if (
            contactUsername === username ||
            contactUsername.toLowerCase() === username.toLowerCase()
          ) {
            foundEmail = email;
            break;
          }
        }
      } catch (e) {
        // Игнорируем ошибки
      }
    }

    if (foundEmail) {
      mentionSpan.dataset.mentionEmail = foundEmail;
    }

    // Добавляем обработчик клика для перехода в чат
    mentionSpan.addEventListener("click", (e) => {
      e.stopPropagation();
      handleMentionClick(mentionSpan);
    });

    fragment.appendChild(mentionSpan);

    lastIndex = match.index + match[0].length;
  }

  // Добавляем оставшийся текст (с поддержкой эмодзи)
  if (lastIndex < text.length) {
    renderTextWithEmojis(fragment, text.substring(lastIndex));
  }

  return fragment;
}

/**
 * Обрабатывает клик на упоминание - открывает чат с пользователем
 */
async function handleMentionClick(mentionElement) {
  const email = mentionElement.dataset.mentionEmail;
  const username = mentionElement.dataset.mentionUsername;

  if (!email && !username) return;

  // Проверяем, является ли это упоминанием самого пользователя
  if (
    email === currentUserEmail ||
    (username &&
      currentUserEmail &&
      currentUserEmail.split("@")[0] === username)
  ) {
    // Открываем избранное
    try {
      const chatButtons = document.querySelectorAll(".chat-list-item-btn");
      let favoriteChat = null;

      for (const btn of chatButtons) {
        if (btn.dataset.isFavorite === "true") {
          favoriteChat = btn;
          break;
        }
      }

      if (favoriteChat) {
        const chatId = favoriteChat.dataset.chatId;
        if (chatId) {
          // Переключаемся на вкладку "Чаты" если нужно
          const chatsButton = document.getElementById("chatsButton");
          if (chatsButton) {
            if (!chatsButton.classList.contains("active")) {
              if (typeof window.switchTab === "function") {
                window.switchTab("chats");
              } else {
                chatsButton.click();
              }
            }
          }

          // Открываем избранное
          const loadChatFunc = window.loadChat || loadChat;
          if (loadChatFunc && typeof loadChatFunc === "function") {
            await loadChatFunc(chatId);
          }
        }
      } else {
        // Если избранное не найдено, пытаемся открыть через URL
        window.location.href = "/@favorit";
      }
      return;
    } catch (error) {
      console.error("Ошибка при открытии избранного:", error);
      window.location.href = "/@favorit";
      return;
    }
  }

  try {
    // Сначала ищем чат с этим пользователем в списке чатов
    const chatButtons = document.querySelectorAll(".chat-list-item-btn");
    let targetChat = null;

    for (const btn of chatButtons) {
      const interlocutorEmail = btn.dataset.interlocutorEmail;
      const interlocutorUsername = btn.dataset.interlocutorUsername;

      // Проверяем совпадение по email или username
      if (email && interlocutorEmail === email) {
        targetChat = btn;
        break;
      }
      if (username && interlocutorUsername) {
        const btnUsername = interlocutorUsername.toLowerCase();
        const mentionUsername = username.toLowerCase();
        if (
          btnUsername === mentionUsername ||
          btnUsername === `@${mentionUsername}` ||
          btnUsername.replace("@", "") === mentionUsername
        ) {
          targetChat = btn;
          break;
        }
      }
    }

    if (targetChat) {
      // Чат найден - открываем его
      const chatId = targetChat.dataset.chatId;
      if (chatId) {
        // Переключаемся на вкладку "Чаты" если нужно
        const chatsButton = document.getElementById("chatsButton");
        if (chatsButton) {
          if (!chatsButton.classList.contains("active")) {
            if (typeof window.switchTab === "function") {
              window.switchTab("chats");
            } else {
              chatsButton.click();
            }
          }
        }

        // Открываем чат
        const loadChatFunc = window.loadChat || loadChat;
        if (loadChatFunc && typeof loadChatFunc === "function") {
          await loadChatFunc(chatId);
        }
      }
    } else if (email) {
      // Чат не найден, но есть email - создаем новый чат через API
      const formData = new FormData();
      formData.append("target_email", email);

      const response = await fetch(`${API_BASE_URL}/api/start_chat`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        if (data.chat_id) {
          // Переключаемся на вкладку "Чаты" если нужно
          const chatsButton = document.getElementById("chatsButton");
          if (chatsButton) {
            if (!chatsButton.classList.contains("active")) {
              if (typeof window.switchTab === "function") {
                window.switchTab("chats");
              } else {
                chatsButton.click();
              }
            }
          }

          // Открываем чат
          const loadChatFunc = window.loadChat || loadChat;
          if (loadChatFunc && typeof loadChatFunc === "function") {
            await loadChatFunc(data.chat_id);
          }
        }
      } else {
        console.error("Не удалось создать чат с пользователем:", email);
        const errorData = await response.json().catch(() => ({}));
        alert(
          errorData.detail || "Не удалось открыть чат с этим пользователем"
        );
      }
    } else {
      // Только username без email - пытаемся найти через поиск
      console.warn("Не удалось найти email для username:", username);
      alert(`Не удалось найти пользователя @${username}`);
    }
  } catch (error) {
    console.error("Ошибка при открытии чата с упоминанием:", error);
    alert("Произошла ошибка при открытии чата");
  }
}

/**
 * Обработка клавиатуры для навигации по списку упоминаний
 */
function handleMentionsKeydown(e) {
  if (!mentionsList || mentionsList.classList.contains("hidden")) return;

  const items = mentionsListContent?.querySelectorAll(".mention-item");
  if (!items || items.length === 0) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedMentionIndex = (selectedMentionIndex + 1) % items.length;
    updateMentionsSelection();
    items[selectedMentionIndex].scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedMentionIndex =
      selectedMentionIndex <= 0 ? items.length - 1 : selectedMentionIndex - 1;
    updateMentionsSelection();
    items[selectedMentionIndex].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    const selectedItem = items[selectedMentionIndex];
    if (selectedItem) {
      const text = messageInput.value.substring(0, messageInput.selectionStart);
      const lastAtIndex = text.lastIndexOf("@");
      const queryNorm = (text.substring(lastAtIndex + 1) || "")
        .trim()
        .toLowerCase()
        .replace(/^@+/, "");
      const filtered = currentChatParticipants.filter((part) => {
        const name = (part.name || "").toLowerCase();
        const username = (part.username || "").toLowerCase().replace(/^@+/, "");
        const email = (part.email || "").toLowerCase();
        if (!queryNorm) return true;
        return (
          name.includes(queryNorm) ||
          username.includes(queryNorm) ||
          email.includes(queryNorm)
        );
      });
      if (filtered[selectedMentionIndex]) {
        insertMention(filtered[selectedMentionIndex], currentMentionStart);
      }
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    hideMentionsList();
  }
}

/**
 * Закрывает профиль
 */
function closeProfileModal() {
  if (!profileSection) return;
  profileSection.classList.add("hidden");
  // Убираем класс с app для восстановления размера чата
  const app = document.querySelector(".app");
  if (app) {
    app.classList.remove("profile-open");
  }

  // Скрываем кнопку "Добавить участника" при закрытии профиля
  const profileAddMemberBtn = document.getElementById("profileAddMemberBtn");
  if (profileAddMemberBtn) {
    profileAddMemberBtn.classList.add("hidden");
    profileAddMemberBtn.style.display = "none";
  }

  // Очищаем сохраненный chat_id группы
  window.currentGroupChatId = null;
}

// Обработчики для профиля
if (profileBackBtn) {
  profileBackBtn.addEventListener("click", closeProfileModal);
}

// Обработчики для вкладок медиа (используем делегирование событий для динамических вкладок)
const profileMediaTabsContainer = document.querySelector(".profile-media-tabs");
if (profileMediaTabsContainer) {
  profileMediaTabsContainer.addEventListener("click", (e) => {
    const tab = e.target.closest(".profile-media-tab");
    if (!tab) return;

    // Убираем активный класс у всех вкладок
    const allTabs =
      profileMediaTabsContainer.querySelectorAll(".profile-media-tab");
    allTabs.forEach((t) => t.classList.remove("active"));

    // Добавляем активный класс к выбранной вкладке
    tab.classList.add("active");

    // Загружаем соответствующий контент
    const tabType = tab.dataset.tab;
    const emailForContent = currentProfileEmail || window.CURRENT_USER_EMAIL;
    loadProfileContent(tabType, emailForContent);
  });
}

// Глобальные горячие клавиши: Escape, Ctrl+Enter (отправить), Ctrl+K (поиск)
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    profileSection &&
    !profileSection.classList.contains("hidden")
  ) {
    closeProfileModal();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    if (
      messageForm &&
      activeChatId &&
      messageInput &&
      messageInput.value.trim()
    ) {
      messageForm.requestSubmit();
      e.preventDefault();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (searchInput) {
      searchInput.focus();
      if (typeof searchInput.select === "function") searchInput.select();
    }
  }
});

// Кнопка/пункт "Мой профиль" в настройках
function _setMyProfileStatus(text, kind) {
  if (!myProfileStatus) return;
  myProfileStatus.textContent = text || "";
  if (!text) {
    myProfileStatus.classList.add("hidden");
  } else {
    myProfileStatus.classList.remove("hidden");
  }
  myProfileStatus.classList.remove(
    "my-profile-status--ok",
    "my-profile-status--err"
  );
  if (kind === "ok") myProfileStatus.classList.add("my-profile-status--ok");
  if (kind === "err") myProfileStatus.classList.add("my-profile-status--err");
}

function closeMyProfileSettingsPanel() {
  if (myProfileSettingsPanel) myProfileSettingsPanel.classList.add("hidden");
  if (privacySettingsPanel) privacySettingsPanel.classList.add("hidden");
  if (settingsInfoContent) settingsInfoContent.classList.remove("hidden");
  if (settingsInfo) settingsInfo.classList.remove("has-my-profile");
  _setMyProfileStatus("", null);
  if (typeof _setPrivacyStatus === "function") _setPrivacyStatus("", null);
  /* Сбрасываем превью аватарки: показываем сохранённую, отзываем object URL */
  if (_myProfilePreviewObjectUrl) {
    if (myProfileAvatarImg)
      myProfileAvatarImg.src = _myProfileSavedAvatarUrl || "/images/юзер.svg";
    URL.revokeObjectURL(_myProfilePreviewObjectUrl);
    _myProfilePreviewObjectUrl = null;
  }
  if (myProfileAvatarInput) myProfileAvatarInput.value = "";
}

async function openMyProfileSettingsPanel() {
  if (!currentUserEmail) return;
  if (!myProfileSettingsPanel || !settingsInfo) return;

  // Закрываем панель конфиденциальности, если она открыта
  if (
    privacySettingsPanel &&
    !privacySettingsPanel.classList.contains("hidden")
  ) {
    closePrivacySettingsPanel();
  }

  // Убеждаемся, что открыта вкладка настроек
  if (window.switchTab && typeof window.switchTab === "function") {
    window.switchTab("settings");
  }

  if (settingsInfoContent) settingsInfoContent.classList.add("hidden");
  settingsInfo.classList.add("has-my-profile");
  myProfileSettingsPanel.classList.remove("hidden");
  _setMyProfileStatus("Загружаем профиль…", null);

  try {
    const resp = await fetch(
      `${API_BASE_URL}/api/user_profile?email=${encodeURIComponent(
        currentUserEmail
      )}`,
      {
        credentials: "include",
      }
    );
    if (!resp.ok) throw new Error("Не удалось загрузить профиль");
    const userData = await resp.json();

    const fullName =
      userData.full_name ||
      userData.username ||
      (userData.email ? userData.email.split("@")[0] : "Пользователь");
    const username = userData.username || "";
    const email = userData.email || "";
    const avatarUrl = (!isDefaultAvatar(userData.profile_picture))
      ? userData.profile_picture
      : generateAvatar(fullName, email);
    const about = userData.about || "";

    if (myProfileDisplayName) myProfileDisplayName.textContent = fullName;
    if (myProfileEmailText) myProfileEmailText.textContent = email;
    if (myProfileUsernameChip)
      myProfileUsernameChip.textContent = username ? `@${username}` : "@";
    _myProfileSavedAvatarUrl = avatarUrl;
    if (myProfileAvatarImg) myProfileAvatarImg.src = avatarUrl;
    if (_myProfilePreviewObjectUrl) {
      URL.revokeObjectURL(_myProfilePreviewObjectUrl);
      _myProfilePreviewObjectUrl = null;
    }

    if (myProfileNameInput) myProfileNameInput.value = fullName;
    if (myProfileUsernameInput) myProfileUsernameInput.value = username;
    if (myProfileEmailInput) myProfileEmailInput.value = email;
    if (myProfileAboutInput) myProfileAboutInput.value = about;

    _setMyProfileStatus("", null);
  } catch (e) {
    console.error(e);
    _setMyProfileStatus("Ошибка загрузки профиля", "err");
  }
}

if (myProfileSettingsItem) {
  myProfileSettingsItem.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMyProfileSettingsPanel();
  });
}

if (myProfileSettingsCloseBtn) {
  myProfileSettingsCloseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMyProfileSettingsPanel();
  });
}

if (myProfileAvatarBtn && myProfileAvatarInput) {
  myProfileAvatarBtn.addEventListener("click", (e) => {
    e.preventDefault();
    myProfileAvatarInput.click();
  });
}

/* Превью аватарки при выборе файла; сохраняется для всех только по «Сохранить» */
if (myProfileAvatarInput && myProfileAvatarImg) {
  myProfileAvatarInput.addEventListener("change", () => {
    const file = myProfileAvatarInput.files && myProfileAvatarInput.files[0];
    if (!file) {
      if (_myProfilePreviewObjectUrl) {
        myProfileAvatarImg.src = _myProfileSavedAvatarUrl || "/images/юзер.svg";
        URL.revokeObjectURL(_myProfilePreviewObjectUrl);
        _myProfilePreviewObjectUrl = null;
      }
      return;
    }
    if (_myProfilePreviewObjectUrl)
      URL.revokeObjectURL(_myProfilePreviewObjectUrl);
    _myProfilePreviewObjectUrl = URL.createObjectURL(file);
    myProfileAvatarImg.src = _myProfilePreviewObjectUrl;
  });
}

if (myProfileForm) {
  myProfileForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUserEmail) return;

    if (myProfileSaveBtn) myProfileSaveBtn.disabled = true;
    _setMyProfileStatus("Сохраняем…", null);

    try {
      const fd = new FormData();

      const usernameRaw = (myProfileUsernameInput?.value || "").trim();
      const username = usernameRaw.replace(/^@+/, "");
      const name = (myProfileNameInput?.value || "").trim();
      const about = (myProfileAboutInput?.value || "").trim();
      const avatarFile =
        myProfileAvatarInput &&
        myProfileAvatarInput.files &&
        myProfileAvatarInput.files[0]
          ? myProfileAvatarInput.files[0]
          : null;

      if (username) fd.append("username", username);
      if (name) fd.append("first_name", name);
      if (about) fd.append("about", about);
      if (avatarFile) fd.append("profile_picture", avatarFile);

      const resp = await fetch(`${API_BASE_URL}/api/profile/update`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });

      if (!resp.ok) {
        let msg = "Не удалось сохранить профиль";
        try {
          const err = await resp.json();
          if (err?.detail) msg = err.detail;
        } catch (_) {}
        if (resp.status === 409) msg = "Никнейм уже занят.";
        _setMyProfileStatus(msg, "err");
        return;
      }

      const data = await resp.json();

      // Обновляем UI в правой панели
      const oldChip =
        myProfileUsernameChip && myProfileUsernameChip.textContent
          ? myProfileUsernameChip.textContent.replace(/^@+/, "").trim()
          : "";
      const newName =
        data.full_name ||
        name ||
        username ||
        (myProfileDisplayName ? myProfileDisplayName.textContent : "");
      const newUsername =
        (data.username != null ? data.username : username) || oldChip;
      const newEmail =
        data.user_email ||
        (myProfileEmailText ? myProfileEmailText.textContent : "");
      if (myProfileDisplayName && newName)
        myProfileDisplayName.textContent = newName;
      if (myProfileEmailText && newEmail)
        myProfileEmailText.textContent = newEmail;
      if (myProfileUsernameChip)
        myProfileUsernameChip.textContent = newUsername
          ? `@${newUsername}`
          : myProfileUsernameChip.textContent;

      if (data.avatar_url) {
        const u = data.avatar_url;
        const bust = u.includes("?")
          ? `${u}&t=${Date.now()}`
          : `${u}?t=${Date.now()}`;
        if (_myProfilePreviewObjectUrl) {
          URL.revokeObjectURL(_myProfilePreviewObjectUrl);
          _myProfilePreviewObjectUrl = null;
        }
        _myProfileSavedAvatarUrl = bust;
        if (myProfileAvatarImg) myProfileAvatarImg.src = bust;

        // Обновляем аватар в пункте настроек слева
        if (myProfileSettingsItem) {
          const avatarImg = myProfileSettingsItem.querySelector("img");
          if (avatarImg) avatarImg.src = bust;
        }
        if (document.body) document.body.dataset.userAvatar = u;
      }

      // Сразу обновляем имя и ник слева в пункте «Мой профиль» (без перезагрузки)
      if (myProfileSettingsItem) {
        const titleEl = myProfileSettingsItem.querySelector(
          ".settings-item-title"
        );
        const subtitleEl = myProfileSettingsItem.querySelector(
          ".settings-item-subtitle"
        );
        if (titleEl && newName) titleEl.textContent = newName;
        if (subtitleEl)
          subtitleEl.innerHTML =
            (newEmail || "") +
            (newEmail && newUsername ? "<br />" : "") +
            (newUsername ? `@${newUsername}` : "");
      }

      _setMyProfileStatus("Сохранено", "ok");
      if (myProfileAvatarInput) myProfileAvatarInput.value = "";
    } catch (err) {
      console.error(err);
      _setMyProfileStatus("Ошибка при сохранении", "err");
    } finally {
      if (myProfileSaveBtn) myProfileSaveBtn.disabled = false;
    }
  });
}

// Клик по "Изменить фото" -> выбор файла
if (profileAvatarEditBtn && profileAvatarInput) {
  profileAvatarEditBtn.addEventListener("click", (e) => {
    e.preventDefault();
    profileAvatarInput.click();
  });
}

// Сохранение изменений профиля
if (profileEditForm) {
  profileEditForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Редактировать можно только свой профиль
    if (!currentUserEmail || currentProfileEmail !== currentUserEmail) {
      return;
    }

    if (profileEditSaveBtn) profileEditSaveBtn.disabled = true;
    if (profileEditStatus) {
      profileEditStatus.textContent = "Сохраняем…";
      profileEditStatus.classList.remove(
        "hidden",
        "profile-edit-status--success",
        "profile-edit-status--error"
      );
    }

    try {
      const fd = new FormData();

      const usernameRaw = (profileEditUsernameInput?.value || "").trim();
      const username = usernameRaw.replace(/^@+/, "");
      const name = (profileEditNameInput?.value || "").trim();
      const about = (profileEditAboutInput?.value || "").trim();
      const avatarFile =
        profileAvatarInput &&
        profileAvatarInput.files &&
        profileAvatarInput.files[0]
          ? profileAvatarInput.files[0]
          : null;

      if (username) fd.append("username", username);
      if (name) fd.append("first_name", name);
      if (about) fd.append("about", about);
      if (avatarFile) fd.append("profile_picture", avatarFile);

      if (Array.from(fd.keys()).length === 0) {
        if (profileEditStatus) {
          profileEditStatus.textContent = "Нет изменений";
          profileEditStatus.classList.add("profile-edit-status--success");
          profileEditStatus.classList.remove("profile-edit-status--error");
        }
        return;
      }

      const resp = await fetch(`${API_BASE_URL}/api/profile/update`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });

      if (!resp.ok) {
        let msg = "Не удалось сохранить профиль";
        try {
          const err = await resp.json();
          if (err?.detail) msg = err.detail;
        } catch (_) {}
        if (resp.status === 409) msg = "Никнейм уже занят.";
        if (profileEditStatus) {
          profileEditStatus.textContent = msg;
          profileEditStatus.classList.add("profile-edit-status--error");
          profileEditStatus.classList.remove("profile-edit-status--success");
        }
        return;
      }

      const data = await resp.json();

      // Обновляем шапку профиля
      if (profileName) {
        const newName = data.full_name || name || username;
        if (newName) profileName.textContent = newName;
      }
      if (profileEmail && data.user_email) {
        profileEmail.textContent = data.user_email;
        if (profileEditEmailInput)
          profileEditEmailInput.value = data.user_email;
      }
      if (profileQuote) {
        profileQuote.textContent = about || profileQuote.textContent;
      }
      if (profileHeaderBgImg && data.avatar_url) {
        const u = data.avatar_url;
        profileHeaderBgImg.src = u.includes("?")
          ? `${u}&t=${Date.now()}`
          : `${u}?t=${Date.now()}`;
      }

      // Обновляем аватар в data атрибуте, чтобы дальше UI мог его брать как текущий
      if (document.body && data.avatar_url) {
        document.body.dataset.userAvatar = data.avatar_url;
      }

      // Обновляем аватар в пункте "Мой профиль" в настройках
      if (myProfileSettingsItem && data.avatar_url) {
        const avatarImg = myProfileSettingsItem.querySelector("img");
        if (avatarImg) {
          const u2 = data.avatar_url;
          avatarImg.src = u2.includes("?")
            ? `${u2}&t=${Date.now()}`
            : `${u2}?t=${Date.now()}`;
        }
      }

      if (profileEditStatus) {
        profileEditStatus.textContent = "Сохранено";
        profileEditStatus.classList.add("profile-edit-status--success");
        profileEditStatus.classList.remove("profile-edit-status--error");
      }
    } catch (error) {
      console.error("Ошибка сохранения профиля:", error);
      if (profileEditStatus) {
        profileEditStatus.textContent = "Ошибка при сохранении";
        profileEditStatus.classList.add("profile-edit-status--error");
        profileEditStatus.classList.remove("profile-edit-status--success");
      }
    } finally {
      if (profileEditSaveBtn) profileEditSaveBtn.disabled = false;
      if (profileAvatarInput) profileAvatarInput.value = "";
    }
  });
}

// Функция для открытия профиля группы или пользователя
async function handleAvatarClick(chatId) {
  console.log(
    "handleAvatarClick called with chatId:",
    chatId,
    "currentChatIsGroup:",
    currentChatIsGroup
  );
  if (!chatId) {
    console.error("handleAvatarClick: chatId is missing!");
    return;
  }

  const chatButton = document.querySelector(
    `.chat-list-item-btn[data-chat-id="${chatId}"]`
  );

  console.log("chatButton found:", !!chatButton);
  if (chatButton) {
    console.log("chatButton data:", {
      isGroupChat: chatButton.dataset.isGroupChat,
      isGroup: chatButton.dataset.isGroup,
      chatId: chatButton.dataset.chatId,
    });
  }

  // Проверяем, является ли это группой
  // Сначала проверяем currentChatIsGroup (глобальный флаг из loadChat)
  // Затем проверяем data-атрибуты кнопки чата, если она найдена
  const isGroup =
    currentChatIsGroup ||
    (chatButton &&
      (chatButton.dataset.isGroupChat === "true" ||
        chatButton.dataset.isGroup === "true"));

  console.log("isGroup determined as:", isGroup);

  if (isGroup) {
    console.log("Opening group profile for chatId:", chatId);
    // Для группы открываем профиль группы
    try {
      const resp = await fetch(`${API_BASE_URL}/api/chat/${chatId}`, {
        credentials: "include",
      });
      if (!resp.ok) throw new Error("Ошибка загрузки данных группы");

      const chatData = await resp.json();

      // Преобразуем данные в формат, ожидаемый openGroupProfile
      const groupData = {
        chat_id: chatId,
        _id: chatId,
        group_name: chatData.chat_name || chatData.group_name,
        chat_name: chatData.chat_name,
        group_avatar: chatData.chat_avatar || chatData.group_avatar,
        chat_avatar: chatData.chat_avatar,
        participants: chatData.participants || [],
        owner: chatData.owner || chatData.group_owner,
      };

      // Открываем профиль группы (участники с ролями)
      console.log(
        "openGroupProfile function available:",
        typeof window.openGroupProfile === "function"
      );
      if (typeof window.openGroupProfile === "function") {
        console.log("Calling openGroupProfile with data:", groupData);
        await window.openGroupProfile(groupData);
      } else {
        console.error("openGroupProfile function is not available!");
      }
    } catch (err) {
      console.error("Ошибка загрузки профиля группы:", err);
    }
  } else {
    // Для обычного чата открываем профиль пользователя
    if (chatButton) {
      const interlocutorEmail = chatButton.dataset.interlocutorEmail;
      if (interlocutorEmail) {
        openProfileModal(interlocutorEmail);
      }
    } else {
      // Если кнопка не найдена, пытаемся получить данные чата из API
      try {
        const resp = await fetch(`${API_BASE_URL}/api/chat/${chatId}`, {
          credentials: "include",
        });
        if (resp.ok) {
          const chatData = await resp.json();
          if (chatData.interlocutor_email) {
            openProfileModal(chatData.interlocutor_email);
          }
        }
      } catch (err) {
        console.error("Ошибка загрузки данных чата:", err);
      }
    }
  }
}

// Обработчик клика на аватар в хедере чата
if (avatarContainer) {
  avatarContainer.addEventListener("click", async (e) => {
    e.stopPropagation();
    console.log("Avatar clicked in chat header, activeChatId:", activeChatId);
    if (!activeChatId) {
      console.error("activeChatId is not set!");
      return;
    }
    await handleAvatarClick(activeChatId);
  });
} else {
  console.error("avatarContainer element not found!");
}

// Обработчик клика на аватар в хедере группы (groupsAvatar-container)
// Этот элемент больше не используется, так как группы открываются в обычном chatWindow
// Но оставляем для совместимости
const groupsAvatarContainer = document.getElementById("groupsAvatar-container");
if (groupsAvatarContainer) {
  groupsAvatarContainer.addEventListener("click", async (e) => {
    e.stopPropagation();
    // Используем activeChatId, который устанавливается в loadChat
    if (activeChatId) {
      await handleAvatarClick(activeChatId);
    }
  });
}

// ============================================
// === ОБРАБОТЧИКИ МЕНЮ ЧАТА (ПЕРЕПИСАНО) ===
// ============================================

// Инициализация элементов меню
const menuToggleBtn = document.getElementById("menuToggleBtn");
const chatMenuDropdown = document.getElementById("chatMenuDropdown");
const groupSettingsMenuItem = document.getElementById("groupSettingsMenuItem");
const clearChatMenuItem = document.getElementById("clearChatMenuItem");
const deleteChatMenuItem = document.getElementById("deleteChatMenuItem");

// Обработчик клика на троеточие - открывает/закрывает меню
if (menuToggleBtn) {
  menuToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!activeChatId) {
      console.warn("Нет активного чата");
      return;
    }

    if (chatMenuDropdown) {
      chatMenuDropdown.classList.toggle("hidden");
    }
  });
}

// Обработчик клика на "Очистить историю"
if (clearChatMenuItem) {
  clearChatMenuItem.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("Кнопка 'Очистить историю' нажата");

    // Закрываем меню
    if (chatMenuDropdown) {
      chatMenuDropdown.classList.add("hidden");
    }

    // Проверяем, что есть активный чат
    if (!activeChatId) {
      alert("Нет активного чата для очистки");
      return;
    }

    // Открываем модалку подтверждения
    openClearChatConfirmModal();
  });
} else {
  console.error("Кнопка clearChatMenuItem не найдена!");
}

// Обработчик клика на "Удалить чат"
if (deleteChatMenuItem) {
  deleteChatMenuItem.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    console.log("Кнопка 'Удалить чат' нажата");

    // Закрываем меню
    if (chatMenuDropdown) {
      chatMenuDropdown.classList.add("hidden");
    }

    // Проверяем, что есть активный чат
    if (!activeChatId) {
      alert("Нет активного чата для удаления");
      return;
    }

    // Открываем модалку подтверждения
    openDeleteChatConfirmModal();
  });
} else {
  console.error("Кнопка deleteChatMenuItem не найдена!");
}

// Обработчик клика на "Настройки группы"
if (groupSettingsMenuItem) {
  groupSettingsMenuItem.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();

    // Закрываем меню
    if (chatMenuDropdown) {
      chatMenuDropdown.classList.add("hidden");
    }

    if (!activeChatId) return;

    // Открываем настройки группы
    if (typeof window.openGroupSettings === "function") {
      await window.openGroupSettings(activeChatId);
    }
  });
}

// Закрытие меню при клике вне его
document.addEventListener("click", (e) => {
  if (
    chatMenuDropdown &&
    !chatMenuDropdown.contains(e.target) &&
    menuToggleBtn &&
    !menuToggleBtn.contains(e.target)
  ) {
    chatMenuDropdown.classList.add("hidden");
  }
});

// === Функции для настроек конфиденциальности ===
function _setPrivacyStatus(msg, type) {
  if (!privacyStatus) return;
  if (!msg) {
    privacyStatus.classList.add("hidden");
    privacyStatus.textContent = "";
    privacyStatus.className = "my-profile-status hidden";
    return;
  }
  privacyStatus.classList.remove("hidden");
  privacyStatus.textContent = msg;
  privacyStatus.className = `my-profile-status ${
    type === "ok"
      ? "my-profile-status--ok"
      : type === "err"
      ? "my-profile-status--err"
      : ""
  }`;
}

function closePrivacySettingsPanel() {
  if (privacySettingsPanel) privacySettingsPanel.classList.add("hidden");
  if (settingsInfo) settingsInfo.classList.remove("has-my-profile");
  if (settingsInfoContent) settingsInfoContent.classList.remove("hidden");
  _setPrivacyStatus("", null);
}

// Track which custom dropdowns have been initialized
const customDropdownsInitialized = new Set();

async function openPrivacySettingsPanel() {
  if (!currentUserEmail) return;
  if (!privacySettingsPanel || !settingsInfo) return;

  // Закрываем панель профиля, если она открыта
  if (
    myProfileSettingsPanel &&
    !myProfileSettingsPanel.classList.contains("hidden")
  ) {
    closeMyProfileSettingsPanel();
  }

  // Убеждаемся, что открыта вкладка настроек
  if (window.switchTab && typeof window.switchTab === "function") {
    window.switchTab("settings");
  }

  if (settingsInfoContent) settingsInfoContent.classList.add("hidden");
  settingsInfo.classList.add("has-my-profile");
  privacySettingsPanel.classList.remove("hidden");
  _setPrivacyStatus("Загружаем настройки…", null);

  try {
    // Загружаем текущие настройки конфиденциальности
    const resp = await fetch(`${API_BASE_URL}/api/privacy/settings`, {
      credentials: "include",
    });
    if (!resp.ok) throw new Error("Не удалось загрузить настройки");
    const data = await resp.json();

    // Устанавливаем значения
    if (privacyLastSeenSelect)
      privacyLastSeenSelect.value = data.last_seen_visibility || "everyone";
    if (privacyProfilePhotoSelect)
      privacyProfilePhotoSelect.value =
        data.profile_photo_visibility || "everyone";
    if (privacyEmailInput)
      privacyEmailInput.value = data.email || currentUserEmail;

    // Обновляем кастомные dropdown'ы
    updateCustomDropdown(
      "privacyLastSeen",
      data.last_seen_visibility || "everyone"
    );
    updateCustomDropdown(
      "privacyProfilePhoto",
      data.profile_photo_visibility || "everyone"
    );

    // Загружаем черный список
    await loadBlockedUsers();

    // Обновляем кастомные dropdown'ы после загрузки данных
    // Сбрасываем флаг инициализации, чтобы переинициализировать
    customDropdownsInitialized.delete("privacyLastSeen");
    customDropdownsInitialized.delete("privacyProfilePhoto");

    // Инициализируем кастомные dropdown'ы после загрузки данных
    setTimeout(() => {
      initCustomDropdowns();
    }, 150);

    _setPrivacyStatus("", null);
  } catch (e) {
    console.error(e);
    _setPrivacyStatus("Ошибка загрузки настроек", "err");
  }
}

async function loadBlockedUsers() {
  if (!privacyBlockedUsersList) return;
  try {
    const resp = await fetch(`${API_BASE_URL}/api/privacy/blocked`, {
      credentials: "include",
    });
    if (!resp.ok) throw new Error("Не удалось загрузить черный список");
    const blocked = await resp.json();

    privacyBlockedUsersList.innerHTML = "";
    if (blocked.length === 0) {
      privacyBlockedUsersList.innerHTML =
        '<div style="color: rgba(0,0,0,0.45); font-size: 14px; padding: 8px;">Черный список пуст</div>';
      return;
    }

    for (const user of blocked) {
      const item = document.createElement("div");
      item.style.cssText =
        "display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: rgba(0,0,0,0.04); border-radius: 12px;";
      item.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span style="font-size: 14px; font-weight: 600; color: rgba(0,0,0,0.82);">${
            user.full_name || user.username || user.email
          }</span>
          <span style="font-size: 12px; color: rgba(0,0,0,0.55);">${
            user.email
          }</span>
        </div>
        <button type="button" class="my-profile-save" data-unblock-email="${
          user.email
        }" style="height: 36px; padding: 0 14px; font-size: 13px; background: #dc2626; box-shadow: 0 8px 20px rgba(220, 38, 38, 0.25);">Разблокировать</button>
      `;
      const unblockBtn = item.querySelector(
        `[data-unblock-email="${user.email}"]`
      );
      if (unblockBtn) {
        unblockBtn.addEventListener("click", async () => {
          await unblockUser(user.email);
        });
      }
      privacyBlockedUsersList.appendChild(item);
    }
  } catch (e) {
    console.error(e);
    privacyBlockedUsersList.innerHTML =
      '<div style="color: #dc2626; font-size: 14px; padding: 8px;">Ошибка загрузки черного списка</div>';
  }
}

async function unblockUser(email) {
  try {
    const resp = await fetch(`${API_BASE_URL}/api/privacy/unblock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email }),
    });
    if (!resp.ok) throw new Error("Не удалось разблокировать пользователя");
    await loadBlockedUsers();
    _setPrivacyStatus("Пользователь разблокирован", "ok");
    setTimeout(() => _setPrivacyStatus("", null), 2000);
  } catch (e) {
    console.error(e);
    _setPrivacyStatus("Ошибка разблокировки", "err");
  }
}

// Обработчик клика на элементы настроек
(function initSettingsClick() {
  const settingsList = document.querySelector(".settings-list");
  const settingsInfoContent = document.getElementById("settingsInfoContent");
  if (!settingsList) return;

  settingsList.addEventListener("click", async (e) => {
    const settingsItem = e.target.closest(".settings-item");
    if (!settingsItem) return;

    const titleEl = settingsItem.querySelector(".settings-item-title");
    if (!titleEl) return;

    const title = (titleEl.textContent || "").trim();
    console.log("Клик на элемент настроек:", title);

    // Подсветка активного пункта (показывает, на какой вкладке/пункте ты сейчас)
    settingsList.querySelectorAll(".settings-item.active").forEach((el) => {
      el.classList.remove("active");
    });
    settingsItem.classList.add("active");

    if (title === "Конфиденциальность") {
      e.preventDefault();
      e.stopPropagation();
      await openPrivacySettingsPanel();
    } else if (
      title === "Оформление" ||
      settingsItem.id === "appearanceSettingsItem" ||
      settingsItem.dataset.settingsType === "appearance"
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof openAppearancePanel === "function") {
        openAppearancePanel();
      } else {
        console.error("openAppearancePanel не определена");
      }
    } else if (
      title === "Выйти" ||
      settingsItem.id === "logoutSettingsItem" ||
      settingsItem.dataset.settingsType === "logout"
    ) {
      e.preventDefault();
      e.stopPropagation();
      const overlay = document.getElementById("logoutConfirmOverlay");
      if (overlay) overlay.classList.remove("hidden");
    }
  });
})();

// Выход из аккаунта (модалка)
(function initLogoutModal() {
  const overlay = document.getElementById("logoutConfirmOverlay");
  const modal = document.getElementById("logoutConfirmModal");
  const cancelBtn = document.getElementById("logoutCancelBtn");
  const confirmBtn = document.getElementById("logoutConfirmBtn");

  if (!overlay || !modal) return;

  function close() {
    overlay.classList.add("hidden");
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });
  }

  overlay.addEventListener("click", (e) => {
    // клик по затемнению — закрыть
    if (e.target === overlay) close();
  });

  if (confirmBtn) {
    confirmBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        confirmBtn.disabled = true;
        // Выходим: удаляем cookie через backend
        await fetch("/logout", { method: "GET", credentials: "include" });
      } catch (err) {
        console.error("Ошибка logout:", err);
      } finally {
        // Всегда уводим на регистрацию
        window.location.replace("/auth_page?tab=register");
      }
    });
  }
})();

// Обработчики для панели конфиденциальности
if (privacySettingsCloseBtn) {
  privacySettingsCloseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closePrivacySettingsPanel();
  });
}

// Обработчик для панели оформления
const appearanceSettingsCloseBtn = document.getElementById(
  "appearanceSettingsCloseBtn"
);
if (appearanceSettingsCloseBtn) {
  appearanceSettingsCloseBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof closeAppearancePanel === "function") {
      closeAppearancePanel();
    } else {
      console.error("closeAppearancePanel не определена");
    }
  });
}

// Сохранение настроек конфиденциальности
if (privacySettingsForm) {
  privacySettingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentUserEmail) return;

    if (privacySaveBtn) privacySaveBtn.disabled = true;
    _setPrivacyStatus("Сохраняем…", null);

    try {
      const resp = await fetch(`${API_BASE_URL}/api/privacy/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          last_seen_visibility: privacyLastSeenSelect?.value || "everyone",
          profile_photo_visibility:
            privacyProfilePhotoSelect?.value || "everyone",
        }),
      });

      if (!resp.ok) {
        let msg = "Не удалось сохранить настройки";
        try {
          const err = await resp.json();
          if (err?.detail) msg = err.detail;
        } catch (_) {}
        _setPrivacyStatus(msg, "err");
        return;
      }

      _setPrivacyStatus("Сохранено", "ok");
    } catch (err) {
      console.error(err);
      _setPrivacyStatus("Ошибка при сохранении", "err");
    } finally {
      if (privacySaveBtn) privacySaveBtn.disabled = false;
    }
  });
}

// Смена пароля
if (privacyChangePasswordBtn) {
  privacyChangePasswordBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!currentUserEmail) return;

    const currentPassword = privacyCurrentPassword?.value || "";
    const newPassword = privacyNewPassword?.value || "";

    if (!currentPassword || !newPassword) {
      _setPrivacyStatus("Заполните все поля", "err");
      return;
    }

    if (newPassword.length < 6) {
      _setPrivacyStatus("Пароль должен быть не менее 6 символов", "err");
      return;
    }

    privacyChangePasswordBtn.disabled = true;
    _setPrivacyStatus("Меняем пароль…", null);

    try {
      const resp = await fetch(`${API_BASE_URL}/api/privacy/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });

      if (!resp.ok) {
        let msg = "Не удалось сменить пароль";
        try {
          const err = await resp.json();
          if (err?.detail) msg = err.detail;
        } catch (_) {}
        _setPrivacyStatus(msg, "err");
        return;
      }

      _setPrivacyStatus("Пароль успешно изменен", "ok");
      if (privacyCurrentPassword) privacyCurrentPassword.value = "";
      if (privacyNewPassword) privacyNewPassword.value = "";
    } catch (err) {
      console.error(err);
      _setPrivacyStatus("Ошибка при смене пароля", "err");
    } finally {
      privacyChangePasswordBtn.disabled = false;
    }
  });
}

// Обновление email
if (privacyUpdateEmailBtn) {
  privacyUpdateEmailBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!currentUserEmail) return;

    const newEmail = privacyEmailInput?.value?.trim() || "";
    if (!newEmail) {
      _setPrivacyStatus("Введите новый email", "err");
      return;
    }

    if (!newEmail.includes("@")) {
      _setPrivacyStatus("Некорректный email", "err");
      return;
    }

    privacyUpdateEmailBtn.disabled = true;
    _setPrivacyStatus("Обновляем email…", null);

    try {
      const resp = await fetch(`${API_BASE_URL}/api/privacy/update-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          new_email: newEmail,
        }),
      });

      if (!resp.ok) {
        let msg = "Не удалось обновить email";
        try {
          const err = await resp.json();
          if (err?.detail) msg = err.detail;
        } catch (_) {}
        _setPrivacyStatus(msg, "err");
        return;
      }

      _setPrivacyStatus("Email успешно обновлен", "ok");
      currentUserEmail = newEmail;
    } catch (err) {
      console.error(err);
      _setPrivacyStatus("Ошибка при обновлении email", "err");
    } finally {
      privacyUpdateEmailBtn.disabled = false;
    }
  });
}

// Блокировка пользователя
if (privacyBlockUserBtn) {
  privacyBlockUserBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!currentUserEmail) return;

    const emailToBlock = privacyBlockEmailInput?.value?.trim() || "";
    if (!emailToBlock) {
      _setPrivacyStatus("Введите email пользователя", "err");
      return;
    }

    if (!emailToBlock.includes("@")) {
      _setPrivacyStatus("Некорректный email", "err");
      return;
    }

    if (emailToBlock === currentUserEmail) {
      _setPrivacyStatus("Нельзя заблокировать самого себя", "err");
      return;
    }

    privacyBlockUserBtn.disabled = true;
    _setPrivacyStatus("Блокируем пользователя…", null);

    try {
      const resp = await fetch(`${API_BASE_URL}/api/privacy/block`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email: emailToBlock,
        }),
      });

      if (!resp.ok) {
        let msg = "Не удалось заблокировать пользователя";
        try {
          const err = await resp.json();
          if (err?.detail) msg = err.detail;
        } catch (_) {}
        _setPrivacyStatus(msg, "err");
        return;
      }

      _setPrivacyStatus("Пользователь заблокирован", "ok");
      if (privacyBlockEmailInput) privacyBlockEmailInput.value = "";
      await loadBlockedUsers();
      setTimeout(() => _setPrivacyStatus("", null), 2000);
    } catch (err) {
      console.error(err);
      _setPrivacyStatus("Ошибка при блокировке", "err");
    } finally {
      privacyBlockUserBtn.disabled = false;
    }
  });
}

// === Функции для кастомного dropdown ===
function initCustomDropdowns() {
  initCustomDropdown("privacyLastSeen", privacyLastSeenSelect);
  initCustomDropdown("privacyProfilePhoto", privacyProfilePhotoSelect);
}

function initCustomDropdown(prefix, selectElement) {
  if (!selectElement) return;

  const trigger = document.getElementById(`${prefix}Trigger`);
  const dropdown = document.getElementById(`${prefix}Dropdown`);
  const custom = document.getElementById(`${prefix}Custom`);

  if (!trigger || !dropdown || !custom) return;

  // Обновляем текст триггера при загрузке
  updateCustomDropdown(prefix, selectElement.value);

  // Клик по триггеру - открыть/закрыть
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isActive = custom.classList.contains("active");

    // Закрываем все другие dropdown'ы
    document.querySelectorAll(".privacy-select-custom").forEach((el) => {
      if (el !== custom) {
        el.classList.remove("active");
        el.querySelector(".privacy-select-dropdown")?.classList.remove("show");
        el.querySelector(".privacy-select-trigger")?.classList.remove("active");
      }
    });

    // Переключаем текущий
    if (isActive) {
      custom.classList.remove("active");
      dropdown.classList.remove("show");
      trigger.classList.remove("active");
    } else {
      custom.classList.add("active");
      dropdown.classList.add("show");
      trigger.classList.add("active");
    }
  });

  // Клик по опции
  dropdown.querySelectorAll(".privacy-select-option").forEach((option) => {
    option.addEventListener("click", (e) => {
      e.stopPropagation();
      const value = option.dataset.value;

      // Обновляем оригинальный select
      selectElement.value = value;

      // Обновляем кастомный dropdown
      updateCustomDropdown(prefix, value);

      // Закрываем dropdown
      custom.classList.remove("active");
      dropdown.classList.remove("show");
      trigger.classList.remove("active");

      // Триггерим событие change для select
      selectElement.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}

function updateCustomDropdown(prefix, value) {
  const selectElement =
    prefix === "privacyLastSeen"
      ? privacyLastSeenSelect
      : privacyProfilePhotoSelect;
  if (!selectElement) {
    console.warn(`Select элемент не найден для ${prefix}`);
    return;
  }

  const trigger = document.getElementById(`${prefix}Trigger`);
  const dropdown = document.getElementById(`${prefix}Dropdown`);

  if (!trigger || !dropdown) {
    console.warn(`Элементы dropdown не найдены для ${prefix}`);
    return;
  }

  // Обновляем значение в select
  if (selectElement.value !== value) {
    selectElement.value = value;
  }

  // Находим выбранную опцию
  const selectedOption = dropdown.querySelector(`[data-value="${value}"]`);
  if (selectedOption) {
    // Обновляем текст триггера
    const optionText = selectedOption.textContent.trim();
    if (trigger.textContent !== optionText) {
      trigger.textContent = optionText;
    }

    // Обновляем визуальное выделение
    dropdown.querySelectorAll(".privacy-select-option").forEach((opt) => {
      opt.classList.remove("selected");
    });
    selectedOption.classList.add("selected");
  } else {
    console.warn(`Опция с значением ${value} не найдена в ${prefix}`);
  }
}

// Закрытие dropdown при клике вне его
document.addEventListener("click", (e) => {
  if (!e.target.closest(".privacy-select-custom")) {
    document.querySelectorAll(".privacy-select-custom").forEach((custom) => {
      custom.classList.remove("active");
      custom
        .querySelector(".privacy-select-dropdown")
        ?.classList.remove("show");
      custom
        .querySelector(".privacy-select-trigger")
        ?.classList.remove("active");
    });
  }
});

// Инициализация кастомных dropdown'ов при загрузке
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCustomDropdowns);
} else {
  // Если DOM уже загружен, инициализируем сразу
  setTimeout(initCustomDropdowns, 100);
}

// Обработчики кнопок действий в профиле
if (profileMessageBtn) {
  profileMessageBtn.addEventListener("click", () => {
    closeProfileModal();
    // Фокус на поле ввода сообщения
    if (messageInput) {
      messageInput.focus();
    }
  });
}

if (profileCallBtn) {
  profileCallBtn.addEventListener("click", () => {
    // Закрываем модальное окно профиля
    closeProfileModal();
    // Имитируем нажатие на кнопку звонка в основном чате, чтобы логика была идентичной
    const chatCallBtn = document.getElementById("chatCallBtn");
    if (chatCallBtn) {
      chatCallBtn.click();
    }
  });
}

// === Загрузка черновиков для всех чатов при инициализации ===
function loadAllDrafts() {
  if (!chatListUl) return;
  const chatButtons = chatListUl.querySelectorAll(".chat-list-item-btn");
  chatButtons.forEach((btn) => {
    const chatId = btn.dataset.chatId;
    if (chatId) {
      const draft = loadDraft(chatId);
      if (draft) {
        updateChatListDraft(chatId, draft);
      }
    }
  });
}

// Экспортируем функции в window для использования в других модулях
window.loadChat = loadChat;
window.renderMessage = renderMessage;
window.openProfileModal = openProfileModal;
window.loadProfileContent = loadProfileContent;

// === ФУНКЦИЯ: синхронизировать UI с URL (как в Telegram) ===
// ПРИНЦИП: URL = единственный источник правды
// - / = пустое состояние (нет открытого чата)
// - /имя = открыть чат (создать если не существует)
// - При перезагрузке остаемся в том же чате (из URL)
let isSyncingLocation = false; // Флаг для предотвращения повторных вызовов
async function syncUIWithLocation() {
  // Предотвращаем повторные вызовы
  if (isSyncingLocation) {
    console.log(
      "[Telegram Logic] syncUIWithLocation уже выполняется, пропускаем"
    );
    return;
  }

  isSyncingLocation = true;

  // Сохраняем текущий путь в начале функции для использования в конце
  const currentPath = window.location.pathname;

  try {
    // Получаем текущий путь из URL (единственный источник правды)
    // ВАЖНО: Берем slug из URL, а не из initialChatSlug (который может быть устаревшим)
    // Извлекаем slug из URL: /@username -> username, /username -> username
    let slug = "";
    if (currentPath !== "/") {
      slug = currentPath.startsWith("/@")
        ? currentPath.slice(2)
        : currentPath.slice(1);
    }
    // Если slug не найден в URL, используем initialChatSlug как fallback
    if (!slug && initialChatSlug) {
      slug = initialChatSlug.trim();
    }


    // === ШАГ 1: Если URL = / (без параметров) - показываем пустое состояние ===
    // НО: не закрываем чат, если он открыт по URL (может быть переход с /@username на /)
    if (
      (currentPath === "/" || (!slug && currentPath === "/")) &&
      !isChatOpenedFromUrl
    ) {
      // НО: НИКОГДА не закрываем чат, если он открыт по URL
      if (!isChatOpenedFromUrl || !activeChatId) {
        if (chatEmptyState) chatEmptyState.classList.remove("hidden");
        if (chatWindow) chatWindow.classList.add("hidden");
        activeChatId = null;
      } else {
        console.log(
          "[Telegram Logic] БЛОКИРОВАНО: попытка закрыть чат в ШАГ 1, но чат открыт по URL"
        );
      }
      // Устанавливаем пустой заголовок страницы для списка чатов
      document.title = "";
      document
        .querySelectorAll(".chat-list-item-btn")
        .forEach((b) => b.classList.remove("active"));
      // Убеждаемся, что URL правильный
      if (window.location.pathname !== "/") {
        window.history.replaceState(null, "", "/");
      }
      return;
    }

    // Если чат открыт по URL, но URL изменился на / - это нормально, не закрываем чат
    if (currentPath === "/" && isChatOpenedFromUrl && activeChatId) {
      console.log(
        "[Telegram Logic] Чат открыт по URL, URL изменился на /, но не закрываем чат"
      );
      return;
    }

    // === ШАГ 2: Если есть slug в URL (/имя) - ОБЯЗАТЕЛЬНО открываем чат ===
    // Проверяем, что URL действительно содержит slug (не просто /)
    if (slug && currentPath !== "/" && slug.length > 0) {
      // ожидаем "@username", "username", или полный email "email@example.com"
      const raw = slug.startsWith("@") ? slug.slice(1) : slug;
      const target = raw.toLowerCase();
      // Проверяем, это email или username
      const isEmail = target.includes("@");

      if (target) {
        // Особый случай: /@favorit — это "Избранное"
        if (target === "favorit") {
          const favBtn = document.querySelector(
            '.chat-list-item-btn[data-is-favorite="true"]'
          );
          if (favBtn && favBtn.dataset.chatId) {
            const chatId = favBtn.dataset.chatId;
            console.log("[Telegram Logic] Открываем Избранное:", chatId);
            // Устанавливаем флаг, что чат открыт по URL
            isChatOpenedFromUrl = true;
            // Включаем защиту от закрытия чата
            protectChatFromClosing();

            document
              .querySelectorAll(".chat-list-item-btn")
              .forEach((b) => b.classList.remove("active"));
            favBtn.classList.add("active");
            updateUrlForChat(favBtn);
            await loadChat(chatId);

            // КРИТИЧНО: Убеждаемся, что чат открыт и остается открытым
            // Делаем это несколько раз с небольшой задержкой, чтобы перекрыть любые другие обработчики
            for (let i = 0; i < 10; i++) {
              await new Promise((resolve) => setTimeout(resolve, 150));
              if (chatWindow) {
                chatWindow.classList.remove("hidden");
                chatWindow.style.display = "";
                chatWindow.style.visibility = "visible";
                chatWindow.style.opacity = "1";
              }
              if (chatEmptyState) {
                chatEmptyState.classList.add("hidden");
                chatEmptyState.style.display = "none";
              }
              activeChatId = chatId;
              window.activeChatId = chatId;
            }

            console.log(
              "[Telegram Logic] Избранное успешно открыто и остается открытым, activeChatId:",
              chatId,
              "URL:",
              window.location.pathname,
              "isChatOpenedFromUrl:",
              isChatOpenedFromUrl
            );
            // КРИТИЧНО: Завершаем функцию здесь, чтобы ничего не закрыло чат
            return;
          }
        }

        // ВАЖНО: Ждем загрузки списка чатов перед поиском
        // Проверяем, что список чатов загружен в DOM
        let attempts = 0;
        const maxAttempts = 10;
        let matchedBtn = null;

        while (!matchedBtn && attempts < maxAttempts) {
          // Ждем немного, если список еще не загружен
          if (attempts > 0) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          document.querySelectorAll(".chat-list-item-btn").forEach((btn) => {
            if (matchedBtn) return;

            const u = (btn.dataset.interlocutorUsername || "").toLowerCase();
            // Поддерживаем ники с ведущим "@": @git и git считаем одинаковыми
            const uClean = u.startsWith("@") ? u.slice(1) : u;
            const e = (btn.dataset.interlocutorEmail || "").toLowerCase();
            const name = (btn.dataset.chatName || "").toLowerCase();

            const emailLocal =
              e && e.includes("@") ? e.split("@")[0].toLowerCase() : "";

            // Если это email, ищем точное совпадение по email
            if (isEmail) {
              if (e === target) {
                matchedBtn = btn;
              }
            } else {
              // Если это username, ищем по нику, локальной части email или имени
              if (
                (u && (u === target || uClean === target)) ||
                (emailLocal && emailLocal === target) ||
                (name && name === target)
              ) {
                matchedBtn = btn;
              }
            }
          });

          attempts++;
          if (matchedBtn) {
            console.log(
              `[Telegram Logic] Чат найден после ${attempts} попыток`
            );
            break;
          }
        }

        if (!matchedBtn && attempts >= maxAttempts) {
          console.warn(
            "[Telegram Logic] Список чатов не загружен, чат не найден после",
            maxAttempts,
            "попыток"
          );
        }

        if (matchedBtn) {
          const chatId = matchedBtn.dataset.chatId;
          if (chatId) {
            console.log("[Telegram Logic] Чат найден, открываем:", chatId);
            // Устанавливаем флаг, что чат открыт по URL
            isChatOpenedFromUrl = true;

            // снимаем выделение
            document
              .querySelectorAll(".chat-list-item-btn")
              .forEach((b) => b.classList.remove("active"));
            matchedBtn.classList.add("active");

            updateUrlForChat(matchedBtn); // нормализуем URL
            await loadChat(chatId);

            // КРИТИЧНО: Убеждаемся, что чат открыт и остается открытым
            // Делаем это несколько раз с небольшой задержкой, чтобы перекрыть любые другие обработчики
            for (let i = 0; i < 10; i++) {
              await new Promise((resolve) => setTimeout(resolve, 150));
              if (chatWindow) {
                chatWindow.classList.remove("hidden");
                chatWindow.style.display = "";
                chatWindow.style.visibility = "visible";
                chatWindow.style.opacity = "1";
              }
              if (chatEmptyState) {
                chatEmptyState.classList.add("hidden");
                chatEmptyState.style.display = "none";
              }
              activeChatId = chatId;
              window.activeChatId = chatId;
            }

            console.log(
              "[Telegram Logic] Чат успешно открыт и остается открытым, activeChatId:",
              chatId,
              "URL:",
              window.location.pathname,
              "isChatOpenedFromUrl:",
              isChatOpenedFromUrl
            );
            // КРИТИЧНО: Завершаем функцию здесь, чтобы ничего не закрыло чат
            return;
          }
        }

        // Если чата ещё нет в списке, ОБЯЗАТЕЛЬНО создаем его и открываем переписку
        if (!matchedBtn && target) {
          console.log(
            "[Telegram Logic] Чат не найден, создаем новый для:",
            target
          );
          const success = await tryStartChatFromSlug(target);
          if (success) {
            // Чат успешно создан и открыт, URL уже обновлен в startChatWithUser
            console.log(
              "[Telegram Logic] Чат успешно создан и открыт, остаемся в переписке"
            );
            // Устанавливаем флаг, что чат открыт по URL
            isChatOpenedFromUrl = true;
            // Включаем защиту от закрытия чата
            protectChatFromClosing();

            // ВАЖНО: Убеждаемся, что чат остается открытым
            // Делаем это несколько раз с небольшой задержкой
            for (let i = 0; i < 10; i++) {
              await new Promise((resolve) => setTimeout(resolve, 150));
              if (chatWindow) {
                chatWindow.classList.remove("hidden");
                chatWindow.style.display = "";
                chatWindow.style.visibility = "visible";
                chatWindow.style.opacity = "1";
              }
              if (chatEmptyState) {
                chatEmptyState.classList.add("hidden");
                chatEmptyState.style.display = "none";
              }
              // Убеждаемся, что activeChatId установлен
              const currentChatBtn = document.querySelector(
                ".chat-list-item-btn.active"
              );
              if (currentChatBtn && currentChatBtn.dataset.chatId) {
                activeChatId = currentChatBtn.dataset.chatId;
                window.activeChatId = activeChatId;
              }
            }
            console.log(
              "[Telegram Logic] Чат полностью открыт и защищен, activeChatId:",
              activeChatId
            );
            // КРИТИЧНО: Завершаем функцию здесь, чтобы ничего не закрыло чат
            return;
          } else {
            // Если не удалось создать чат - показываем пустое состояние и убираем ссылку
            console.warn(
              "[Telegram Logic] Не удалось создать чат, переходим на главную"
            );
            window.history.replaceState(null, "", "/");
            // НО: НИКОГДА не закрываем чат, если он открыт по URL (хотя в этом случае чат не был создан)
            if (!isChatOpenedFromUrl || !activeChatId) {
              if (chatEmptyState) chatEmptyState.classList.remove("hidden");
              if (chatWindow) chatWindow.classList.add("hidden");
              activeChatId = null;
            }
            // Устанавливаем пустой заголовок страницы для списка чатов
            document.title = "";
            return;
          }
        }
      }
      // Если slug есть, но target пустой - некорректный URL, показываем пустое состояние
      if (!target && slug) {
        console.warn("[Telegram Logic] Некорректный slug:", slug);
        window.history.replaceState(null, "", "/");
        // НО: НИКОГДА не закрываем чат, если он открыт по URL
        if (!isChatOpenedFromUrl || !activeChatId) {
          if (chatEmptyState) chatEmptyState.classList.remove("hidden");
          if (chatWindow) chatWindow.classList.add("hidden");
          activeChatId = null;
        } else {
          console.log(
            "[Telegram Logic] БЛОКИРОВАНО: попытка закрыть чат из-за некорректного slug, но чат открыт по URL"
          );
        }
        // Устанавливаем пустой заголовок страницы для списка чатов
        document.title = "";
        return;
      }
    }

    // === ШАГ 3: Если дошли сюда и URL не / - это ошибка, показываем пустое состояние ===
    // ВАЖНО: Проверяем, что чат не был открыт по URL (чтобы не закрыть его)
    if (
      isChatOpenedFromUrl &&
      activeChatId &&
      chatWindow &&
      !chatWindow.classList.contains("hidden")
    ) {
      console.log(
        "[Telegram Logic] Чат открыт по URL, не закрываем его. activeChatId:",
        activeChatId,
        "URL:",
        currentPath
      );
      return;
    }

    // Только если чат не открыт по URL и URL не / - показываем пустое состояние
    if (currentPath !== "/" && !isChatOpenedFromUrl) {
      console.warn(
        "[Telegram Logic] Неожиданное состояние, показываем пустое состояние. URL:",
        currentPath
      );
      window.history.replaceState(null, "", "/");
      if (chatEmptyState) chatEmptyState.classList.remove("hidden");
      // НИКОГДА не закрываем чат, если он открыт по URL
      if (!isChatOpenedFromUrl || !activeChatId) {
        if (chatWindow) chatWindow.classList.add("hidden");
        activeChatId = null;
        isChatOpenedFromUrl = false;
        isProtectionActive = false; // Отключаем защиту
        if (protectionInterval) {
          clearInterval(protectionInterval);
          protectionInterval = null;
        }
        if (protectionObserver) {
          protectionObserver.disconnect();
          protectionObserver = null;
        }
        // Устанавливаем пустой заголовок страницы для списка чатов
        document.title = "";
      } else {
        console.log(
          "[Telegram Logic] БЛОКИРОВАНО: попытка закрыть чат в syncUIWithLocation, но чат открыт по URL"
        );
      }
      document
        .querySelectorAll(".chat-list-item-btn")
        .forEach((b) => b.classList.remove("active"));
    }
  } finally {
    // Снимаем флаг после завершения
    isSyncingLocation = false;
  }
}

/**
 * Пытается по слагу (username/email без домена) найти пользователя
 * и автоматически создать/открыть приватный чат с ним.
 * Использует уже существующие эндпоинты:
 *   - GET /api/users/search?query=...
 *   - POST /start_chat (startChatWithUser)
 * @param {string} targetSlugLower lowercased slug (username или часть email)
 */
async function tryStartChatFromSlug(targetSlugLower) {
  const q = (targetSlugLower || "").trim().replace(/^@+/, "").trim();
  if (!q) return false;
  try {
    const query = encodeURIComponent(q);
    const resp = await fetch(
      `${API_BASE_URL}/api/users/search?query=${query}`,
      {
        method: "GET",
        credentials: "include",
      }
    );

    if (!resp.ok) {
      console.warn("Не удалось найти пользователя по слагу:", targetSlugLower);
      return false;
    }

    const data = await resp.json();
    const users = data.users || [];
    if (!users.length) {
      console.warn("Пользователь не найден:", targetSlugLower);
      return false;
    }

    // Берём первого подходящего пользователя
    const user = users[0];
    const email = user.email;
    const username = user.username || "";
    const title = user.full_name || username || email;

    if (!email) {
      console.warn("У пользователя нет email");
      return false;
    }

    // Создаем чат и открываем переписку
    await startChatWithUser(email, title, username);
    return true;
  } catch (e) {
    console.error("Ошибка при автоматическом создании чата по слагу:", e);
    return false;
  }
}

window.addEventListener("load", async () => {
  // Инициализируем элементы для упоминаний
  initMentionsElements();

  // Инициализируем элементы для прокрутки вниз
  scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
  newMessagesCountEl = document.getElementById("newMessagesCount");

  // Проверяем, что все элементы меню найден

  // Обработчик клика на кнопку прокрутки вниз
  if (scrollToBottomBtn) {
    scrollToBottomBtn.addEventListener("click", () => {
      scrollToBottom(true);
      newMessagesCount = 0;
      updateScrollToBottomButton();
    });
  }

  // Обработчик прокрутки чата для отслеживания позиции
  if (chatMessages) {
    chatMessages.addEventListener("scroll", () => {
      checkIfUserAtBottom();
    });

    // Делегирование событий для кликов на упоминания в сообщениях
    chatMessages.addEventListener("click", (e) => {
      const mentionElement = e.target.closest(".message-mention");
      if (mentionElement) {
        e.stopPropagation();
        handleMentionClick(mentionElement);
      }
    });
  }

  // Обработчик клика вне списка упоминаний для его закрытия
  document.addEventListener("click", (e) => {
    if (
      mentionsList &&
      !mentionsList.contains(e.target) &&
      e.target !== messageInput
    ) {
      hideMentionsList();
    }
  });

  // Загружаем черновики для всех чатов
  loadAllDrafts();

  // === Инициализация переключения вкладок (SOLID: Dependency Inversion) ===
  const switchTab = initTabSwitching();

  // Инициализируем систему тем (после того как DOM готов)
  // ОПТИМИЗАЦИЯ: Тема уже применена через inline script, здесь только синхронизация
  try {
    if (typeof initTheme === "function") {
      initTheme();
    } else {
      console.error("initTheme не определена");
      // В случае ошибки показываем контент
      document.body.classList.add("theme-loaded");
    }
  } catch (error) {
    console.error("Ошибка при инициализации темы:", error);
    // В случае ошибки показываем контент
    document.body.classList.add("theme-loaded");
  }

  // === ШАГ 1: Подключаемся к WebSocket ОДИН РАЗ ===
  connectWebSocket(currentUserEmail);

  // === ИНИЦИАЛИЗАЦИЯ МЕНЕДЖЕРА ЗВОНКОВ ===
  // Инициализируем после подключения WebSocket
  const initCallManager = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      callManager = new CallManager(ws, currentUserEmail);
      setupCallManagerUI();
      callManager.getIceServers().catch(() => {}); // предзагрузка ICE серверов для звонков
    } else {
      // Если WebSocket еще не открыт, ждем
      setTimeout(initCallManager, 100);
    }
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    initCallManager();
  } else {
    ws.addEventListener("open", initCallManager, { once: true });
  }

  // === ШАГ 2: Восстанавливаем последний чат (если был) ===
  // Теперь ждем завершения, чтобы чат успел открыться
  await syncUIWithLocation();

  // ВАЖНО: Если чат открыт по URL, включаем ПОЛНУЮ защиту
  // Это защита от других обработчиков, которые могут закрыть чат
  if (isChatOpenedFromUrl && activeChatId) {
    console.log(
      "[Telegram Logic] Чат открыт по URL, включаем ПОЛНУЮ защиту. activeChatId:",
      activeChatId
    );
    protectChatFromClosing();
  }

  // === Предзагрузка контактов, чтобы имена из контактов использовались в чатах/группах ===
  if (typeof loadContacts === "function") {
    try {
      await loadContacts();
    } catch (e) {
      console.error("Ошибка предзагрузки контактов:", e);
    }
  }

  // Инициализация мобильного меню (временно отключена: функция не определена и ломает выполнение скрипта)
  // initMobileMenu();

  // Инициализация навигации настроек (мобильная версия)
  if (window.initSettingsNavigation) {
    window.initSettingsNavigation();
  } else {
    console.warn("initSettingsNavigation not found");
  }

  // Обработка ресайза для закрытия сайдбара на десктопе

  // === Инициализация панели эмодзи ===
  initEmojiPicker();

  // === Инициализация обработчиков вложений ===
  initAttachmentHandlers();
  fixAvatars();

  // === Инициализация поиска по чату ===
  if (chatSearchBtn && chatSearchWrapper && chatSearchInput) {
    chatSearchBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const isOpen = !chatSearchWrapper.classList.contains("hidden");
      if (isOpen) {
        closeChatSearch();
      } else {
        openChatSearch();
      }
    });

    chatSearchInput.addEventListener("input", (e) => {
      const raw = e.target.value;
      if (chatSearchClearBtn) chatSearchClearBtn.classList.remove("hidden");
      updateChatSearchResults(raw);
    });

    chatSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (e.shiftKey) {
          moveChatSearchPrev();
        } else {
          moveChatSearchNext();
        }
        e.preventDefault();
      } else if (e.key === "Escape") {
        closeChatSearch();
      }
    });

    if (chatSearchClearBtn) {
      chatSearchClearBtn.addEventListener("click", () => {
        closeChatSearch();
      });
    }

    if (chatSearchPrevBtn) {
      chatSearchPrevBtn.addEventListener("click", () => {
        moveChatSearchPrev();
      });
    }

    if (chatSearchNextBtn) {
      chatSearchNextBtn.addEventListener("click", () => {
        moveChatSearchNext();
      });
    }
  }

  // === Инициализация вкладок: по умолчанию показываем чаты ===
  if (switchTab) {
    switchTab("chats");
  }

  // === Инициализация фильтрации: применяем фильтр, если в поле поиска уже есть значение ===
  if (searchInput && searchInput.value.trim()) {
    filterChatList(searchInput.value);
    // Показываем кнопку очистки, если есть текст
    if (searchClearBtn) {
      searchClearBtn.classList.remove("hidden");
    }
  }
});

// === Обработчик сброса активного чата при переключении вкладок ===
window.addEventListener("resetActiveChat", () => {
  // НО: НИКОГДА не закрываем чат, если он открыт по URL
  if (!isChatOpenedFromUrl || !activeChatId) {
    activeChatId = null;
    chatMessages.innerHTML = "";
  } else {
    console.log(
      "[Telegram Logic] БЛОКИРОВАНО: попытка сбросить чат при переключении вкладок, но чат открыт по URL"
    );
  }
  renderedMessageIds.clear();

  // Сбрасываем статус "Печатает..." если он был активен
  if (
    currentChatStatus &&
    currentChatStatus.classList.contains("typing-status")
  ) {
    currentChatStatus.textContent =
      currentChatStatus.dataset.originalText || "";
    currentChatStatus.classList.remove("typing-status");
  }
});

// === Обработчик установки флага показа пустого состояния ===
window.addEventListener("setShouldShowEmptyState", () => {
  shouldShowEmptyState = true;
});

// ====================================
// === ЭМОДЗИ ФУНКЦИОНАЛ ===
// ====================================

const emojiCategories = {
  smileys: [
    "😀",
    "😃",
    "😄",
    "😁",
    "😆",
    "😅",
    "😂",
    "🤣",
    "😊",
    "😇",
    "🙂",
    "🙃",
    "😉",
    "😌",
    "😍",
    "🥰",
    "😘",
    "😗",
    "😙",
    "😚",
    "😋",
    "😛",
    "😝",
    "😜",
    "🤪",
    "🤨",
    "🧐",
    "🤓",
    "😎",
    "🤩",
    "🥳",
  ],
  animals: [
    "🐶",
    "🐱",
    "🐭",
    "🐹",
    "🐰",
    "🦊",
    "🐻",
    "🐼",
    "🐨",
    "🐯",
    "🦁",
    "🐮",
    "🐷",
    "🐽",
    "🐸",
    "🐵",
    "🙈",
    "🙉",
    "🙊",
    "🐒",
    "🐔",
    "🐧",
    "🐦",
    "🐤",
    "🐣",
    "🐥",
    "🦆",
    "🦅",
    "🦉",
    "🦇",
  ],
  food: [
    "🍎",
    "🍐",
    "🍊",
    "🍋",
    "🍌",
    "🍉",
    "🍇",
    "🍓",
    "🫐",
    "🍈",
    "🍒",
    "🍑",
    "🥭",
    "🍍",
    "🥥",
    "🥝",
    "🍅",
    "🍆",
    "🥑",
    "🥦",
    "🥬",
    "🥒",
    "🌶",
    "🫑",
    "🌽",
    "🥕",
    "🫒",
    "🧄",
    "🧅",
    "🥔",
  ],
  travel: [
    "🚗",
    "🚕",
    "🚙",
    "🚌",
    "🚎",
    "🏎",
    "🚓",
    "🚑",
    "🚒",
    "🚐",
    "🛻",
    "🚚",
    "🚛",
    "🚜",
    "🏍",
    "🛵",
    "🚲",
    "🛴",
    "🛹",
    "🛼",
    "🚁",
    "✈️",
    "🛩",
    "🛫",
    "🛬",
    "🪂",
    "💺",
    "🚀",
    "🛸",
    "🚉",
  ],
  objects: [
    "💡",
    "🔦",
    "🕯",
    "🪔",
    "📔",
    "📕",
    "📖",
    "📗",
    "📘",
    "📙",
    "📚",
    "📓",
    "📒",
    "📃",
    "📜",
    "📄",
    "📰",
    "🗞",
    "📑",
    "🔖",
    "🏷",
    "💰",
    "🪙",
    "💴",
    "💵",
    "💶",
    "💷",
    "💸",
    "🪙",
    "💳",
  ],
  symbols: [
    "❤️",
    "🧡",
    "💛",
    "💚",
    "💙",
    "💜",
    "🖤",
    "🤍",
    "🤎",
    "💔",
    "❣️",
    "💕",
    "💞",
    "💓",
    "💗",
    "💖",
    "💘",
    "💝",
    "💟",
    "☮️",
    "✝️",
    "☪️",
    "🕉",
    "☸️",
    "✡️",
    "🔯",
    "🕎",
    "☯️",
    "☦️",
    "🛐",
  ],
};

let emojiImageCategories = null;

const EMOJI_CATEGORY_MAP = {
  smileys: "emoji and people",
  animals: "animals and nature",
  food: "food and drink",
  travel: "travel and places",
  objects: "objects",
  symbols: "symbols",
  flags: "flags",
  sport: "activity and sport"
};

async function getEmojiImageCategories() {
  if (emojiImageCategories) {
    return emojiImageCategories;
  }
  try {
    const response = await fetch(`${API_BASE_URL}/api/emojis`);
    if (!response.ok) {
      emojiImageCategories = {};
      return emojiImageCategories;
    }
    const data = await response.json();
    if (data && typeof data === "object") {
      emojiImageCategories = data;
    } else {
      emojiImageCategories = {};
    }
  } catch (e) {
    emojiImageCategories = {};
  }
  return emojiImageCategories;
}

function resolveEmojiImageCategory(category, categories) {
  if (categories[category]) {
    return category;
  }
  const mapped = EMOJI_CATEGORY_MAP[category];
  if (mapped && categories[mapped]) {
    return mapped;
  }
  const keys = Object.keys(categories);
  if (keys.length > 0) {
    return keys[0];
  }
  return category;
}

// Инициализация панели эмодзи
function initEmojiPicker() {
  const emojiPicker = document.getElementById("emojiPicker");
  const emojiContainer = document.getElementById("emojiContainer");
  const smileyIcon = document.getElementById("smileyIcon");
  const messageInput = document.getElementById("messageInput");

async function loadEmojis(category = "smileys") {
    emojiContainer.innerHTML = "";
    const categories = await getEmojiImageCategories();
    let emojis = [];
    if (categories && Object.keys(categories).length > 0) {
      const resolvedCategory = resolveEmojiImageCategory(category, categories);
      emojis = categories[resolvedCategory] || [];
    } else {
      emojis = emojiCategories[category] || [];
    }

    emojis.forEach((emoji) => {
      const emojiBtn = document.createElement("button");
      emojiBtn.type = "button";
      emojiBtn.className = "emoji-btn";
      emojiBtn.style.position = "relative"; // Важно для позиционирования canvas

      if (
        typeof emoji === "string" &&
        (emoji.startsWith("/images/") || emoji.startsWith("http"))
      ) {
        const img = document.createElement("img");
        img.src = emoji;
        img.alt = "";
        img.setAttribute("loading", "lazy"); // РЕШАЕТ ПРОБЛЕМУ ДОЛГОЙ ЗАГРУЗКИ В МЕНЮ!
        img.setAttribute("decoding", "async");
        img.style.width = "28px";
        img.style.height = "28px";
        img.style.objectFit = "contain";
        img.style.position = "absolute";
        img.style.top = "50%";
        img.style.left = "50%";
        img.style.transform = "translate(-50%, -50%)";
        img.style.opacity = "0"; // Скрываем анимацию по умолчанию
        img.style.transition = "opacity 0.2s ease";

        const canvas = document.createElement("canvas");
        canvas.style.width = "28px";
        canvas.style.height = "28px";
        canvas.style.position = "absolute";
        canvas.style.top = "50%";
        canvas.style.left = "50%";
        canvas.style.transform = "translate(-50%, -50%)";

        img.onload = () => {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
        };

        emojiBtn.appendChild(canvas);
        emojiBtn.appendChild(img);

        // Анимация при наведении на кнопку в меню
        emojiBtn.addEventListener("mouseenter", () => img.style.opacity = "1");
        emojiBtn.addEventListener("mouseleave", () => img.style.opacity = "0");

      } else {
        emojiBtn.textContent = emoji;
      }

      emojiBtn.addEventListener("click", () => {
        insertEmoji(emoji);
      });
      emojiContainer.appendChild(emojiBtn);
    });
}

  function insertEmoji(emoji) {
    messageInput.focus();
    let nodeToInsert;
    if (
      typeof emoji === "string" &&
      (emoji.startsWith("/images/") || emoji.startsWith("http"))
    ) {
      const img = document.createElement("img");
      img.src = emoji;
      img.alt = `[emoji:${emoji}]`;
      img.dataset.emoji = emoji;
      img.className = "emoji-inline";
      img.style.width = "20px";
      img.style.height = "20px";
      img.style.verticalAlign = "middle";
      img.style.objectFit = "contain";
      img.style.margin = "0 1px";
      nodeToInsert = img;
    } else {
      nodeToInsert = document.createTextNode(emoji);
    }

    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      let range = selection.getRangeAt(0);
      // Check if range is inside messageInput
      if (!messageInput.contains(range.commonAncestorContainer)) {
        range = document.createRange();
        range.selectNodeContents(messageInput);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      range.deleteContents();
      range.insertNode(nodeToInsert);
      range.collapse(false);
      
      const newRange = document.createRange();
      newRange.setStartAfter(nodeToInsert);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    } else {
      messageInput.appendChild(nodeToInsert);
    }

    updateInputState();
    sendTypingEvent();
  }

  // Переключение категорий эмодзи
  document.querySelectorAll(".emoji-category-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      document
        .querySelectorAll(".emoji-category-btn")
        .forEach((b) => b.classList.remove("active"));
      this.classList.add("active");
      loadEmojis(this.dataset.category);
    });
  });

  // Открытие/закрытие панели эмодзи
  smileyIcon.addEventListener("click", function (e) {
    e.stopPropagation();
    const isHidden = emojiPicker.classList.contains("hidden");

    // Закрываем меню вложений если открыто
    if (!attachmentMenu.classList.contains("hidden")) {
      attachmentMenu.classList.add("hidden");
    }

    // Переключаем панель эмодзи
    emojiPicker.classList.toggle("hidden");

    if (!isHidden) {
      // Если открывали панель, загружаем эмодзи
      loadEmojis();
    }

    // Обновляем состояние кнопок
    updateInputState();
  });

  // Закрытие панели эмодзи при клике вне ее
  document.addEventListener("click", function (e) {
    if (!emojiPicker.contains(e.target) && e.target !== smileyIcon) {
      emojiPicker.classList.add("hidden");
      updateInputState();
    }
  });

  // Закрытие панели эмодзи при отправке сообщения
  messageForm.addEventListener("submit", function () {
    emojiPicker.classList.add("hidden");
    updateInputState();
  });

  // Загружаем эмодзи по умолчанию при первом открытии
  loadEmojis();
}

// Функция для обновления состояния поля ввода и кнопок
function updateInputState() {
  const messageInput = document.getElementById("messageInput");
  const micIcon = document.getElementById("micIcon");
  const attachmentIcon = document.getElementById("attachmentIcon");
  const sendButton = document.getElementById("sendButton");
  const emojiPicker = document.getElementById("emojiPicker");

  const hasText = messageInput.value.trim() !== "";
  const emojiOpen = !emojiPicker.classList.contains("hidden");

  if (hasText || emojiOpen) {
    attachmentIcon.classList.add("hidden");
    sendButton.classList.remove("hidden");
    if (micIcon) micIcon.classList.add("hidden");
  } else {
    attachmentIcon.classList.remove("hidden");
    sendButton.classList.add("hidden");
    if (micIcon) micIcon.classList.remove("hidden");
  }
}

// ===================================
// === ФУНКЦИЯ ФИЛЬТРАЦИИ ЧАТОВ ===
// ===================================
function filterChatList(query) {
  if (!chatListUl) return;
  const filter = (query || "").trim().toLowerCase();
  const filterNoAt = filter.replace(/^@+/, "");

  // Получаем все элементы списка чатов (<li>)
  const chatListItems = chatListUl.querySelectorAll("li");
  let hasVisibleChats = false;

  chatListItems.forEach((li) => {
    // Пропускаем служебные элементы (заголовки, разделители, результаты поиска)
    if (
      li.classList.contains("search-results-header") ||
      li.classList.contains("search-result-item-list") ||
      li.classList.contains("sidebar-divider") ||
      li.classList.contains("no-results-message")
    ) {
      return; // Не фильтруем служебные элементы
    }

    // Ищем кнопку чата внутри <li>
    const chatButton = li.querySelector(".chat-list-item-btn");
    if (!chatButton) {
      return; // Пропускаем элементы без кнопки чата
    }

    // Ищем название чата (используем .chat-name, как в HTML)
    const chatNameElement = chatButton.querySelector(".chat-name");
    const chatName = chatNameElement
      ? chatNameElement.textContent.trim().toLowerCase()
      : "";

    // Также проверяем data-атрибут chat-name для надежности
    const chatNameFromData = chatButton.dataset.chatName
      ? chatButton.dataset.chatName.trim().toLowerCase()
      : "";

    // Используем название из элемента или из data-атрибута
    const titleToSearch = chatName || chatNameFromData;

    // Также ищем по последнему сообщению для более точного поиска
    const lastMessageElement = chatButton.querySelector(".last-message");
    const lastMessage = lastMessageElement
      ? lastMessageElement.textContent.trim().toLowerCase()
      : "";

    // Никнейм и email собеседника (по ним тоже ищем)
    const username = (chatButton.dataset.interlocutorUsername || "")
      .trim()
      .toLowerCase()
      .replace(/^@+/, "");
    const email = (chatButton.dataset.interlocutorEmail || "")
      .trim()
      .toLowerCase();
    const emailLocal = email && email.includes("@") ? email.split("@")[0] : "";

    // Проверяем совпадение по названию, сообщению, никнейму или email
    const matchesTitle = filter === "" || titleToSearch.includes(filter);
    const matchesMessage =
      filter === "" || (lastMessage && lastMessage.includes(filter));
    const matchesUsername =
      filter === "" ||
      (username && filterNoAt && username.includes(filterNoAt));
    const matchesEmail =
      filter === "" ||
      (email && email.includes(filter)) ||
      (emailLocal && filterNoAt && emailLocal.includes(filterNoAt));
    const isVisible =
      matchesTitle || matchesMessage || matchesUsername || matchesEmail;

    if (isVisible) {
      li.classList.remove("hidden");
      li.style.display = ""; // Убираем inline стили, если были
      hasVisibleChats = true;
    } else {
      li.classList.add("hidden");
      li.style.display = "none"; // Дополнительно скрываем через display
    }
  });

  // Показываем/скрываем кнопку очистки
  if (searchClearBtn) {
    searchClearBtn.classList.toggle("hidden", filter === "");
  }
}

// ===================================
// === ОБРАБОТЧИКИ СОБЫТИЙ ДЛЯ ПОИСКА ===
// ===================================

// Получаем форму поиска
const searchForm = document.getElementById("searchForm");

if (searchForm) {
  // Предотвращаем отправку формы (перезагрузку страницы)
  searchForm.addEventListener("submit", (e) => {
    e.preventDefault();
    // Мгновенный поиск уже работает через событие 'input'
    // Но если пользователь нажал Enter, тоже фильтруем
    if (searchInput) {
      filterChatList(searchInput.value);
    }
  });
}

if (searchInput) {
  // 1. МГНОВЕННЫЙ ПОИСК по мере ввода (событие 'input')
  searchInput.addEventListener("input", (e) => {
    const query = e.target.value;
    const trimmedQuery = query.trim();

    // Проверяем, какая вкладка активна
    const botsButton = document.getElementById("botsButton");
    const isBotsTab = botsButton && botsButton.classList.contains("active");

    if (trimmedQuery.length === 0) {
      // Если поле пустое, показываем основной список и скрываем результаты поиска пользователей
      if (userSearchResultsUl) {
        userSearchResultsUl.style.display = "none";
        userSearchResultsUl.innerHTML = "";
      }
      if (chatListUl) {
        chatListUl.style.display = "block";
      }

      if (isBotsTab) {
        // Во вкладке "Боты" перезагружаем список ботов без фильтра
        if (window.loadBotsList) {
          window.loadBotsList("");
        }
      } else {
        // В обычных чатах фильтруем список
        filterChatList(""); // Сброс фильтра чатов
      }
    } else {
      if (isBotsTab) {
        // Во вкладке "Боты" ищем только ботов
        if (window.loadBotsList) {
          window.loadBotsList(query);
        }
        // Скрываем результаты поиска пользователей
        if (userSearchResultsUl) {
          userSearchResultsUl.style.display = "none";
          userSearchResultsUl.innerHTML = "";
        }
      } else {
        // В обычных чатах фильтруем список и ищем пользователей
        filterChatList(query);
        // Параллельно ищем пользователей на бэкенде
        searchUsers(query);
      }
    }
  });
}

if (searchClearBtn) {
  // 2. ОЧИСТКА ПОЛЯ ПОИСКА (при клике на крестик)
  searchClearBtn.addEventListener("click", () => {
    if (searchInput) {
      searchInput.value = "";
      searchInput.focus();
      filterChatList(""); // Сброс фильтра
    }
    // Также прячем результаты поиска пользователей и показываем список чатов
    if (userSearchResultsUl) {
      userSearchResultsUl.style.display = "none";
      userSearchResultsUl.innerHTML = "";
    }
    if (chatListUl) {
      chatListUl.style.display = "block";
    }
  });
}

/**
 * Рендерит список чатов.
 * @param {Array<Object>} chats - Список объектов чатов.
 * ПРИМЕЧАНИЕ: Эта функция не используется для начального рендеринга.
 * Начальный рендеринг идет через Jinja шаблон в HTML.
 */
function renderChatList(chats) {
  // Функция оставлена для совместимости, но не используется
  // Чаты рендерятся через Jinja шаблон в chats.html
  return;
}

async function searchUsers(query) {
  const trimmedQuery = (query || "").trim();
  const queryForApi = trimmedQuery.replace(/^@+/, "").trim();
  if (trimmedQuery.length < 1 || queryForApi.length < 1) {
    if (userSearchResultsUl) {
      userSearchResultsUl.innerHTML = "";
      userSearchResultsUl.style.display = "none";
    }
    if (chatListUl) chatListUl.style.display = "block";
    return;
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/api/users/search?query=${encodeURIComponent(
        queryForApi
      )}`
    );
    if (!response.ok) {
      throw new Error("Ошибка поиска пользователей");
    }
    const data = await response.json();
    const usersFromApi = Array.isArray(data) ? data : data.users || [];

    // Объединяем с локальными контактами, чтобы искать по имени из контактов
    const q = queryForApi.toLowerCase();
    const mergedByEmail = new Map();
    usersFromApi.forEach((u) => {
      if (u && u.email) {
        mergedByEmail.set(u.email.toLowerCase(), {
          email: u.email,
          full_name: u.full_name || u.username || "",
          username: u.username || "",
          profile_picture: u.profile_picture || "",
        });
      }
    });
    try {
      const contactsMap = window.CONTACTS_BY_EMAIL || {};
      for (const [email, c] of Object.entries(contactsMap)) {
        const contactName =
          (c.contact_name || c.display_name || c.full_name || c.username || "")
            .toLowerCase()
            .trim();
        const username = (c.username || (email.split("@")[0] || "")).toLowerCase();
        const emailLocal = (email.split("@")[0] || "").toLowerCase();
        if (
          contactName.includes(q) ||
          (q && username.includes(q)) ||
          (q && emailLocal.includes(q))
        ) {
          const key = email.toLowerCase();
          if (!mergedByEmail.has(key)) {
            mergedByEmail.set(key, {
              email: email,
              full_name: c.contact_name || c.display_name || c.full_name || "",
              username: c.username || email.split("@")[0],
              profile_picture: "",
            });
          }
        }
      }
    } catch (_) {}

    const mergedUsers = Array.from(mergedByEmail.values());
    renderUserSearchResults(mergedUsers);
  } catch (error) {
    console.error("Ошибка при поиске пользователей:", error);
    if (userSearchResultsUl) {
      userSearchResultsUl.innerHTML = "";
    }
  }
}

/**
 * Рендерит результаты поиска пользователей с кнопкой "Начать чат".
 * @param {Array<Object>} users - Список найденных объектов пользователей.
 */
function renderUserSearchResults(users) {
  if (!userSearchResultsUl) return;

  userSearchResultsUl.innerHTML = "";

  // Скрываем обычный список чатов и показываем результаты поиска
  chatListUl.style.display = "none";
  userSearchResultsUl.style.display = "block";

  // === ДОБАВЛЯЕМ "ИЗБРАННОЕ" В РЕЗУЛЬТАТЫ ПОИСКА, ЕСЛИ СОВПАДАЕТ ЗАПРОС ===
  try {
    const currentQuery = (searchInput && searchInput.value) || "";
    const q = currentQuery.trim().toLowerCase();
    if (
      q &&
      ("избран".includes(q) || q.includes("избран") || q === "favorit")
    ) {
      const favBtn = document.querySelector(
        '.chat-list-item-btn[data-is-favorite="true"]'
      );
      if (favBtn) {
        const favLi = document.createElement("li");
        favLi.classList.add("search-result-item-list");
        favLi.innerHTML = `
          <button type="button" class="chat-list-item-btn search-result-chat-btn" data-favorite-shortcut="true">
            <img src="/images/avatars/favorit.png" alt="Избранное" />
            <div class="chat-info">
              <div class="chat-name">Избранное</div>
              <div class="last-message">Личные заметки</div>
            </div>
          </button>
        `;
        const btn = favLi.querySelector("button");
        btn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const chatId = favBtn.dataset.chatId;
          if (!chatId) return;
          // Скрываем результаты поиска и показываем список чатов
          if (userSearchResultsUl) {
            userSearchResultsUl.style.display = "none";
            userSearchResultsUl.innerHTML = "";
          }
          if (chatListUl) {
            chatListUl.style.display = "block";
          }
          // Активируем фаворит в списке и открываем чат
          document
            .querySelectorAll(".chat-list-item-btn")
            .forEach((b) => b.classList.remove("active"));
          favBtn.classList.add("active");
          setUnreadCount(chatId, 0);
          updateUrlForChat(favBtn);
          loadChat(chatId);
        });
        userSearchResultsUl.appendChild(favLi);
      }
    }
  } catch (e) {
    console.warn("Не удалось добавить Избранное в результаты поиска:", e);
  }

  if (users.length === 0 && !userSearchResultsUl.children.length) {
    userSearchResultsUl.innerHTML =
      '<li class="chat-item">Нет результатов поиска.</li>';
    return;
  }

  users.forEach((user) => {
    const safeEmail = user.email || "";
    const title =
      user.full_name ||
      user.username ||
      safeEmail.split("@")[0] ||
      "Пользователь";

    const avatarSrc = user.profile_picture || generateAvatar(title, user.email || user.username);

    const listItem = document.createElement("li");
    listItem.classList.add("search-result-item-list");
    listItem.dataset.userId = safeEmail; // Используем email как уникальный ID для поиска

    listItem.innerHTML = `
      <button type="button" class="chat-list-item-btn search-result-chat-btn">
        <img src="${avatarSrc}" alt="Avatar" />
        <div class="chat-info">
          <div class="chat-name">${title}</div>
          <div class="last-message">${safeEmail}</div>
        </div>
        <span class="chat-meta-right">
          <button class="start-chat-btn" type="button" title="Начать чат">
            <img src="/images/chat.svg" alt="Чат" />
          </button>
        </span>
      </button>
    `;

    // Обработчик кнопки "Начать чат"
    const startChatBtn = listItem.querySelector(".start-chat-btn");
    if (startChatBtn) {
      startChatBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        startChatWithUser(safeEmail, title, user.username || "");
      });
    }

    // Клик по всему результату — сразу создаем/открываем чат без дополнительных подтверждений
    const itemBtn = listItem.querySelector(".search-result-chat-btn");
    if (itemBtn) {
      itemBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        startChatWithUser(safeEmail, title, user.username || "");
      });
    }

    userSearchResultsUl.appendChild(listItem);
  });
}

/**
 * Стартует (или открывает существующий) приватный чат через backend /start_chat
 * и сразу переводит пользователя в окно этого чата.
 * Чат в базе создаётся, но сообщений ещё нет — пока пользователь не напишет первое.
 * @param {string} otherUserEmail
 * @param {string} title
 * @param {string} [otherUserUsername]
 */
async function startChatWithUser(otherUserEmail, title, otherUserUsername) {
  try {
    // 1. Прячем результаты поиска
    if (userSearchResultsUl) {
      userSearchResultsUl.style.display = "none";
      userSearchResultsUl.innerHTML = "";
    }

// === OPTIMIZATION: Check if chat already exists in the list ===
    // Use Array.from because querySelectorAll returns a NodeList which might not have .find() in all browsers
    const allBtns = Array.from(document.querySelectorAll(".chat-list-item-btn"));
    const existingChatBtn = allBtns.find(btn => {
        // === ИСПРАВЛЕНИЕ: Строго игнорируем групповые чаты и ботов ===
        if (btn.dataset.isGroupChat === "true" || btn.dataset.isGroup === "true" || btn.dataset.isBot === "true") {
            return false;
        }

        const btnEmail = btn.dataset.interlocutorEmail;
        const btnUsername = btn.dataset.interlocutorUsername;
        
        // Check email match (case-insensitive)
        if (otherUserEmail && btnEmail && btnEmail.toLowerCase() === otherUserEmail.toLowerCase()) {
            return true;
        }
        
        // Check username match (case-insensitive)
        if (otherUserUsername && btnUsername && btnUsername.toLowerCase() === otherUserUsername.toLowerCase()) {
            return true;
        }
        
        return false;
    });

    if (existingChatBtn) {
        const chatId = existingChatBtn.dataset.chatId;
        console.log(`[startChatWithUser] Found existing chat ${chatId} for ${otherUserEmail}`);
        
        // Switch to this chat
        allBtns.forEach((b) => b.classList.remove("active"));
        existingChatBtn.classList.add("active");
        
        if (window.innerWidth <= 900 && typeof window.switchToChatView === "function") {
            window.switchToChatView();
        }
        
        updateUrlForChat(existingChatBtn);
        
        // Reset search
        if (searchInput) searchInput.value = "";
        if (searchClearBtn) searchClearBtn.classList.add("hidden");
        filterChatList("");
        if (chatListUl) chatListUl.style.display = "block";
        
        // Load chat content
        await loadChat(chatId);
        
        // Show chat window
        if (chatWindow) chatWindow.classList.remove("hidden");
        if (chatEmptyState) chatEmptyState.classList.add("hidden");
        if (messageInput) messageInput.focus();
        
        return; // Exit early
    }

    // 2. Запрашиваем /start_chat, чтобы получить или создать чат
    const fd = new FormData();
    fd.append("target_email", otherUserEmail);

    const resp = await fetch(`${API_BASE_URL}/start_chat`, {
      method: "POST",
      body: fd,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || "Не удалось начать чат");
    }

    const data = await resp.json();
    const chatId = data.chat_id;
    if (!chatId) {
      throw new Error("Сервер не вернул chat_id");
    }

    // 3. Гарантируем наличие чата в списке единым путём, чтобы избежать дублей
    await ensureChatInList(chatId);
    // Повторно получаем кнопку чата из DOM
    let chatBtn = document.querySelector(
      `.chat-list-item-btn[data-chat-id="${chatId}"]`
    );

    // 4. Сбрасываем выделение и подсвечиваем новый/найденный чат
    document
      .querySelectorAll(".chat-list-item-btn")
      .forEach((b) => b.classList.remove("active"));
    
    if (chatBtn) {
      chatBtn.classList.add("active");
    }

    // 4.1. Мобильный UX: сразу переключаемся в режим чата
    if (window.innerWidth <= 900 && typeof window.switchToChatView === "function") {
      window.switchToChatView();
    }

    // 4.1. ОБЯЗАТЕЛЬНО обновляем URL на /@username (Telegram логика)
    // URL должен отражать текущий открытый чат
    if (chatBtn) {
      updateUrlForChat(chatBtn);
    } else {
      // Fallback: если кнопка не создалась (например, из-за гонки или ошибки), формируем URL вручную
      updateUrlForChat({
        dataset: {
          chatId: chatId,
          isGroupChat: "false",
          interlocutorUsername: otherUserUsername || "",
          interlocutorEmail: otherUserEmail || "",
          isFavorite: "false"
        }
      });
    }

    // 5. Сбрасываем поиск так же, как при нажатии на крестик
    if (searchInput) {
      searchInput.value = "";
    }
    if (searchClearBtn) {
      searchClearBtn.classList.add("hidden");
    }
    filterChatList("");
    if (chatListUl) {
      chatListUl.style.display = "block";
    }

    // 6. Открываем окно чата
    // Если чат открыт по URL, устанавливаем флаг перед загрузкой и включаем защиту
    if (isChatOpenedFromUrl) {
      console.log(
        "[Telegram Logic] startChatWithUser: чат открыт по URL, сохраняем флаг и включаем защиту"
      );
      protectChatFromClosing();
    }

    // loadChat уже показывает окно чата внутри себя, но убеждаемся еще раз
    await loadChat(chatId);

    // Дополнительная гарантия: показываем окно чата и скрываем пустое состояние
    // Если чат открыт по URL, делаем это несколько раз
    if (isChatOpenedFromUrl) {
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (chatWindow) {
          chatWindow.classList.remove("hidden");
          chatWindow.style.display = "";
          chatWindow.style.visibility = "visible";
          chatWindow.style.opacity = "1";
        }
        if (chatEmptyState) {
          chatEmptyState.classList.add("hidden");
          chatEmptyState.style.display = "none";
        }
        activeChatId = chatId;
        window.activeChatId = chatId;
      }
    } else {
      if (chatWindow) chatWindow.classList.remove("hidden");
      if (chatEmptyState) chatEmptyState.classList.add("hidden");
    }
    if (messageInput) messageInput.focus();
  } catch (err) {
    console.error("Ошибка при старте чата:", err);
    alert(err.message || "Не удалось начать чат");
  }
}

// ===================================================================
// === КОНТАКТЫ ======================================================
// ===================================================================

const contactsList = document.getElementById("contactsList");
const contactsEmpty = document.getElementById("contactsEmpty");
const contactsCountDisplay = document.getElementById("contactsCountDisplay");
const openAddContactBtn = document.getElementById("openAddContactBtn");
const addContactModal = document.getElementById("addContactModal");
const addContactForm = document.getElementById("addContactForm");
const addContactCloseBtn = document.getElementById("addContactCloseBtn");
const cancelAddContact = document.getElementById("cancelAddContact");
const contactFirstNameInput = document.getElementById("contactFirstName");
const contactLastNameInput = document.getElementById("contactLastName");
const contactEmailInput = document.getElementById("contactEmail");
const addContactError = document.getElementById("addContactError");

// Карта контактов по email для использования в чатах / группах
let contactsByEmail = {};
window.CONTACTS_BY_EMAIL = contactsByEmail;

function toggleContactsHidden(el, hidden) {
  if (!el) return;
  if (hidden) {
    el.classList.add("hidden");
  } else {
    el.classList.remove("hidden");
  }
}

function formatContactStatus(lastSeen, isOnline) {
  if (isOnline) {
    return "В сети";
  }
  if (typeof lastSeen === "string" && lastSeen.toLowerCase() === "online") {
    return "В сети";
  }
  if (!lastSeen) {
    return "";
  }
  try {
    const d = new Date(lastSeen);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / (1000 * 60));
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    if (diffMin < 1) return "Только что";
    if (diffMin < 60) return `Был(а) ${diffMin} мин. назад`;
    if (diffHour < 24) return `Был(а) ${diffHour} ч. назад`;
    if (diffDay === 1) {
      const timeStr = d.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      });
      return `Был(а) вчера в ${timeStr}`;
    }
    if (diffDay < 7) return `Был(а) ${diffDay} дн. назад`;
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch (e) {
    return typeof lastSeen === "string" ? lastSeen : "";
  }
}

function renderContactsList(contacts = []) {
  if (!contactsList) return;
  contactsList.innerHTML = "";

  // Перестраиваем карту контактов
  contactsByEmail = {};
  window.CONTACTS_BY_EMAIL = contactsByEmail;

  if (!contacts || contacts.length === 0) {
    if (contactsEmpty) {
      contactsEmpty.textContent = "Пока нет контактов";
      toggleContactsHidden(contactsEmpty, false);
    }
    return;
  }
  toggleContactsHidden(contactsEmpty, true);

  contacts.forEach((c) => {
    const displayName =
      c.display_name || c.full_name || c.username || c.email || "Контакт";
    const isOnline = c.is_online || false;

    if (c.email) {
      contactsByEmail[c.email.toLowerCase()] = {
        display_name: c.display_name,
        full_name: c.full_name,
        username: c.username,
        contact_name: displayName,
      };
    }

    const lastSeen = c.last_seen;
    const status = formatContactStatus(lastSeen, isOnline);
    const statusClass = isOnline ? "online" : "";

    const li = document.createElement("li");
    li.className = "contact-card";
    li.dataset.email = c.email || "";
    li.dataset.username = c.username || "";
    li.dataset.displayName = displayName;

    const avatarUrl = !isDefaultAvatar(c.profile_picture) ? c.profile_picture : generateAvatar(displayName, c.email);

    li.innerHTML = `
      <div class="contact-avatar">
        <img src="${avatarUrl}" alt="${displayName}" />
        ${isOnline ? '<div class="contact-online-dot"></div>' : ""}
      </div>
      <div class="contact-info">
        <div class="contact-name">
          ${displayName}
          ${c.is_favorite ? '<span class="contact-name-star">⭐</span>' : ""}
        </div>
        <div class="contact-status ${statusClass}">${status}</div>
      </div>
    `;

    // Клик по контакту — открываем чат с ним
    li.addEventListener("click", async () => {
      // Переключаемся на вкладку "Чаты"
      const chatsBtn = document.getElementById("chatsButton");
      if (chatsBtn) {
        chatsBtn.click();
      }
      // Открываем чат с контактом
      setTimeout(() => {
        if (c.email) {
          startChatWithUser(c.email, displayName, c.username || "");
        }
      }, 100);
    });

    contactsList.appendChild(li);
  });
}

// === 1. ПРАВИЛЬНАЯ ФУНКЦИЯ ЗАГРУЗКИ КОНТАКТОВ ===
async function loadContacts() {
  try {
    const resp = await fetch(`${API_BASE_URL}/api/contacts`, {
      credentials: "include"
    });
    if (!resp.ok) throw new Error("Не удалось загрузить контакты");
    const data = await resp.json();
    if (contactsCountDisplay) {
      contactsCountDisplay.textContent = data.count || 0;
    }
    renderContactsList(data.contacts || []);
  } catch (err) {
    console.error(err);
    if (contactsCountDisplay) contactsCountDisplay.textContent = "0";
    renderContactsList([]);
  }
}

  async function loadCallsHistory(filter = "all") {
    const callsList = document.getElementById("callsList");
    const callsEmpty = document.getElementById("callsEmpty");

    if (!callsList || !callsEmpty) return;

    try {
      const resp = await fetch(`${API_BASE_URL}/api/calls/history`, {
        credentials: "include",
      });
      if (!resp.ok) throw new Error("Не удалось загрузить историю звонков");
      const data = await resp.json();
      let calls = data.calls || [];

      if (filter === "missed") {
        calls = calls.filter((c) => c.status === "missed");
      }

      renderCallsList(calls);
    } catch (err) {
      console.error("Ошибка загрузки истории звонков:", err);
      renderCallsList([]);
    }
  }

  function renderCallsList(calls) {
    const callsList = document.getElementById("callsList");
    const callsEmpty = document.getElementById("callsEmpty");

    if (!callsList || !callsEmpty) return;

    callsList.innerHTML = "";

    if (!calls.length) {
      callsEmpty.classList.remove("hidden");
      return;
    }

    callsEmpty.classList.add("hidden");

    const formatTime = (iso) => {
      if (!iso) return "";
      try {
        const d = new Date(iso);
        return d.toLocaleTimeString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch {
        return "";
      }
    };

    const formatDate = (iso) => {
      if (!iso) return "";
      try {
        const d = new Date(iso);
        return d.toLocaleDateString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
        });
      } catch {
        return "";
      }
    };

    const formatDuration = (seconds) => {
      if (seconds == null) return "";
      const s = Number(seconds) || 0;
      const m = Math.floor(s / 60);
      const rest = s % 60;
      if (!s) return "";
      if (m > 0) {
        return `${m} мин ${rest.toString().padStart(2, "0")} сек`;
      }
      return `${rest} сек`;
    };

    calls.forEach((call) => {
      const li = document.createElement("li");
      li.className = "call-item";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "call-item-btn";

      const direction = call.direction === "outgoing" ? "Исходящий" : "Входящий";
      const isMissed = call.status === "missed";
      const isRejected = call.status === "rejected";

      const directionClass =
          call.direction === "outgoing"
              ? "call-direction-outgoing"
              : "call-direction-incoming";

      const statusClass = isMissed
          ? "call-status-missed"
          : isRejected
              ? "call-status-rejected"
              : "call-status-completed";

      const timeStr = formatTime(call.started_at);
      const dateStr = formatDate(call.started_at);
      const durationStr = formatDuration(call.duration);

      const name = call.peer_name || call.peer_email || "Пользователь";
      const avatar =
          call.peer_avatar && !call.peer_avatar.includes("юзер.svg")
              ? call.peer_avatar
              : generateAvatar(name, call.peer_email || "user");

      btn.innerHTML = `
      <div class="call-item-left">
        <div class="call-avatar">
          <img src="${avatar}" alt="${name}" loading="lazy" />
        </div>
        <div class="call-text">
          <div class="call-name-row">
            <span class="call-name">${name}</span>
            <span class="call-time">${timeStr}</span>
          </div>
          <div class="call-meta-row">
            <span class="call-direction ${directionClass}">
              <span class="call-direction-icon"></span>
              ${direction.toLowerCase()}
            </span>
            <span class="call-status ${statusClass}">
              ${
          isMissed
              ? "пропущен"
              : isRejected
                  ? "отклонён"
                  : "завершён"
      }
            </span>
            ${
          durationStr
              ? `<span class="call-duration">${durationStr}</span>`
              : ""
      }
          </div>
        </div>
      </div>
      <div class="call-date">${dateStr}</div>
    `;

      btn.addEventListener("click", () => {
        // При клике открываем чат с собеседником, если есть chat_id
        if (typeof window.switchTab === "function") {
          window.switchTab("chats");
        }

        if (call.chat_id) {
          const chatBtn = document.querySelector(
              `.chat-list-item-btn[data-chat-id="${call.chat_id}"]`
          );
          if (chatBtn) {
            chatBtn.click();
            return;
          }
        }

        // Если чат ещё не создан, пробуем создать приватный чат по email
        if (call.peer_email) {
          startChatWithUser(
              call.peer_email,
              call.peer_name || call.peer_email,
              ""
          );
        }
      });

      li.appendChild(btn);
      callsList.appendChild(li);
    });

    // Обновляем фильтры (если были изменены программно)
    const filterButtons = document.querySelectorAll(".calls-filter-btn");
    filterButtons.forEach((btn) => {
      if (btn.dataset.callsFilterInitialized === "true") return;
      btn.dataset.callsFilterInitialized = "true";
      btn.addEventListener("click", () => {
        const filter = btn.dataset.filter || "all";
        filterButtons.forEach((b) =>
            b.classList.toggle(
                "calls-filter-btn-active",
                b === btn || b.dataset.filter === filter
            )
        );
        loadCallsHistory(filter);
      });
    });
  }

  function openAddContactModal() {
    if (!addContactModal) return;
    toggleContactsHidden(addContactModal, false);
    if (addContactError) toggleContactsHidden(addContactError, true);
    if (contactFirstNameInput) contactFirstNameInput.focus();
  }

  function closeAddContactModal() {
    toggleContactsHidden(addContactModal, true);
    if (addContactForm) addContactForm.reset();
    if (addContactError) toggleContactsHidden(addContactError, true);
  }

  function showAddContactError(message) {
    if (!addContactError) return;
    addContactError.textContent = message;
    toggleContactsHidden(addContactError, false);
  }

// Обработчики событий для контактов
  if (openAddContactBtn) {
    openAddContactBtn.addEventListener("click", () => {
      openAddContactModal();
    });
  }

  if (addContactCloseBtn) {
    addContactCloseBtn.addEventListener("click", closeAddContactModal);
  }

  if (cancelAddContact) {
    cancelAddContact.addEventListener("click", closeAddContactModal);
  }

  if (addContactForm) {
    addContactForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!contactFirstNameInput || !contactEmailInput) return;
      const firstName = contactFirstNameInput.value.trim();
      const lastName = contactLastNameInput?.value.trim();
      const email = contactEmailInput.value.trim().toLowerCase();

      if (!firstName) {
        showAddContactError("Имя обязательно");
        return;
      }
      if (!email) {
        showAddContactError("Укажите почту");
        return;
      }

      try {
        const resp = await fetch(`${API_BASE_URL}/api/contacts`, {
          method: "POST",
          credentials: "include",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            email,
            first_name: firstName,
            last_name: lastName || null,
          }),
        });

        if (resp.status === 404) {
          showAddContactError("Пользователь не найден в системе");
          return;
        }

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          showAddContactError(errData.detail || "Не удалось добавить контакт");
          return;
        }

        closeAddContactModal();
        await loadContacts();
      } catch (err) {
        console.error("Ошибка добавления контакта:", err);
        showAddContactError("Произошла ошибка, попробуйте еще раз");
      }
    });
  }

// Закрытие модалки по клику на фон
  if (addContactModal) {
    addContactModal.addEventListener("click", (e) => {
      if (e.target === addContactModal) {
        closeAddContactModal();
      }
    });
  }

// Загрузка контактов при открытии вкладки
  window.addEventListener("contactsTabOpened", () => {
    loadContacts();
  });

// Обработчик кнопки приглашения (копирование ссылки)
  const contactsInviteLinkBtn = document.getElementById("contactsInviteLinkBtn");
  if (contactsInviteLinkBtn) {
    const email = window.CURRENT_USER_EMAIL;
    if (email) {
      const inviteLink = `${window.location.origin}/chats?action=start_chat&email=${encodeURIComponent(email)}`;
      // Truncate for display: "domain.com/chats..."
      try {
        const urlObj = new URL(inviteLink);
        const displayLink = urlObj.host + urlObj.pathname + "...";
        contactsInviteLinkBtn.textContent = displayLink;
      } catch (e) {
        contactsInviteLinkBtn.textContent = "flicker.com/invite...";
      }
    }

    contactsInviteLinkBtn.addEventListener("click", () => {
      const email = window.CURRENT_USER_EMAIL;
      if (!email) return;

      const inviteLink = `${window.location.origin}/chats?action=start_chat&email=${encodeURIComponent(email)}`;

      navigator.clipboard.writeText(inviteLink).then(() => {
        // Сохраняем текущий текст (сокращенный)
        const originalText = contactsInviteLinkBtn.textContent;

        contactsInviteLinkBtn.textContent = "Ссылка скопирована!";
        contactsInviteLinkBtn.classList.add("copied");

        setTimeout(() => {
          contactsInviteLinkBtn.textContent = originalText;
          contactsInviteLinkBtn.classList.remove("copied");
        }, 2000);
      }).catch(err => {
        console.error('Не удалось скопировать ссылку: ', err);
      });
    });
  }

// Проверка URL параметров для автоматического начала чата
  window.addEventListener("DOMContentLoaded", () => {
    const urlParams = new URLSearchParams(window.location.search);
    const action = urlParams.get("action");
    const targetEmail = urlParams.get("email");

    if (action === "start_chat" && targetEmail) {
      // Очищаем URL от параметров
      const newUrl = window.location.pathname;
      window.history.replaceState({}, document.title, newUrl);

      setTimeout(() => {
        if (typeof window.switchTab === "function") {
          window.switchTab("chats");
        }
        // Запускаем чат
        startChatWithUser(targetEmail, targetEmail, "");
      }, 800);
    }
  });

// Загрузка истории звонков при открытии вкладки "Звонки"
  window.addEventListener("callsTabOpened", () => {
    loadCallsHistory();
  });

// Экспортируем функции для использования в других местах
  window.loadContacts = loadContacts;

// ========================================================
// === ИНИЦИАЛИЗАЦИЯ UI ДЛЯ ЗВОНКОВ ===
// ========================================================
  function setupCallManagerUI() {
    if (!callManager) return;

    // Обработка статуса соединения
    callManager.onConnectionStateChange = (state) => {
      const callTimer = document.getElementById("callTimer");
      console.log("[UI] Connection state changed:", state);

      if (state === "connected") {
        if (callTimer) {
          // Если таймер не запущен, запускаем
          if (!callTimerInterval) startCallTimer();
          callTimer.style.fontSize = "24px";
        }
      } else if (state === "disconnected" || state === "failed") {
        if (callTimer) {
          callTimer.textContent = "Нет сети...";
          callTimer.style.fontSize = "16px";
        }
      } else if (state === "connecting" || state === "new") {
        if (callTimer) {
          callTimer.textContent = "Соединение...";
          callTimer.style.fontSize = "16px";
        }
      }
    };

    // Переопределяем методы UI
    callManager.showIncomingCallUI = (callData) => {
      const modal = document.getElementById("incomingCallModal");
      const avatar = document.getElementById("incomingCallAvatar");
      const name = document.getElementById("incomingCallName");
      const type = document.getElementById("incomingCallType");

      if (!modal) {
        console.error("[Calls] Модальное окно входящего звонка не найдено");
        return;
      }

      // Получаем информацию о звонящем из текущего чата или контактов
      const chatBtn = document.querySelector(
          `.chat-list-item-btn[data-chat-id="${callData.chat_id}"]`
      );
      if (chatBtn) {
        const chatName = chatBtn.dataset.chatName || "Пользователь";
        const chatAvatar =
            chatBtn.querySelector("img")?.src || generateAvatar(chatName, callData.chat_id);
        if (avatar) {
          const img = avatar.querySelector("img");
          if (img) img.src = chatAvatar;
        }
        if (name) name.textContent = chatName;
      } else {
        // Если чат не найден, используем данные из callData
        if (name) name.textContent = callData.caller_email || "Пользователь";
      }

      if (type) {
        type.textContent =
            callData.call_type === "video" ? "Видео звонок" : "Аудио звонок";
      }

      // Показываем модальное окно
      modal.classList.remove("hidden");

      // Останавливаем все предыдущие звуки перед воспроизведением нового
      if (typeof stopRingtone === "function") {
        stopRingtone();
      }
      if (typeof stopDialTone === "function") {
        stopDialTone();
      }

      // Воспроизводим звук звонка
      if (typeof playRingtone === "function") {
        playRingtone();
      }

      // Фокус на модальном окне для доступности
      modal.focus();
    };

    // Звук звонка
    let ringtoneInterval = null;

    function playRingtone() {
      // Создаем звук звонка через Web Audio API
      try {
        const audioContext = new (window.AudioContext ||
            window.webkitAudioContext)();

        const playBeep = () => {
          const oscillator = audioContext.createOscillator();
          const gainNode = audioContext.createGain();

          oscillator.connect(gainNode);
          gainNode.connect(audioContext.destination);

          oscillator.frequency.value = 800;
          oscillator.type = "sine";

          gainNode.gain.setValueAtTime(0.12, audioContext.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(
              0.001,
              audioContext.currentTime + 0.4
          );

          oscillator.start(audioContext.currentTime);
          oscillator.stop(audioContext.currentTime + 0.4);
        };

        // Первый сигнал
        playBeep();

        // Повторяем каждые 1.5 секунды
        ringtoneInterval = setInterval(playBeep, 1500);
      } catch (e) {
        console.warn("[Calls] Не удалось воспроизвести звук звонка:", e);
      }
    }

    function stopRingtone() {
      if (ringtoneInterval) {
        clearInterval(ringtoneInterval);
        ringtoneInterval = null;
      }
    }

    // Гудок для инициатора (пока звонок не принят)
    let dialToneInterval = null;
    let dialToneAudioContext = null;

    function playDialTone() {
      // Останавливаем предыдущий гудок если он есть
      stopDialTone();

      try {
        dialToneAudioContext = new (window.AudioContext ||
            window.webkitAudioContext)();

        const playTone = () => {
          if (!dialToneAudioContext || dialToneAudioContext.state === "closed") {
            return;
          }

          try {
            const oscillator = dialToneAudioContext.createOscillator();
            const gainNode = dialToneAudioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(dialToneAudioContext.destination);

            oscillator.frequency.value = 400;
            oscillator.type = "sine";

            gainNode.gain.setValueAtTime(0.1, dialToneAudioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(
                0.001,
                dialToneAudioContext.currentTime + 0.25
            );

            oscillator.start(dialToneAudioContext.currentTime);
            oscillator.stop(dialToneAudioContext.currentTime + 0.25);
          } catch (e) {
            console.warn("[Calls] Ошибка воспроизведения тона гудка:", e);
          }
        };

        // Первый сигнал
        playTone();

        // Повторяем каждые 1 секунду
        dialToneInterval = setInterval(playTone, 1000);
      } catch (e) {
        console.warn("[Calls] Не удалось воспроизвести гудок:", e);
        dialToneAudioContext = null;
      }
    }

    function stopDialTone() {
      // Останавливаем интервал
      if (dialToneInterval) {
        clearInterval(dialToneInterval);
        dialToneInterval = null;
      }

      // Закрываем AudioContext
      if (dialToneAudioContext) {
        try {
          if (dialToneAudioContext.state !== "closed") {
            dialToneAudioContext.close();
          }
        } catch (e) {
          console.warn("[Calls] Ошибка закрытия AudioContext:", e);
        }
        dialToneAudioContext = null;
      }
    }

    // Модалка "звоним" для инициатора
    callManager.showCallingUI = () => {
      const overlay = document.getElementById("activeCallOverlay");
      const callInfoPanel = document.getElementById("callInfoPanel");
      const activeCallAvatar = document.getElementById("activeCallAvatar");
      const activeCallName = document.getElementById("activeCallName");
      const callTimer = document.getElementById("callTimer");
      const localVideo = document.getElementById("localVideo");

      // Показываем локальное видео/аудио
      if (localVideo && callManager.localStream) {
        localVideo.srcObject = callManager.localStream;
      }

      // Получаем информацию о собеседнике
      if (callManager.currentCall) {
        const chatBtn = document.querySelector(
            `.chat-list-item-btn[data-chat-id="${callManager.currentCall.chat_id}"]`
        );
        if (chatBtn) {
          const chatName = chatBtn.dataset.chatName || "Пользователь";
          const chatAvatar =
              chatBtn.querySelector("img")?.src || generateAvatar(chatName, callManager.currentCall.chat_id);
          if (activeCallAvatar)
            activeCallAvatar.querySelector("img").src = chatAvatar;
          if (activeCallName) activeCallName.textContent = chatName;
        }
      }

      // Показываем панель информации
      if (callInfoPanel) {
        callInfoPanel.style.display = "flex";
      }

      // Показываем статус "звоним..."
      if (callTimer) {
        callTimer.textContent = "Звоним...";
        callTimer.style.fontSize = "18px";
      }

      // Скрываем кнопку камеры для аудио звонков
      const toggleCameraBtn = document.getElementById("toggleCameraBtn");
      if (toggleCameraBtn) {
        toggleCameraBtn.style.display =
            callManager.currentCall?.type === "video" ? "block" : "none";
      }

      // Показываем overlay
      if (overlay) overlay.classList.remove("hidden");

      // Воспроизводим гудок для инициатора
      playDialTone();
    };

    callManager.showActiveCallUI = () => {
      const overlay = document.getElementById("activeCallOverlay");
      const localVideo = document.getElementById("localVideo");
      const remoteVideo = document.getElementById("remoteVideo");
      const callInfoPanel = document.getElementById("callInfoPanel");
      const activeCallAvatar = document.getElementById("activeCallAvatar");
      const activeCallName = document.getElementById("activeCallName");
      const indicator = document.getElementById("activeCallIndicator");
      const indicatorText = document.getElementById("activeCallIndicatorText");
      const callTimer = document.getElementById("callTimer");
      const ringtoneAudio = document.getElementById("ringtoneAudio");

      // Останавливаем ВСЕ звуки (гудок, звонок, аудио элементы)
      if (typeof stopRingtone === "function") {
        stopRingtone();
      }
      if (typeof stopDialTone === "function") {
        stopDialTone();
      }
      // Останавливаем HTML audio элемент если он есть
      if (ringtoneAudio) {
        ringtoneAudio.pause();
        ringtoneAudio.currentTime = 0;
      }

      // Скрываем модалку входящего звонка
      const incomingModal = document.getElementById("incomingCallModal");
      if (incomingModal) incomingModal.classList.add("hidden");

      // Показываем локальное видео
      if (localVideo && callManager.localStream) {
        localVideo.srcObject = callManager.localStream;
      }

      // Получаем информацию о собеседнике
      let participantName = "Пользователь";
      if (callManager.currentCall) {
        const chatBtn = document.querySelector(
            `.chat-list-item-btn[data-chat-id="${callManager.currentCall.chat_id}"]`
        );
        if (chatBtn) {
          participantName = chatBtn.dataset.chatName || "Пользователь";
          const chatAvatar =
              chatBtn.querySelector("img")?.src || generateAvatar(participantName, callManager.currentCall.chat_id);
          if (activeCallAvatar)
            activeCallAvatar.querySelector("img").src = chatAvatar;
          if (activeCallName) activeCallName.textContent = participantName;
        }

        // Обновляем индикатор
        if (indicatorText) {
          indicatorText.textContent = `В звонке с ${participantName}`;
        }

        // Обновляем статус звонка
        if (callManager.currentCall.status) {
          callManager.currentCall.status = "active";
        }
      }

      // Показываем индикатор активного звонка
      if (indicator) indicator.classList.remove("hidden");

      // Восстанавливаем нормальный размер таймера и начинаем отсчет
      if (callTimer) {
        callTimer.style.fontSize = "24px";
        callTimer.textContent = "00:00";
      }

      // Скрываем панель информации, если есть видео
      if (callInfoPanel && callManager.currentCall?.type === "video") {
        callInfoPanel.style.display = "none";
      } else if (callInfoPanel) {
        callInfoPanel.style.display = "flex";
      }

      // Показываем/скрываем кнопку камеры в зависимости от типа звонка
      const toggleCameraBtn = document.getElementById("toggleCameraBtn");
      if (toggleCameraBtn) {
        toggleCameraBtn.style.display =
            callManager.currentCall?.type === "video" ? "block" : "none";
      }

      if (overlay) overlay.classList.remove("hidden");

      // Запускаем таймер только если соединение уже установлено
      if (callManager.peerConnection && callManager.peerConnection.connectionState === 'connected') {
        startCallTimer();
      } else {
        if (callTimer) {
          callTimer.textContent = "Соединение...";
          callTimer.style.fontSize = "16px";
        }
      }
    };

    callManager.hideCallUI = () => {
      const modal = document.getElementById("incomingCallModal");
      const overlay = document.getElementById("activeCallOverlay");
      const indicator = document.getElementById("activeCallIndicator");
      const remoteAudio = document.getElementById("remoteAudio");
      const ringtoneAudio = document.getElementById("ringtoneAudio");

      // Останавливаем все звуки
      if (typeof stopRingtone === "function") {
        stopRingtone();
      }
      if (typeof stopDialTone === "function") {
        stopDialTone();
      }
      // Останавливаем HTML audio элемент
      if (ringtoneAudio) {
        ringtoneAudio.pause();
        ringtoneAudio.currentTime = 0;
      }

      // Удаляем audio элемент если был создан
      if (remoteAudio) {
        remoteAudio.srcObject = null;
        remoteAudio.remove();
      }

      if (modal) {
        modal.classList.add("hidden");
        // Сбрасываем данные модального окна
        const name = document.getElementById("incomingCallName");
        const type = document.getElementById("incomingCallType");
        if (name) name.textContent = "Входящий звонок";
        if (type) type.textContent = "Аудио звонок";
      }
      if (overlay) overlay.classList.add("hidden");
      if (indicator) indicator.classList.add("hidden");
      stopCallTimer();
    };

    callManager.onRemoteStreamReceived = (stream) => {
      console.log(
          "[Calls] Remote stream received",
          stream,
          "tracks:",
          stream.getTracks().length
      );

      // Убеждаемся, что все треки включены и активны
      stream.getTracks().forEach((track) => {
        track.enabled = true;
        // Примечание: track.muted - это только геттер, его нельзя установить
        if (track.readyState === "ended") {
          console.warn("[Calls] Track", track.id, "is ended");
        }
        console.log(
            "[Calls] Track:",
            track.kind,
            track.id,
            "enabled:",
            track.enabled,
            "readyState:",
            track.readyState,
            "muted:",
            track.muted
        );
      });

      const remoteVideo = document.getElementById("remoteVideo");
      const localVideo = document.getElementById("localVideo");
      let remoteAudio = document.getElementById("remoteAudio");

      // Для аудио звонков создаем отдельный audio элемент
      if (callManager.currentCall?.type === "audio") {
        if (!remoteAudio) {
          // Создаем скрытый audio элемент для воспроизведения аудио
          remoteAudio = document.createElement("audio");
          remoteAudio.id = "remoteAudio";
          remoteAudio.autoplay = true;
          remoteAudio.playsInline = true;
          remoteAudio.volume = 1.0;
          remoteAudio.muted = false;
          remoteAudio.style.display = "none";
          document.body.appendChild(remoteAudio);
        }

        // Останавливаем старый поток если есть
        if (remoteAudio.srcObject) {
          const oldStream = remoteAudio.srcObject;
          oldStream.getTracks().forEach((track) => {
            track.stop();
            track.enabled = false;
          });
        }

        // Проверяем, что в потоке есть аудио треки
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
          console.warn(
              "[Calls] No audio tracks in remote stream, checking all tracks"
          );
          const allTracks = stream.getTracks();
          console.log("[Calls] All tracks:", allTracks.length);
          if (allTracks.length === 0) {
            return;
          }
        }

        // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что все треки включены перед установкой
        stream.getTracks().forEach((track) => {
          track.enabled = true;
          console.log("[Calls] Track before setting srcObject:", {
            id: track.id,
            kind: track.kind,
            enabled: track.enabled,
            readyState: track.readyState,
          });
        });

        remoteAudio.srcObject = stream;
        console.log(
            "[Calls] Setting remote audio stream, tracks:",
            stream.getTracks().length
        );

        // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что элемент не приглушен
        remoteAudio.muted = false;
        remoteAudio.volume = 1.0;

        // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что треки все еще включены после установки srcObject
        setTimeout(() => {
          if (remoteAudio.srcObject) {
            remoteAudio.srcObject.getTracks().forEach((track) => {
              track.enabled = true;
              console.log("[Calls] Track after setting srcObject:", {
                id: track.id,
                kind: track.kind,
                enabled: track.enabled,
                readyState: track.readyState,
              });
            });
          }
        }, 100);

        // Убеждаемся, что элемент готов к воспроизведению
        remoteAudio.load();

        // Воспроизводим аудио с повторными попытками и улучшенной обработкой
        let playAttempts = 0;
        const maxPlayAttempts = 10;

        const playAudio = () => {
          if (!remoteAudio || !remoteAudio.srcObject) {
            console.warn("[Calls] No srcObject for remote audio");
            return;
          }

          // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что треки включены
          const tracks = remoteAudio.srcObject.getTracks();
          tracks.forEach((track) => {
            track.enabled = true;
          });

          const activeTracks = tracks.filter(
              (t) => t.readyState === "live" && t.enabled
          );
          if (activeTracks.length === 0) {
            console.warn("[Calls] No active tracks in remote stream");
            if (playAttempts < maxPlayAttempts) {
              playAttempts++;
              setTimeout(playAudio, 1000);
            }
            return;
          }

          // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что элемент не приглушен перед воспроизведением
          remoteAudio.muted = false;
          remoteAudio.volume = 1.0;

          const playPromise = remoteAudio.play();
          if (playPromise !== undefined) {
            playPromise
                .then(() => {
                  console.log("[Calls] Remote audio playing successfully");
                  // Проверяем что аудио действительно воспроизводится
                  if (remoteAudio.paused) {
                    console.warn(
                        "[Calls] Audio element is paused, trying to play again"
                    );
                    setTimeout(playAudio, 500);
                  }
                })
                .catch((e) => {
                  console.warn(
                      "[Calls] Error playing audio, attempt",
                      playAttempts + 1,
                      "/",
                      maxPlayAttempts,
                      ":",
                      e
                  );
                  if (playAttempts < maxPlayAttempts) {
                    playAttempts++;
                    setTimeout(playAudio, 500);
                  } else {
                    console.error(
                        "[Calls] Failed to play audio after",
                        maxPlayAttempts,
                        "attempts"
                    );
                  }
                });
          }
        };

        // Пробуем воспроизвести сразу и после загрузки метаданных
        remoteAudio.addEventListener(
            "loadedmetadata",
            () => {
              console.log("[Calls] Metadata loaded for remote audio");
              playAudio();
            },
            {once: true}
        );

        // Также пробуем после canplay
        remoteAudio.addEventListener(
            "canplay",
            () => {
              console.log("[Calls] Can play remote audio");
              playAudio();
            },
            {once: true}
        );

        // Пробуем сразу
        playAudio();
      } else {
        // Для видео звонков используем video элемент
        if (remoteVideo) {
          remoteVideo.srcObject = stream;
        }
      }

      // Показываем видео элементы для видео звонков
      if (callManager.currentCall?.type === "video") {
        if (remoteVideo) remoteVideo.style.display = "block";
        if (localVideo) localVideo.style.display = "block";
        const callInfoPanel = document.getElementById("callInfoPanel");
        if (callInfoPanel) callInfoPanel.style.display = "none";
      }
    };

    // Модалка "звоним" для инициатора
    callManager.showCallingUI = () => {
      const overlay = document.getElementById("activeCallOverlay");
      const callInfoPanel = document.getElementById("callInfoPanel");
      const activeCallAvatar = document.getElementById("activeCallAvatar");
      const activeCallName = document.getElementById("activeCallName");
      const callTimer = document.getElementById("callTimer");
      const endCallBtn = document.getElementById("endCallBtn");

      // Показываем локальное видео/аудио
      const localVideo = document.getElementById("localVideo");
      if (localVideo && callManager.localStream) {
        localVideo.srcObject = callManager.localStream;
      }

      // Получаем информацию о собеседнике
      if (callManager.currentCall) {
        const chatBtn = document.querySelector(
            `.chat-list-item-btn[data-chat-id="${callManager.currentCall.chat_id}"]`
        );
        if (chatBtn) {
          const chatName = chatBtn.dataset.chatName || "Пользователь";
          const chatAvatar =
              chatBtn.querySelector("img")?.src || generateAvatar(chatName, callManager.currentCall.chat_id);
          if (activeCallAvatar)
            activeCallAvatar.querySelector("img").src = chatAvatar;
          if (activeCallName) activeCallName.textContent = chatName;
        }
      }

      // Показываем панель информации
      if (callInfoPanel) {
        callInfoPanel.style.display = "flex";
      }

      // Показываем статус "звоним..."
      if (callTimer) {
        callTimer.textContent = "Звоним...";
        callTimer.style.fontSize = "18px";
      }

      // Скрываем кнопку камеры для аудио звонков
      const toggleCameraBtn = document.getElementById("toggleCameraBtn");
      if (toggleCameraBtn) {
        toggleCameraBtn.style.display =
            callManager.currentCall?.type === "video" ? "block" : "none";
      }

      // Показываем overlay
      if (overlay) overlay.classList.remove("hidden");

      // Воспроизводим гудок для инициатора
      playDialTone();
    };

    // Обработчики кнопок звонков
    const chatCallBtn = document.getElementById("chatCallBtn");
    const profileCallBtn = document.getElementById("profileCallBtn");
    const profileVideoCallBtn = document.getElementById("profileVideoCallBtn");
    const acceptCallBtn = document.getElementById("acceptCallBtn");
    const rejectCallBtn = document.getElementById("rejectCallBtn");
    const endCallBtn = document.getElementById("endCallBtn");
    const toggleMicBtn = document.getElementById("toggleMicBtn");
    const toggleCameraBtn = document.getElementById("toggleCameraBtn");

    if (chatCallBtn) {
      chatCallBtn.addEventListener("click", () => {
        if (activeChatId) {
          // Запрещаем звонки ботам
          if (window.CURRENT_CHAT_DATA?.is_bot) {
            // Можно добавить визуальное уведомление, но пока просто блокируем
            console.warn("Звонки ботам недоступны");
            return;
          }

          // Проверяем, является ли чат группой
          if (
              currentChatIsGroup ||
              window.CURRENT_CHAT_DATA?.is_group === true ||
              window.CURRENT_CHAT_DATA?.chat_type === "group"
          ) {
            // Для групп создаем аудио-чат
            callManager.createAudioChat(activeChatId);
          } else {
            // Для приватных чатов - обычный звонок
            callManager.initiateCall(activeChatId, "audio");
          }
        }
      });
    }

    /*
    // Old handler removed to avoid conflict
    if (profileCallBtn) {
      profileCallBtn.addEventListener("click", () => {
        // Получаем chat_id из профиля
        const profileEmail = profileSection?.dataset?.userEmail;
        if (profileEmail) {
          // Находим чат с этим пользователем
          const chatBtn = Array.from(
            document.querySelectorAll(".chat-list-item-btn")
          ).find((btn) => btn.dataset.interlocutorEmail === profileEmail);
          if (chatBtn) {
            callManager.initiateCall(chatBtn.dataset.chatId, "audio");
          }
        }
      });
    }
    */

    if (profileVideoCallBtn) {
      profileVideoCallBtn.addEventListener("click", () => {
        const profileEmail = profileSection?.dataset?.userEmail;
        if (profileEmail) {
          const chatBtn = Array.from(
              document.querySelectorAll(".chat-list-item-btn")
          ).find((btn) => btn.dataset.interlocutorEmail === profileEmail);
          if (chatBtn) {
            callManager.initiateCall(chatBtn.dataset.chatId, "video");
          }
        }
      });
    }

    if (acceptCallBtn) {
      acceptCallBtn.addEventListener("click", () => {
        if (callManager.currentCall) {
          stopRingtone();
          callManager.acceptCall(callManager.currentCall.call_id);
        }
      });
    }

    if (rejectCallBtn) {
      rejectCallBtn.addEventListener("click", () => {
        if (callManager.currentCall) {
          // Останавливаем все звуки
          if (typeof stopRingtone === "function") {
            stopRingtone();
          }
          if (typeof stopDialTone === "function") {
            stopDialTone();
          }
          callManager.rejectCall(callManager.currentCall.call_id);
        }
      });
    }

    if (endCallBtn) {
      endCallBtn.addEventListener("click", () => {
        // Останавливаем все звуки
        if (typeof stopRingtone === "function") {
          stopRingtone();
        }
        if (typeof stopDialTone === "function") {
          stopDialTone();
        }
        callManager.endCall();
      });
    }

    // Клик на индикатор активного звонка - показываем модалку
    const activeCallIndicator = document.getElementById("activeCallIndicator");
    if (activeCallIndicator) {
      activeCallIndicator.addEventListener("click", () => {
        if (callManager.currentCall) {
          callManager.showActiveCallUI();
        }
      });
    }

    if (toggleMicBtn) {
      toggleMicBtn.addEventListener("click", () => {
        callManager.toggleMedia("audio");
        // Обновляем иконку
        const icon = toggleMicBtn.querySelector("img");
        if (icon) {
          const tracks = callManager.localStream?.getAudioTracks();
          const isEnabled = tracks?.[0]?.enabled ?? true;
          icon.src = isEnabled
              ? "/images/microphone-02.svg"
              : "/images/microphone-02.svg"; // Можно добавить иконку выключенного микрофона
          toggleMicBtn.classList.toggle("disabled", !isEnabled);
        }
      });
    }

    if (toggleCameraBtn) {
      toggleCameraBtn.addEventListener("click", () => {
        callManager.toggleMedia("video");
        // Обновляем иконку
        const icon = toggleCameraBtn.querySelector("img");
        if (icon) {
          const tracks = callManager.localStream?.getVideoTracks();
          const isEnabled = tracks?.[0]?.enabled ?? true;
          icon.src = isEnabled ? "/images/video-on.svg" : "/images/video-on.svg"; // Можно добавить иконку выключенной камеры
          toggleCameraBtn.classList.toggle("disabled", !isEnabled);
        }
      });
    }

    // === ОБРАБОТЧИКИ АУДИО-ЧАТОВ ===
    const audioChatBanner = document.getElementById("audioChatBanner");
    const audioChatBannerJoinBtn = document.getElementById(
        "audioChatBannerJoinBtn"
    );
    const audioChatBannerCloseBtn = document.getElementById(
        "audioChatBannerCloseBtn"
    );
    const audioChatOverlay = document.getElementById("audioChatOverlay");
    const audioChatCloseBtn = document.getElementById("audioChatCloseBtn");
    const audioChatLeaveBtn = document.getElementById("audioChatLeaveBtn");
    const audioChatToggleMicBtn = document.getElementById(
        "audioChatToggleMicBtn"
    );
    const groupsChatCallBtn = document.getElementById("groupsChatCallBtn");

    // Кнопка создания аудио-чата в группе
    if (groupsChatCallBtn) {
      groupsChatCallBtn.addEventListener("click", () => {
        if (activeChatId && currentChatIsGroup) {
          callManager.createAudioChat(activeChatId);
        }
      });
    }

    // Кнопка присоединения к аудио-чату из баннера
    if (audioChatBannerJoinBtn) {
      audioChatBannerJoinBtn.addEventListener("click", () => {
        // КРИТИЧЕСКИ ВАЖНО: Используем pendingAudioChat если есть, иначе currentAudioChat
        // Это позволяет повторно присоединиться после выхода
        let audioRoomId = null;
        if (callManager.pendingAudioChat) {
          audioRoomId = callManager.pendingAudioChat.audio_room_id;
          callManager.pendingAudioChat = null;
        } else if (
            callManager.currentAudioChat &&
            callManager.currentAudioChat.audio_room_id
        ) {
          audioRoomId = callManager.currentAudioChat.audio_room_id;
        }

        if (audioRoomId) {
          console.log("[AudioChat] Joining audio chat via button:", audioRoomId);
          callManager.joinAudioChat(audioRoomId);
        } else {
          console.warn("[AudioChat] No audio room ID available for joining");
        }
      });
    }

    // Кнопка закрытия баннера
    if (audioChatBannerCloseBtn) {
      audioChatBannerCloseBtn.addEventListener("click", () => {
        callManager.hideAudioChatBanner();
        callManager.pendingAudioChat = null;
      });
    }

    // Кнопка выхода из аудио-чата
    if (audioChatLeaveBtn) {
      audioChatLeaveBtn.addEventListener("click", () => {
        callManager.leaveAudioChat();
      });
    }

    // Кнопка закрытия окна аудио-чата
    if (audioChatCloseBtn) {
      audioChatCloseBtn.addEventListener("click", () => {
        callManager.leaveAudioChat();
      });
    }

    // Кнопка переключения микрофона
    if (audioChatToggleMicBtn) {
      audioChatToggleMicBtn.addEventListener("click", () => {
        callManager.toggleAudioChatMic();
        const icon = audioChatToggleMicBtn.querySelector("img");
        if (icon && callManager.localStream) {
          const tracks = callManager.localStream.getAudioTracks();
          const isEnabled = tracks?.[0]?.enabled ?? true;
          audioChatToggleMicBtn.classList.toggle("muted", !isEnabled);
        }
      });
    }

    // Реализация UI функций для аудио-чатов
    callManager.showAudioChatBanner = (data) => {
      // Показываем баннер только если это текущий открытый чат
      if (!activeChatId || activeChatId !== data.chat_id) {
        console.log(
            `[AudioChat] Not showing banner - activeChatId: ${activeChatId}, chat_id: ${data.chat_id}`
        );
        return;
      }

      callManager.pendingAudioChat = data;
      if (audioChatBanner) {
        const title = document.getElementById("audioChatBannerTitle");
        const subtitle = document.getElementById("audioChatBannerSubtitle");
        const avatar = document.getElementById("audioChatBannerAvatar");

        if (title) title.textContent = "Аудио-чат";
        const participantCount =
            (data.participants && data.participants.length) || 0;
        if (subtitle) {
          if (participantCount > 0) {
            subtitle.textContent = `${
                data.creator_name || "Кто-то"
            } создал(а) аудио-чат • ${participantCount} ${
                participantCount === 1
                    ? "участник"
                    : participantCount < 5
                        ? "участника"
                        : "участников"
            }`;
          } else {
            subtitle.textContent = `${
                data.creator_name || "Кто-то"
            } создал(а) аудио-чат`;
          }
        }

// Устанавливаем аватарку создателя
        if (avatar && data.creator_avatar) {
          avatar.src = data.creator_avatar;
          avatar.onerror = function () {
            this.src = generateAvatar(data.creator_name || "?", data.creator_email || "?");
          };
        } else if (avatar) {
          avatar.src = generateAvatar(data.creator_name || "?", data.creator_email || "?");
        }

        audioChatBanner.classList.remove("hidden");
      }
    };

    callManager.hideAudioChatBanner = () => {
      if (audioChatBanner) {
        audioChatBanner.classList.add("hidden");
      }
    };

    callManager.showAudioChatUI = () => {
      if (audioChatOverlay) {
        audioChatOverlay.classList.remove("hidden");
        callManager.updateAudioChatParticipants();
      }
      // Скрываем кнопку подключения к аудио-чату
      callManager.updateAudioChatButtonVisibility();
    };

    callManager.hideAudioChatUI = () => {
      if (audioChatOverlay) {
        audioChatOverlay.classList.add("hidden");
      }
      // Показываем кнопку подключения к аудио-чату
      callManager.updateAudioChatButtonVisibility();
    };

    // Функция для обновления видимости кнопки подключения к аудио-чату
    callManager.updateAudioChatButtonVisibility = () => {
      const groupsChatCallBtn = document.getElementById("groupsChatCallBtn");
      if (!groupsChatCallBtn) return;

      // Проверяем, есть ли активный аудио-чат для текущего чата
      // КРИТИЧЕСКИ ВАЖНО: Проверяем не только chat_id, но и наличие соединений
      // Если пользователь вышел, соединения очищены, но currentAudioChat может остаться
      const hasActiveAudioChat =
          callManager.currentAudioChat &&
          callManager.currentAudioChat.chat_id === activeChatId &&
          callManager.audioChatPeerConnections.size > 0; // Есть активные соединения
      const hasPendingAudioChat =
          callManager.pendingAudioChat &&
          callManager.pendingAudioChat.chat_id === activeChatId;

      // КРИТИЧЕСКИ ВАЖНО: Если есть currentAudioChat или pendingAudioChat для текущего чата,
      // но нет активных соединений и нет pending чата, значит чат завершен - скрываем кнопку
      const hasEndedAudioChat =
          (callManager.currentAudioChat &&
              callManager.currentAudioChat.chat_id === activeChatId &&
              callManager.audioChatPeerConnections.size === 0 &&
              !hasPendingAudioChat) ||
          (callManager.pendingAudioChat &&
              callManager.pendingAudioChat.chat_id === activeChatId &&
              !hasActiveAudioChat);

      // Скрываем кнопку если есть активный, ожидающий или завершенный аудио-чат
      if (hasActiveAudioChat || hasPendingAudioChat || hasEndedAudioChat) {
        groupsChatCallBtn.style.display = "none";
        groupsChatCallBtn.classList.add("hidden");
      } else {
        // Показываем кнопку только для групп
        if (currentChatIsGroup && activeChatId) {
          groupsChatCallBtn.style.display = "";
          groupsChatCallBtn.classList.remove("hidden");
        }
      }
    };

    callManager.updateAudioChatParticipants = () => {
      const participantsContainer = document.getElementById(
          "audioChatParticipants"
      );
      if (!participantsContainer || !callManager.currentAudioChat) return;

      const currentUserEmailLower = currentUserEmail.toLowerCase();
      const participants = callManager.currentAudioChat.participants || [];

      // Обновляем заголовок с количеством участников
      const audioChatTitle = document.querySelector(".audio-chat-title");
      if (audioChatTitle) {
        const participantCount = participants.length;
        audioChatTitle.textContent = `Аудио-чат (${participantCount} ${
            participantCount === 1
                ? "участник"
                : participantCount < 5
                    ? "участника"
                    : "участников"
        })`;
      }
      // Нормализуем email участников к нижнему регистру для сравнения
      const normalizedParticipants = participants.map((p) => p.toLowerCase());

      const existingParticipants = new Set(
          Array.from(
              participantsContainer.querySelectorAll(".audio-chat-participant")
          ).map((el) => el.dataset.email?.toLowerCase())
      );

      // Удаляем участников, которых больше нет
      participantsContainer
          .querySelectorAll(".audio-chat-participant")
          .forEach((participantDiv) => {
            const participantEmailLower = (
                participantDiv.dataset.email || ""
            ).toLowerCase();
            if (!normalizedParticipants.includes(participantEmailLower)) {
              const audioEl = participantDiv.querySelector("audio");
              if (audioEl) {
                audioEl.pause();
                audioEl.srcObject = null;
              }
              participantDiv.remove();
            }
          });

      // Добавляем новых участников
      participants.forEach((participantEmail) => {
        const participantEmailLower = participantEmail.toLowerCase();
        if (!existingParticipants.has(participantEmailLower)) {
          const participantDiv = document.createElement("div");
          participantDiv.className = "audio-chat-participant";
          participantDiv.dataset.email = participantEmailLower;

          // Получаем имя и аватар участника
          let participantName =
              participantEmail === currentUserEmailLower
                  ? "Вы"
                  : participantEmail.split("@")[0];
          let participantAvatar = generateAvatar(participantName, participantEmail);

          // Сначала проверяем сохраненные данные участников
          if (
              callManager.audioChatParticipantsData &&
              callManager.audioChatParticipantsData.has(
                  participantEmail.toLowerCase()
              )
          ) {
            const participantData = callManager.audioChatParticipantsData.get(
                participantEmail.toLowerCase()
            );
            participantName = participantData.name || participantName;
            participantAvatar = participantData.avatar || participantAvatar;
          } else {
            // Если данных нет, пытаемся получить из контактов
            try {
              const contactsMap = window.CONTACTS_BY_EMAIL || {};
              if (contactsMap[participantEmail]) {
                const contactInfo = contactsMap[participantEmail];
                participantName =
                    contactInfo.contact_name ||
                    contactInfo.display_name ||
                    contactInfo.full_name ||
                    contactInfo.username ||
                    participantName;
                if (contactInfo.avatar) {
                  participantAvatar = contactInfo.avatar;
                } else if (contactInfo.profile_picture) {
                  participantAvatar = contactInfo.profile_picture;
                }
              } else if (participantEmail !== currentUserEmailLower) {
                // Если нет в контактах, запрашиваем через API
                fetch(
                    `/api/user_profile?email=${encodeURIComponent(
                        participantEmail
                    )}`
                )
                    .then((response) => (response.ok ? response.json() : null))
                    .then((userData) => {
                      if (userData) {
                        if (!callManager.audioChatParticipantsData) {
                          callManager.audioChatParticipantsData = new Map();
                        }
                        callManager.audioChatParticipantsData.set(
                            participantEmail.toLowerCase(),
                            {
                              name:
                                  userData.full_name ||
                                  userData.username ||
                                  participantEmail.split("@")[0],
                              avatar: userData.profile_picture || generateAvatar(userData.full_name || userData.username || participantEmail.split("@")[0], participantEmail),
                            }
                        );
                        // Обновляем аватар и имя
                        const avatarImg = participantDiv.querySelector(
                            ".audio-chat-participant-avatar img"
                        );
                        const nameEl = participantDiv.querySelector(
                            ".audio-chat-participant-name"
                        );
                        if (avatarImg) {
                          avatarImg.src =
                              userData.profile_picture || generateAvatar(userData.full_name || userData.username || participantEmail, participantEmail);
                        }
                        if (nameEl) {
                          nameEl.textContent =
                              userData.full_name ||
                              userData.username ||
                              participantEmail.split("@")[0];
                        }
                      }
                    })
                    .catch((e) =>
                        console.warn("[AudioChat] Error fetching user data:", e)
                    );
              }
            } catch (e) {
              console.warn("[AudioChat] Error getting contact info:", e);
            }
          }

          participantDiv.innerHTML = `
          <div class="audio-chat-participant-avatar">
            <img src="${participantAvatar}" alt="${participantName}" onerror="this.onerror=null;this.src='${generateAvatar(participantName, participantEmail)}'" />
          </div>
          <div class="audio-chat-participant-name">${participantName}</div>
          <audio autoplay playsinline data-participant="${participantEmail}" style="display: none;"></audio>
        `;

          participantsContainer.appendChild(participantDiv);
        }
      });
    };

    // audioChatAnalyserContext и audioChatAnalysers объявлены в глобальной области видимости выше

    callManager.onAudioChatRemoteStreamReceived = (stream, participantEmail) => {
      const participantEmailLower = participantEmail.toLowerCase();
      console.log(
          `[AudioChat] ===== REMOTE STREAM RECEIVED from ${participantEmailLower} =====`
      );
      console.log(
          `[AudioChat] Stream:`,
          stream,
          "tracks:",
          stream.getTracks().length
      );

      // КРИТИЧЕСКИ ВАЖНО: Проверяем наличие треков
      const allTracks = stream.getTracks();
      if (allTracks.length === 0) {
        console.error(
            `[AudioChat] Stream from ${participantEmailLower} has NO TRACKS!`
        );
        return;
      }

      const audioTracks = stream.getAudioTracks();
      console.log(
          `[AudioChat] Audio tracks: ${audioTracks.length}, Total tracks: ${allTracks.length}`
      );

      // КРИТИЧЕСКИ ВАЖНО: Включаем все треки ДО поиска элемента
      allTracks.forEach((track) => {
        track.enabled = true;
        // Примечание: track.muted - это только геттер, его нельзя установить
        console.log(`[AudioChat] Track enabled:`, {
          id: track.id,
          kind: track.kind,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        });
      });

      // Ищем participantDiv по email (пробуем оба варианта для совместимости)
      let participantDiv = document.querySelector(
          `.audio-chat-participant[data-email="${participantEmailLower}"]`
      );
      if (!participantDiv) {
        participantDiv = document.querySelector(
            `.audio-chat-participant[data-email="${participantEmail}"]`
        );
      }

      // Если элемента нет, создаем его
      if (!participantDiv) {
        console.warn(
            `[AudioChat] Participant div not found for ${participantEmailLower}, creating...`
        );
        const participantsContainer = document.getElementById(
            "audioChatParticipants"
        );
        if (participantsContainer) {
          participantDiv = document.createElement("div");
          participantDiv.className = "audio-chat-participant";
          participantDiv.dataset.email = participantEmailLower;
          participantDiv.innerHTML = `
          <div class="audio-chat-participant-avatar">
            <img src="${generateAvatar(participantEmailLower, participantEmailLower)}" alt="Participant" />
          </div>
          <div class="audio-chat-participant-name">${participantEmailLower}</div>
        `;
          participantsContainer.appendChild(participantDiv);
        } else {
          console.error(`[AudioChat] Participants container not found!`);
          return;
        }
      }

      if (participantDiv) {
        let audioEl = participantDiv.querySelector("audio");
        if (!audioEl) {
          // Создаем audio элемент если его нет
          console.log(
              `[AudioChat] Creating audio element for ${participantEmailLower}`
          );
          audioEl = document.createElement("audio");
          audioEl.autoplay = true;
          audioEl.playsInline = true;
          audioEl.volume = 1.0;
          audioEl.muted = false;
          audioEl.style.display = "none";
          audioEl.dataset.participant = participantEmailLower;
          participantDiv.appendChild(audioEl);
        }

        // Останавливаем старый поток если есть
        if (audioEl.srcObject) {
          const oldStream = audioEl.srcObject;
          console.log(
              `[AudioChat] Stopping old stream from ${participantEmailLower}`
          );
          oldStream.getTracks().forEach((track) => {
            track.stop();
            track.enabled = false;
          });
        }

        // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что все треки включены перед установкой
        stream.getTracks().forEach((track) => {
          track.enabled = true;
          // Примечание: track.muted - это только геттер, его нельзя установить
          console.log(`[AudioChat] Final track check:`, {
            id: track.id,
            kind: track.kind,
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
          });
        });

        // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что все треки включены ПЕРЕД установкой srcObject
        stream.getTracks().forEach((track) => {
          track.enabled = true;
          // Примечание: track.muted - это только геттер, его нельзя установить
          console.log(`[AudioChat] Track before setting srcObject:`, {
            id: track.id,
            kind: track.kind,
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
          });
        });

        // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что поток активен перед установкой
        if (!stream.active) {
          console.warn(
              `[AudioChat] Stream from ${participantEmailLower} is not active, waiting for activation...`
          );
          const waitForActive = setInterval(() => {
            if (stream.active) {
              clearInterval(waitForActive);
              console.log(
                  `[AudioChat] Stream from ${participantEmailLower} is now active, setting srcObject`
              );
              callManager.setupAudioElement(
                  audioEl,
                  stream,
                  participantEmailLower
              );
            }
          }, 100);

          setTimeout(() => {
            clearInterval(waitForActive);
            if (!stream.active) {
              console.warn(
                  `[AudioChat] Stream from ${participantEmailLower} still not active, setting srcObject anyway`
              );
            }
            callManager.setupAudioElement(audioEl, stream, participantEmailLower);
          }, 2000);
        } else {
          callManager.setupAudioElement(audioEl, stream, participantEmailLower);
        }
      } else {
        console.error(
            `[AudioChat] Participant div not found for ${participantEmailLower}`
        );
      }
    };

    // КРИТИЧЕСКИ ВАЖНО: Вынесенная функция для настройки audio элемента
    callManager.setupAudioElement = (audioEl, stream, participantEmailLower) => {
      console.log(
          `[AudioChat] ===== SETUP AUDIO ELEMENT for ${participantEmailLower} =====`
      );

      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что все треки включены перед установкой
      const tracks = stream.getTracks();
      console.log(`[AudioChat] Stream has ${tracks.length} tracks`);

      tracks.forEach((track) => {
        track.enabled = true;
        // Примечание: track.muted - это только геттер, его нельзя установить
        console.log(`[AudioChat] Track before setup:`, {
          id: track.id,
          kind: track.kind,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        });
      });

      // Устанавливаем поток
      console.log(`[AudioChat] Setting srcObject for ${participantEmailLower}`);
      audioEl.srcObject = stream;

      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что элемент не приглушен
      audioEl.muted = false;
      audioEl.volume = 1.0;

      // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что треки все еще включены после установки srcObject
      setTimeout(() => {
        if (audioEl.srcObject) {
          const tracksAfter = audioEl.srcObject.getTracks();
          console.log(
              `[AudioChat] Tracks after setting srcObject: ${tracksAfter.length}`
          );
          tracksAfter.forEach((track) => {
            track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
            console.log(`[AudioChat] Track after srcObject:`, {
              id: track.id,
              kind: track.kind,
              enabled: track.enabled,
              muted: track.muted,
              readyState: track.readyState,
            });
          });
        }
      }, 100);

      // Убеждаемся, что элемент готов к воспроизведению
      audioEl.load();

      // Устанавливаем обработчики событий для отслеживания
      audioEl.addEventListener(
          "loadedmetadata",
          () => {
            console.log(`[AudioChat] Metadata loaded for ${participantEmailLower}`);
            console.log(`[AudioChat] Audio element ready:`, {
              readyState: audioEl.readyState,
              paused: audioEl.paused,
              muted: audioEl.muted,
              volume: audioEl.volume,
              srcObject: !!audioEl.srcObject,
              tracks: audioEl.srcObject ? audioEl.srcObject.getTracks().length : 0,
            });

            // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что треки включены после загрузки метаданных
            if (audioEl.srcObject) {
              audioEl.srcObject.getTracks().forEach((track) => {
                track.enabled = true;
                // Примечание: track.muted - это только геттер, его нельзя установить
              });
            }
          },
          {once: true}
      );

      audioEl.addEventListener(
          "canplay",
          () => {
            console.log(`[AudioChat] Can play for ${participantEmailLower}`);
            // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что треки включены
            if (audioEl.srcObject) {
              audioEl.srcObject.getTracks().forEach((track) => {
                track.enabled = true;
                // Примечание: track.muted - это только геттер, его нельзя установить
              });
            }
          },
          {once: true}
      );

      audioEl.addEventListener("play", () => {
        console.log(
            `[AudioChat] ✅ Audio started playing for ${participantEmailLower}`
        );
        // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что треки включены при воспроизведении
        if (audioEl.srcObject) {
          audioEl.srcObject.getTracks().forEach((track) => {
            track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
          });
        }
      });

      audioEl.addEventListener("pause", () => {
        console.warn(`[AudioChat] Audio paused for ${participantEmailLower}`);
      });

      audioEl.addEventListener("error", (e) => {
        console.error(`[AudioChat] Audio error for ${participantEmailLower}:`, e);
        // КРИТИЧЕСКИ ВАЖНО: При ошибке пытаемся перезапустить
        if (audioEl.srcObject) {
          audioEl.srcObject.getTracks().forEach((track) => {
            track.enabled = true;
            // Примечание: track.muted - это только геттер, его нельзя установить
          });
        }
      });

      // КРИТИЧЕСКИ ВАЖНО: Агрессивное воспроизведение аудио
      let playAttempts = 0;
      const maxPlayAttempts = 30; // Увеличено количество попыток

      const playAudio = () => {
        if (!audioEl || !audioEl.srcObject) {
          console.warn(`[AudioChat] No srcObject for ${participantEmailLower}`);
          if (playAttempts < maxPlayAttempts) {
            playAttempts++;
            setTimeout(playAudio, 200);
          }
          return;
        }

        // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что все треки включены
        const tracks = audioEl.srcObject ? audioEl.srcObject.getTracks() : [];

        if (tracks.length === 0) {
          console.warn(
              `[AudioChat] No tracks in srcObject for ${participantEmailLower}`
          );
          if (playAttempts < maxPlayAttempts) {
            playAttempts++;
            setTimeout(playAudio, 200);
          }
          return;
        }

        // КРИТИЧЕСКИ ВАЖНО: Включаем все треки
        tracks.forEach((track) => {
          track.enabled = true;
          // Примечание: track.muted - это только геттер, его нельзя установить
          console.log(`[AudioChat] Track in playAudio:`, {
            id: track.id,
            kind: track.kind,
            enabled: track.enabled,
            muted: track.muted,
            readyState: track.readyState,
          });
        });

        const activeTracks = tracks.filter(
            (t) => t.readyState === "live" && t.enabled
        );

        console.log(
            `[AudioChat] Play attempt ${
                playAttempts + 1
            }/${maxPlayAttempts} for ${participantEmailLower}:`,
            {
              totalTracks: tracks.length,
              activeTracks: activeTracks.length,
              readyState: audioEl.readyState,
              paused: audioEl.paused,
              muted: audioEl.muted,
              volume: audioEl.volume,
            }
        );

        // КРИТИЧЕСКИ ВАЖНО: Убеждаемся, что элемент не приглушен
        audioEl.muted = false;
        audioEl.volume = 1.0;

        if (activeTracks.length === 0) {
          console.warn(
              `[AudioChat] No active tracks for ${participantEmailLower}, attempting to recover...`
          );

          // КРИТИЧЕСКИ ВАЖНО: Пытаемся восстановить поток из receivers
          if (callManager && callManager.recoverStreamFromReceivers) {
            callManager.recoverStreamFromReceivers(participantEmailLower);
          }

          if (playAttempts < maxPlayAttempts) {
            playAttempts++;
            setTimeout(playAudio, 500); // Увеличена задержка для восстановления
          } else {
            console.error(
                `[AudioChat] Failed to recover tracks for ${participantEmailLower} after ${maxPlayAttempts} attempts`
            );
          }
          return;
        }

        // КРИТИЧЕСКИ ВАЖНО: Пытаемся воспроизвести всегда
        // Убеждаемся, что элемент не приглушен перед воспроизведением
        audioEl.muted = false;
        audioEl.volume = 1.0;

        // Убеждаемся, что треки включены перед воспроизведением
        tracks.forEach((track) => {
          track.enabled = true;
          // Примечание: track.muted - это только геттер, его нельзя установить
        });

        const playPromise = audioEl.play();
        if (playPromise !== undefined) {
          playPromise
              .then(() => {
                console.log(
                    `[AudioChat] ✅ Audio playing successfully for ${participantEmailLower}`
                );

                // КРИТИЧЕСКИ ВАЖНО: Проверяем, что треки все еще включены после play
                if (audioEl.srcObject) {
                  audioEl.srcObject.getTracks().forEach((track) => {
                    track.enabled = true;
                    // Примечание: track.muted - это только геттер, его нельзя установить
                  });
                }

                // Проверяем что аудио действительно воспроизводится
                if (audioEl.paused) {
                  console.warn(
                      `[AudioChat] Audio element is paused for ${participantEmailLower}, forcing play...`
                  );
                  audioEl.muted = false;
                  audioEl.volume = 1.0;
                  if (playAttempts < maxPlayAttempts) {
                    playAttempts++;
                    setTimeout(playAudio, 100);
                  }
                } else {
                  console.log(
                      `[AudioChat] ✅✅✅ Audio is NOW PLAYING for ${participantEmailLower} ✅✅✅`
                  );

                  // КРИТИЧЕСКИ ВАЖНО: Устанавливаем периодическую проверку треков
                  // Проверяем каждые 2 секунды, не завершились ли треки
                  const checkInterval = setInterval(() => {
                    if (!audioEl || !audioEl.srcObject) {
                      clearInterval(checkInterval);
                      return;
                    }

                    const currentTracks = audioEl.srcObject.getTracks();
                    const endedTracks = currentTracks.filter(
                        (t) => t.readyState === "ended"
                    );

                    if (
                        endedTracks.length > 0 &&
                        endedTracks.length === currentTracks.length
                    ) {
                      console.warn(
                          `[AudioChat] All tracks ended for ${participantEmailLower}, attempting to recover...`
                      );
                      clearInterval(checkInterval);
                      if (callManager && callManager.recoverStreamFromReceivers) {
                        callManager.recoverStreamFromReceivers(
                            participantEmailLower
                        );
                      }
                    } else if (endedTracks.length > 0) {
                      console.warn(
                          `[AudioChat] Some tracks ended for ${participantEmailLower} (${endedTracks.length}/${currentTracks.length}), attempting to recover...`
                      );
                      if (callManager && callManager.recoverStreamFromReceivers) {
                        callManager.recoverStreamFromReceivers(
                            participantEmailLower
                        );
                      }
                    }
                  }, 2000);
                  console.log(`[AudioChat] Audio element state:`, {
                    paused: audioEl.paused,
                    muted: audioEl.muted,
                    volume: audioEl.volume,
                    readyState: audioEl.readyState,
                    srcObject: !!audioEl.srcObject,
                    tracks: audioEl.srcObject
                        ? audioEl.srcObject.getTracks().length
                        : 0,
                  });
                }
              })
              .catch((err) => {
                console.warn(
                    `[AudioChat] Error playing audio for ${participantEmailLower}, attempt ${
                        playAttempts + 1
                    }/${maxPlayAttempts}:`,
                    err
                );
                // Убеждаемся, что треки включены
                if (audioEl.srcObject) {
                  audioEl.srcObject.getTracks().forEach((track) => {
                    track.enabled = true;
                    // Примечание: track.muted - это только геттер, его нельзя установить
                  });
                }
                audioEl.muted = false;
                audioEl.volume = 1.0;
                if (playAttempts < maxPlayAttempts) {
                  playAttempts++;
                  setTimeout(playAudio, 200);
                } else {
                  console.error(
                      `[AudioChat] ❌ Failed to play audio for ${participantEmailLower} after ${maxPlayAttempts} attempts`
                  );
                }
              });
        } else {
          // Если play() не вернул promise, пробуем еще раз
          if (audioEl.paused) {
            if (playAttempts < maxPlayAttempts) {
              playAttempts++;
              setTimeout(playAudio, 200);
            }
          } else {
            console.log(
                `[AudioChat] Audio already playing for ${participantEmailLower}`
            );
          }
        }
      };

      // КРИТИЧЕСКИ ВАЖНО: Пробуем воспроизвести сразу несколько раз с разными задержками
      // Это гарантирует, что звук начнет воспроизводиться даже если есть задержки
      const playDelays = [50, 150, 300, 500, 1000, 2000];
      playDelays.forEach((delay, index) => {
        setTimeout(() => {
          console.log(
              `[AudioChat] Play attempt ${
                  index + 1
              } for ${participantEmailLower} (delay: ${delay}ms)`
          );
          playAudio();
        }, delay);
      });

      // Также пробуем после загрузки метаданных
      audioEl.addEventListener(
          "loadedmetadata",
          () => {
            console.log(
                `[AudioChat] Metadata loaded for ${participantEmailLower}, playing...`
            );
            playAudio();
          },
          {once: true}
      );

      // Также пробуем после canplay
      audioEl.addEventListener(
          "canplay",
          () => {
            console.log(
                `[AudioChat] Can play for ${participantEmailLower}, playing...`
            );
            playAudio();
          },
          {once: true}
      );

      // Пробуем после canplaythrough
      audioEl.addEventListener(
          "canplaythrough",
          () => {
            console.log(
                `[AudioChat] Can play through for ${participantEmailLower}, playing...`
            );
            playAudio();
          },
          {once: true}
      );

      // Пробуем после playing
      audioEl.addEventListener("playing", () => {
        console.log(
            `[AudioChat] ✅✅✅ PLAYING event for ${participantEmailLower} ✅✅✅`
        );
      });
    };

    // Создаем анализатор для определения, говорит ли участник (вынесено из setupAudioElement)
    callManager.setupAudioAnalyser = (
        stream,
        participantDiv,
        participantEmail
    ) => {
      try {
        if (!audioChatAnalyserContext) {
          audioChatAnalyserContext = new (window.AudioContext ||
              window.webkitAudioContext)();
        }

        const analyser = audioChatAnalyserContext.createAnalyser();
        const source = audioChatAnalyserContext.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        audioChatAnalysers.set(participantEmail, analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const checkSpeaking = () => {
          if (!participantDiv.parentElement) {
            audioChatAnalysers.delete(participantEmail);
            return;
          }

          analyser.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;

          if (average > 15) {
            participantDiv.classList.add("speaking");
          } else {
            participantDiv.classList.remove("speaking");
          }

          requestAnimationFrame(checkSpeaking);
        };
        checkSpeaking();
      } catch (err) {
        console.warn("[AudioChat] Could not create audio analyser:", err);
      }
    };

    // Добавляем вызов анализатора в onAudioChatRemoteStreamReceived
    const originalOnAudioChatRemoteStreamReceived =
        callManager.onAudioChatRemoteStreamReceived;
    callManager.onAudioChatRemoteStreamReceived = function (
        stream,
        participantEmail
    ) {
      const participantEmailLower = participantEmail.toLowerCase();

      // Вызываем оригинальную функцию
      originalOnAudioChatRemoteStreamReceived.call(
          this,
          stream,
          participantEmail
      );

      // Создаем анализатор после настройки audio элемента
      setTimeout(() => {
        const participantDiv = document.querySelector(
            `.audio-chat-participant[data-email="${participantEmailLower}"]`
        );
        if (participantDiv && stream) {
          callManager.setupAudioAnalyser(
              stream,
              participantDiv,
              participantEmailLower
          );
        }
      }, 500);
    };
  }

// Таймер звонка
  let callTimerInterval = null;
  let callStartTime = null;

  function startCallTimer() {
    callStartTime = Date.now();
    callTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      const timerEl = document.getElementById("callTimer");
      if (timerEl) {
        timerEl.textContent = `${String(minutes).padStart(2, "0")}:${String(
            seconds
        ).padStart(2, "0")}`;
      }
    }, 1000);
  }

  function stopCallTimer() {
    if (callTimerInterval) {
      clearInterval(callTimerInterval);
      callTimerInterval = null;
    }
    callStartTime = null;
    const timerEl = document.getElementById("callTimer");
    if (timerEl) timerEl.textContent = "00:00";
  }

// (Revert) Удалена логика свайпов/оверлея для выезжающего .sidebar

// ===================================
// === МОБИЛЬНАЯ АДАПТАЦИЯ (SIDEBAR) ===
// ===================================

  document.addEventListener("DOMContentLoaded", () => {

    const mobileMenuBtn = document.getElementById("mobileMenuBtn");
    const sidebar = document.querySelector(".sidebar");
    const sidebarOverlay = document.getElementById("sidebarOverlay");
    const navButtons = document.querySelectorAll(".nav-button");

    // Define functions
    function toggleSidebar() {
      if (sidebar) {
        const isActive = sidebar.classList.toggle("active");
        if (sidebarOverlay) {
          sidebarOverlay.classList.toggle("active", isActive);
          if (isActive) {
            sidebarOverlay.classList.remove("hidden");
            document.body.style.overflow = "hidden";
          } else {
            document.body.style.overflow = "";
            setTimeout(() => {
              if (!sidebar.classList.contains("active")) {
                sidebarOverlay.classList.add("hidden");
              }
            }, 300);
          }
        }
      }
    }

    function closeSidebar() {
      if (sidebar) sidebar.classList.remove("active");
      if (sidebarOverlay) {
        sidebarOverlay.classList.remove("active");
        document.body.style.overflow = "";
        setTimeout(() => {
          if (!sidebar || !sidebar.classList.contains("active")) {
            sidebarOverlay.classList.add("hidden");
          }
        }, 300);
      }
    }

    // Expose to window
    window.toggleSidebar = toggleSidebar;
    window.closeSidebar = closeSidebar;

    // Bind Listeners
    // Note: mobileMenuBtn listener removed in favor of inline onclick="window.toggleSidebar()"
    // to prevent double-toggling and ensure consistency across all tabs.

    if (sidebarOverlay) {
      sidebarOverlay.addEventListener("click", closeSidebar);
    }

    if (navButtons) {
      navButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          if (window.innerWidth <= 900) closeSidebar();
        });
      });
    }

    // --- View Switching ---

    // Функция переключения в режим Чата
    window.switchToChatView = function () {
      document.body.classList.add("mobile-view-chat");
      console.log("[Mobile] Switched to Chat View");
    };

    // Функция переключения в режим Списка
    window.switchToListView = function () {
      document.body.classList.remove("mobile-view-chat");
      window.activeChatId = null;
      console.log("[Mobile] Switched to List View");
    };

    // Кнопка "Назад" обрабатывается в основном обработчике backToChatListBtn

    // Делегирование кликов на список чатов
    const chatListUlFn = document.getElementById("chatListUl");
    if (chatListUlFn) {
      chatListUlFn.addEventListener("click", (e) => {
        const btn = e.target.closest(".chat-list-item-btn");
        if (btn) {
          if (window.innerWidth <= 900) {
            window.switchToChatView();
          }
        }
      });
    }

    // Делегирование для поиска
    const searchResultsList = document.getElementById("messageSearchResultsList");
    if (searchResultsList) {
      searchResultsList.addEventListener("click", (e) => {
        const item = e.target.closest(".message-search-result");
        if (item && window.innerWidth <= 900) {
          window.switchToChatView();
        }
      });
    }

    // Initialize settings navigation (close buttons, panel switching)
    initSettingsNavigation();
  });

// ========================================================
// === ГЛОБАЛЬНАЯ ЛОГИКА ПРОЧТЕНИЯ СООБЩЕНИЙ ===
// ========================================================
  function markActiveChatAsRead() {
    if (activeChatId && ws && ws.readyState === WebSocket.OPEN && document.hasFocus()) {
      // Отправляем сигнал на сервер, что мы всё прочитали
      ws.send(JSON.stringify({type: "mark_as_read", chat_id: String(activeChatId)}));
      // Сбрасываем у себя на экране
      setUnreadCount(activeChatId, 0);
    }
  }

// 1. Читаем, когда возвращаемся на вкладку браузера
  window.addEventListener("focus", markActiveChatAsRead);

// 2. Читаем, когда кликаем куда-нибудь внутри чата
  if (chatWindow) {
    chatWindow.addEventListener("click", markActiveChatAsRead);
  }

// 3. Читаем при вводе текста или клике на поле ввода
  if (messageInput) {
    messageInput.addEventListener("focus", markActiveChatAsRead);
    messageInput.addEventListener("input", markActiveChatAsRead);
  }

// ========================================================
// === МГНОВЕННОЕ ОБНОВЛЕНИЕ ИМЕН ЧАТОВ ПРИ ДОБАВЛЕНИИ КОНТАКТА ===
// ========================================================
window.addEventListener('contactAdded', (e) => {
  const contact = e.detail;
  if (!contact || !contact.email) return;

  console.log("[Contacts] Мгновенное обновление UI для:", contact.email);

  if (!window.CONTACTS_BY_EMAIL) window.CONTACTS_BY_EMAIL = {};
  window.CONTACTS_BY_EMAIL[contact.email] = contact;

  // Ищем все чаты с этим email нечувствительно к регистру
  const allBtns = document.querySelectorAll(".chat-list-item-btn");
  allBtns.forEach(chatBtn => {
    const btnEmail = chatBtn.dataset.interlocutorEmail;

    if (btnEmail && btnEmail.toLowerCase() === contact.email.toLowerCase()) {
      // 1. Меняем имя в списке чатов
      const nameEl = chatBtn.querySelector('.chat-name');
      if (nameEl) nameEl.textContent = contact.display_name;

      chatBtn.dataset.contactDisplayName = contact.display_name;
      chatBtn.dataset.chatName = contact.display_name;

      // 2. Обновляем аватарку (только если стоит сгенерированная/дефолтная)
      const imgEl = chatBtn.querySelector('img');
      if (imgEl && isDefaultAvatar(imgEl.src)) {
         imgEl.src = generateAvatar(contact.display_name, contact.email);
      }

      // 3. Если этот чат СЕЙЧАС открыт, меняем заголовок прямо в шапке
      if (activeChatId && chatBtn.dataset.chatId === activeChatId) {
        const headerTitle = document.getElementById('currentChatTitle');
        const headerAvatar = document.getElementById('currentChatAvatar');

        if (headerTitle) headerTitle.textContent = contact.display_name;
        if (headerAvatar && imgEl) headerAvatar.src = imgEl.src;
      }
    }
  });
});