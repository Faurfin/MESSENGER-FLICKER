// ===========================
// === Groups Module ===
// ===========================

import { generateAvatar } from "./modules/avatar.js";

const API_BASE_URL = window.location.origin;

const groupsList = document.getElementById("groupsList");
const groupsEmpty = document.getElementById("groupsEmpty");
const openCreateGroupBtn = document.getElementById("openCreateGroupBtn");
const createGroupModal = document.getElementById("createGroupModal");
const createGroupForm = document.getElementById("createGroupForm");
const createGroupCloseBtn = document.getElementById("createGroupCloseBtn");
const cancelCreateGroup = document.getElementById("cancelCreateGroup");
const groupNameInput = document.getElementById("groupName");
const groupAvatarInput = document.getElementById("groupAvatarInput");
const groupAvatarPreview = document.getElementById("groupAvatarPreview");
const groupAvatarImg = document.getElementById("groupAvatarImg");
const groupAvatarChangeBtn = document.getElementById("groupAvatarChangeBtn");
const groupParticipantSearch = document.getElementById("groupParticipantSearch");
const groupParticipantsList = document.getElementById("groupParticipantsList");
const groupSelectedParticipants = document.getElementById("groupSelectedParticipants");
const createGroupError = document.getElementById("createGroupError");

// Проверяем, что основные элементы найдены
if (!groupsList) {
  console.error("groupsList element not found! Check HTML structure.");
}
if (!createGroupModal) {
  console.error("createGroupModal element not found! Check HTML structure.");
}

// Эти элементы больше не нужны, так как группы используют обычный chatWindow
// const groupsChatWindow = document.getElementById("groupsChatWindow");
// const groupsChatEmptyState = document.getElementById("groupsChatEmptyState");
// const groupsChatMessages = document.getElementById("groupsChatMessages");
// const groupsMessageForm = document.getElementById("groupsMessageForm");
// const groupsMessageInput = document.getElementById("groupsMessageInput");
// const groupsSendButton = document.getElementById("groupsSendButton");
// const groupsCurrentChatTitle = document.getElementById("groupsCurrentChatTitle");
// const groupsCurrentChatAvatar = document.getElementById("groupsCurrentChatAvatar");
// const backToGroupsListBtn = document.getElementById("backToGroupsListBtn");
// const groupsChatHeaderClickable = document.getElementById("groupsChatHeaderClickable");

// currentGroupChatId больше не нужен, используется window.activeChatId
// let currentGroupChatId = null;
let selectedParticipants = new Set();
let allContacts = [];
let currentGroupParticipants = new Set(); // Участники текущей группы (для исключения из поиска)

const toggleHidden = (el, hidden) => {
  if (!el) {
    console.warn("[toggleHidden] Элемент не найден!");
    return;
  }
  if (hidden) {
    el.classList.add("hidden");
    el.style.display = "none";
  } else {
    el.classList.remove("hidden");
    // Для модалок используем flex, для других элементов - block
    if (el.classList.contains("modal-backdrop")) {
      el.style.display = "flex";
    } else {
      el.style.display = "";
    }
  }
  console.log(`[toggleHidden] Элемент ${el.id || 'unknown'}: hidden=${hidden}, display=${el.style.display}, classes=${el.classList.toString()}`);
};

// Загрузка контактов для выбора участников
async function loadContactsForGroup() {
  try {
    const resp = await fetch(`${API_BASE_URL}/api/contacts`, {
      credentials: 'include'
    });
    if (!resp.ok) throw new Error("Не удалось загрузить контакты");
    const data = await resp.json();
    allContacts = data.contacts || [];
    return allContacts;
  } catch (err) {
    console.error("Ошибка загрузки контактов:", err);
    allContacts = [];
    return [];
  }
}

// Загрузка участников группы для исключения их из поиска (по chatId)
async function loadGroupParticipantsForFilter(chatId) {
  if (!chatId) {
    currentGroupParticipants.clear();
    return;
  }
  
  try {
    const resp = await fetch(`${API_BASE_URL}/api/chat/${chatId}`, {
      credentials: 'include'
    });
    if (!resp.ok) throw new Error("Не удалось загрузить данные группы");
    const data = await resp.json();
    const participants = data.participants || [];
    currentGroupParticipants = new Set(participants.map(p => p.toLowerCase()));
  } catch (err) {
    console.error("Ошибка загрузки участников группы:", err);
    currentGroupParticipants.clear();
  }
}

// Поиск пользователей через API (как в обычном поиске чатов)
let searchTimeout = null;
async function searchUsersForGroup(query) {
  const trimmedQuery = (query || "").trim();
  const queryForApi = trimmedQuery.replace(/^@+/, "").trim();

  if (trimmedQuery.length < 1 || queryForApi.length < 1) {
    // Если поле пустое или только "@", показываем контакты (если не в режиме добавления участников)
    if (window.addMemberGroupChatId) {
      const filteredContacts = allContacts.filter(c => !currentGroupParticipants.has(c.email.toLowerCase()));
      renderParticipantsList(filteredContacts, "");
    } else {
      renderParticipantsList(allContacts, "");
    }
    return;
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/api/users/search?query=${encodeURIComponent(queryForApi)}`,
      { credentials: 'include' }
    );
    if (!response.ok) {
      throw new Error("Ошибка поиска пользователей");
    }
    const data = await response.json();
    const users = Array.isArray(data) ? data : data.users || [];
    
    // Преобразуем формат пользователей в формат для отображения
    const formattedUsers = users.map(user => ({
      email: user.email,
      display_name: user.full_name || user.username || user.email,
      full_name: user.full_name,
      username: user.username,
      profile_picture: user.profile_picture || generateAvatar(user.full_name || user.username || user.email, user.email)
    }));
    
    renderParticipantsList(formattedUsers, trimmedQuery);
  } catch (error) {
    console.error("Ошибка при поиске пользователей:", error);
    renderParticipantsList([], trimmedQuery);
  }
}

// Проверка валидности email
function isValidEmail(email) {
  // Relaxed validation: backend допускает "короткие" адреса вида i@i.
  // Нам важно лишь, чтобы это было похоже на email (1 '@', непустые части, без пробелов).
  if (typeof email !== "string") return false;
  const s = email.trim();
  if (!s || /\s/.test(s)) return false;
  const parts = s.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return Boolean(local) && Boolean(domain);
}

// Отображение списка пользователей для выбора
function renderParticipantsList(users = [], searchQuery = "") {
  if (!groupParticipantsList) return;
  groupParticipantsList.innerHTML = "";

  const query = (searchQuery || "").trim();
  const queryLower = query.toLowerCase();
  const queryNorm = queryLower.replace(/^@+/, "");

  let toShow = users;
  if (queryNorm) {
    toShow = users.filter(u => {
      const name = (u.display_name || u.full_name || u.username || u.email || "").toLowerCase();
      const un = (u.username || "").toLowerCase().replace(/^@+/, "");
      const email = (u.email || "").toLowerCase();
      return name.includes(queryNorm) || un.includes(queryNorm) || email.includes(queryNorm);
    });
  }

  // Фильтруем пользователей (исключаем уже выбранных и участников группы)
  const filtered = toShow.filter(u => {
    const emailLower = (u.email || "").toLowerCase();
    const alreadySelected = Array.from(selectedParticipants).some(
      email => email.toLowerCase() === emailLower
    );
    if (alreadySelected) return false;
    if (currentGroupParticipants.has(emailLower)) return false;
    return true;
  });

  // Если есть запрос и он похож на email, проверяем, можно ли добавить его напрямую
  const isEmailQuery = query && isValidEmail(query);
  const emailExistsInUsers = users.some(u => u.email.toLowerCase() === queryLower);
  const emailAlreadySelected = Array.from(selectedParticipants).some(
    e => (e || "").toLowerCase() === queryLower
  );
  
  // Показываем найденных пользователей
  if (filtered.length > 0) {
    filtered.forEach(user => {
      const item = document.createElement("div");
      item.className = "group-participant-item";
      const displayName = user.display_name || user.full_name || user.username || user.email;
      const u = (user.username || '').trim().replace(/^@+/, '');
      const usernameLine = u ? `<div class="group-participant-username">@${u}</div>` : '';
      item.innerHTML = `
        <div class="group-participant-checkbox">
          <input type="checkbox" id="participant-${user.email}" data-email="${user.email}" />
          <label for="participant-${user.email}"></label>
        </div>
        <img src="${(user.profile_picture && !user.profile_picture.includes("юзер.svg")) ? user.profile_picture : generateAvatar(displayName, user.email)}" alt="${displayName}" />
        <div class="group-participant-info">
          <div class="group-participant-name">${displayName}</div>
          ${usernameLine}
          <div class="group-participant-email">${user.email}</div>
        </div>
      `;

      const checkbox = item.querySelector('input[type="checkbox"]');
      checkbox.addEventListener("change", (e) => {
        if (e.target.checked) {
          selectedParticipants.add(user.email);
        } else {
          selectedParticipants.delete(user.email);
        }
        renderSelectedParticipants();
        // Перезапускаем поиск для обновления списка
        if (groupParticipantSearch && groupParticipantSearch.value.trim()) {
          searchUsersForGroup(groupParticipantSearch.value);
        } else {
          // Показываем контакты при пустом поле поиска
          if (window.addMemberGroupChatId) {
            const filteredContacts = allContacts.filter(c => !currentGroupParticipants.has(c.email.toLowerCase()));
            renderParticipantsList(filteredContacts, "");
          } else {
            renderParticipantsList(allContacts, "");
          }
        }
      });

      groupParticipantsList.appendChild(item);
    });
  }

  const emailInGroup = currentGroupParticipants.has(queryLower);
  const isUsernameLike = queryNorm && /^[a-zA-Z0-9_]+$/.test(queryNorm);
  const singleMatch = filtered.length === 1;
  const matchUsername = singleMatch && (() => {
    const u = (filtered[0].username || "").trim().replace(/^@+/, "");
    return u && u.toLowerCase() === queryNorm;
  })();

  if (isEmailQuery && !emailExistsInUsers && !emailAlreadySelected && !emailInGroup) {
    const addEmailItem = document.createElement("div");
    addEmailItem.className = "group-participant-item group-participant-add-email";
    addEmailItem.innerHTML = `
      <div class="group-participant-add-email-content">
        <img src="${generateAvatar(query, query)}" alt="Добавить" />
        <div class="group-participant-info">
          <div class="group-participant-name">Добавить ${query}</div>
          <div class="group-participant-email">Нажмите, чтобы добавить по email</div>
        </div>
        <button type="button" class="group-participant-add-btn" data-email="${query}">+</button>
      </div>
    `;

    const addBtn = addEmailItem.querySelector(".group-participant-add-btn");
    addBtn.addEventListener("click", () => {
      const queryLower = query.toLowerCase();
      // Проверяем, не является ли этот email участником группы
      if (currentGroupParticipants.has(queryLower)) {
        showCreateGroupError("Этот пользователь уже является участником группы");
        return;
      }
      // Проверяем, не добавлен ли уже этот email (с учетом регистра)
      const alreadyAdded = Array.from(selectedParticipants).some(
        email => email.toLowerCase() === queryLower
      );
      if (!alreadyAdded) {
        // Сохраняем email в оригинальном регистре для правильного отображения
        selectedParticipants.add(query);
        renderSelectedParticipants();
        if (groupParticipantSearch) groupParticipantSearch.value = "";
        // Показываем контакты или результаты поиска в зависимости от режима
        if (window.addMemberGroupChatId) {
          const filteredContacts = allContacts.filter(c => !currentGroupParticipants.has(c.email.toLowerCase()));
          renderParticipantsList(filteredContacts, "");
        } else {
          renderParticipantsList(allContacts, "");
        }
      }
    });

    groupParticipantsList.appendChild(addEmailItem);
  }

  if (!isEmailQuery && isUsernameLike && singleMatch && matchUsername) {
    const u = filtered[0];
    const un = (u.username || "").trim().replace(/^@+/, "") || "?";
    const addUsernameItem = document.createElement("div");
    addUsernameItem.className = "group-participant-item group-participant-add-email";
    addUsernameItem.innerHTML = `
      <div class="group-participant-add-email-content">
        <img src="${u.profile_picture || generateAvatar(u.display_name || u.username, u.email)}" alt="@${un}" />
        <div class="group-participant-info">
          <div class="group-participant-name">Добавить @${un}</div>
          <div class="group-participant-email">Нажмите, чтобы добавить по никнейму</div>
        </div>
        <button type="button" class="group-participant-add-btn" data-email="${u.email}">+</button>
      </div>
    `;
    const addBtn = addUsernameItem.querySelector(".group-participant-add-btn");
    addBtn.addEventListener("click", () => {
      const em = (u.email || "").toLowerCase();
      if (currentGroupParticipants.has(em)) {
        showCreateGroupError("Этот пользователь уже в группе");
        return;
      }
      const alreadyAdded = Array.from(selectedParticipants).some(e => e.toLowerCase() === em);
      if (!alreadyAdded) {
        selectedParticipants.add(u.email);
        renderSelectedParticipants();
        if (groupParticipantSearch) groupParticipantSearch.value = "";
        if (window.addMemberGroupChatId) {
          const fc = allContacts.filter(c => !currentGroupParticipants.has(c.email.toLowerCase()));
          renderParticipantsList(fc, "");
        } else {
          renderParticipantsList(allContacts, "");
        }
      }
    });
    groupParticipantsList.appendChild(addUsernameItem);
  }

  // Если нет результатов
  if (filtered.length === 0 && !isEmailQuery && !(isUsernameLike && singleMatch && matchUsername)) {
    const empty = document.createElement("div");
    empty.className = "group-participants-empty";
    if (query) {
      empty.textContent = "Ничего не найдено. Введите email для добавления";
    } else {
      empty.textContent = "Введите имя, username или email для поиска";
    }
    groupParticipantsList.appendChild(empty);
  }
}

// Отображение выбранных участников
function renderSelectedParticipants() {
  if (!groupSelectedParticipants) return;
  groupSelectedParticipants.innerHTML = "";

  if (selectedParticipants.size === 0) {
    groupSelectedParticipants.innerHTML = '<div class="group-selected-empty">Выберите участников из списка или введите email</div>';
    return;
  }

  selectedParticipants.forEach(email => {
    const contact = allContacts.find(c => c.email.toLowerCase() === email.toLowerCase());
    const displayName = contact 
      ? (contact.display_name || contact.full_name || contact.username || email)
      : email;
    const avatar = (contact?.profile_picture && !contact.profile_picture.includes("юзер.svg")) ? contact.profile_picture : generateAvatar(displayName, email);

    const chip = document.createElement("div");
    chip.className = "group-selected-chip";
    
    chip.innerHTML = `
      <img src="${avatar}" alt="${displayName}" />
      <span>${displayName}</span>
      <button type="button" class="group-selected-remove" data-email="${email}">×</button>
    `;

    const removeBtn = chip.querySelector(".group-selected-remove");
    removeBtn.addEventListener("click", () => {
      selectedParticipants.delete(email);
      renderSelectedParticipants();
      // Перезапускаем поиск для обновления списка
      if (groupParticipantSearch && groupParticipantSearch.value.trim()) {
        searchUsersForGroup(groupParticipantSearch.value);
      } else {
        // Показываем контакты при пустом поле поиска
        if (window.addMemberGroupChatId) {
          const filteredContacts = allContacts.filter(c => !currentGroupParticipants.has(c.email.toLowerCase()));
          renderParticipantsList(filteredContacts, "");
        } else {
          renderParticipantsList(allContacts, "");
        }
      }
    });

    groupSelectedParticipants.appendChild(chip);
  });
}

// Открытие модалки создания группы
async function openCreateGroupModal() {
  if (!createGroupModal) return;
  toggleHidden(createGroupModal, false);
  selectedParticipants.clear();
  currentGroupParticipants.clear(); // Очищаем список участников группы (при создании группы их нет)
  if (createGroupError) toggleHidden(createGroupError, true);
  if (groupNameInput) groupNameInput.value = "";
  if (groupAvatarImg) groupAvatarImg.src = generateAvatar("Группа", "new");
  if (groupParticipantSearch) groupParticipantSearch.value = "";
  
  // Загружаем контакты и показываем их по умолчанию
  const contacts = await loadContactsForGroup();
  renderParticipantsList(contacts, ""); // Показываем контакты по умолчанию
  renderSelectedParticipants();
  if (groupNameInput) groupNameInput.focus();
}

// Закрытие модалки создания группы
function closeCreateGroupModal() {
  toggleHidden(createGroupModal, true);
  if (createGroupForm) createGroupForm.reset();
  selectedParticipants.clear();
  currentGroupParticipants.clear(); // Очищаем список участников группы
  if (createGroupError) toggleHidden(createGroupError, true);
  
  // Сбрасываем аватар
  if (groupAvatarImg) groupAvatarImg.src = "/images/юзер.svg";
  if (groupAvatarInput) groupAvatarInput.value = "";
  
  // Восстанавливаем исходное состояние модалки
  const modalHeader = createGroupModal.querySelector(".create-group-header h3");
  const modalSubtitle = createGroupModal.querySelector(".create-group-header p");
  if (modalHeader) modalHeader.textContent = "Создать новую группу";
  if (modalSubtitle) modalSubtitle.textContent = "Укажите название группы и выберите участников";
  
  // Показываем поля названия и аватара группы
  const groupNameLabel = createGroupModal.querySelector('label[for="groupName"]');
  const groupNameInput = document.getElementById("groupName");
  const groupAvatarLabel = createGroupModal.querySelector('label:has(+ .group-avatar-upload)');
  const groupAvatarUpload = createGroupModal.querySelector(".group-avatar-upload");
  
  if (groupNameLabel) groupNameLabel.style.display = "";
  if (groupNameInput) {
    groupNameInput.style.display = "";
    // Восстанавливаем required атрибут для создания группы
    groupNameInput.setAttribute("required", "");
  }
  if (groupAvatarLabel) groupAvatarLabel.style.display = "";
  if (groupAvatarUpload) groupAvatarUpload.style.display = "";
  
  // Восстанавливаем текст кнопки отправки
  const submitBtn = createGroupModal.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = "Создать группу";
  
  // Очищаем сохраненный chat_id для добавления участника
  window.addMemberGroupChatId = null;
}

// Показ ошибки
function showCreateGroupError(message) {
  if (!createGroupError) return;
  createGroupError.textContent = message;
  toggleHidden(createGroupError, false);
}

// Загрузка списка групп
async function loadGroups() {
  console.log("loadGroups called");
  if (!groupsList) {
    console.error("groupsList element not found!");
    return;
  }
  
  try {
    console.log("Fetching groups from API:", `${API_BASE_URL}/api/groups`);
    const resp = await fetch(`${API_BASE_URL}/api/groups`, {
      credentials: 'include'
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      console.error("API error response:", resp.status, errorText);
      throw new Error(`Не удалось загрузить группы: ${resp.status}`);
    }
    const data = await resp.json();
    console.log("Groups data received:", data);
    renderGroupsList(data.groups || []);
  } catch (err) {
    console.error("Ошибка загрузки групп:", err);
    renderGroupsList([]);
  }
}

// Отображение списка групп
function renderGroupsList(groups = []) {
  console.log("renderGroupsList called with", groups.length, "groups");
  if (!groupsList) {
    console.error("groupsList element not found!");
    return;
  }
  groupsList.innerHTML = "";

  if (!groups || groups.length === 0) {
    console.log("No groups to render, showing empty state");
    if (groupsEmpty) {
      groupsEmpty.textContent = "Пока нет групп";
      toggleHidden(groupsEmpty, false);
    }
    return;
  }

  toggleHidden(groupsEmpty, true);

  groups.forEach(group => {
    const li = document.createElement("li");
    li.innerHTML = `
      <button
        type="button"
        class="chat-list-item-btn"
        data-chat-id="${group.chat_id}"
        data-group-name="${group.group_name}"
        data-group-avatar="${group.group_avatar}"
        data-is-group="true"
      >
        <img src="${(group.group_avatar && !group.group_avatar.includes("юзер.svg")) ? group.group_avatar : generateAvatar(group.group_name, group.chat_id)}" alt="${group.group_name}" />
        <div class="chat-info">
          <div class="chat-name">${group.group_name}</div>
          <div class="last-message"></div>
        </div>
        <span class="chat-timestamp">
          <span class="chat-list-time">${formatTime(group.last_message_timestamp)}</span>
        </span>
        ${group.unread_count > 0 ? `<div class="unread-count">${group.unread_count}</div>` : ''}
      </button>
    `;

    const btn = li.querySelector("button");
    btn.addEventListener("click", () => {
      // Используем обычную функцию loadChat для открытия группы как обычного чата
      if (typeof window.loadChat === 'function') {
        // Переключаемся на вкладку "Чаты"
        const chatsButton = document.getElementById("chatsButton");
        if (chatsButton && typeof window.switchTab === 'function') {
          window.switchTab("chats");
        }
        window.loadChat(group.chat_id);
      } else {
        openGroupChat(group.chat_id);
      }
    });

    groupsList.appendChild(li);

    const lastMsgEl = li.querySelector(".last-message");
    if (lastMsgEl) {
      const originalText = group.last_message_content || "Нет сообщений";
      lastMsgEl.textContent = "";
      if (typeof window.renderTextWithEmojis === "function") {
        window.renderTextWithEmojis(lastMsgEl, originalText);
      } else {
        lastMsgEl.textContent = originalText;
      }
    }
  });
}

// Форматирование времени
function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// Открытие группового чата (использует обычный chatWindow)
async function openGroupChat(chatId) {
  if (!chatId) return;
  
  // Используем обычную функцию loadChat из main.js
  // Она автоматически определит, что это группа, и отобразит правильно
  if (typeof window.loadChat === 'function') {
    // Переключаемся на вкладку "Чаты", если мы на вкладке "Группы"
    const chatsButton = document.getElementById("chatsButton");
    if (chatsButton && typeof window.switchTab === 'function') {
      window.switchTab("chats");
    }
    
    // Открываем чат через обычную функцию
    await window.loadChat(chatId);
  } else {
    console.error("loadChat не доступна");
  }
}

// Отображение сообщения в группе теперь не нужно,
// так как используется обычная функция renderMessage из main.js с флагом isGroupChat
// Эта функция оставлена для совместимости, но не используется
function renderGroupMessage(msg, doScroll = true) {
  // Используем обычную функцию renderMessage
  if (typeof window.renderMessage === 'function') {
    window.renderMessage(msg, doScroll, true); // true = isGroupChat
  }
}

// Обработка отправки сообщения в группу теперь не нужна,
// так как группы используют обычный messageForm из main.js

// Обработка аватара группы
if (groupAvatarChangeBtn) {
  groupAvatarChangeBtn.addEventListener("click", () => {
    if (groupAvatarInput) {
      groupAvatarInput.click();
    }
  });
}

if (groupAvatarInput) {
  groupAvatarInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file && groupAvatarImg) {
      const reader = new FileReader();
      reader.onload = (event) => {
        groupAvatarImg.src = event.target.result;
      };
      reader.readAsDataURL(file);
    }
  });
}

// Обработка поиска участников
if (groupParticipantSearch) {
  groupParticipantSearch.addEventListener("input", (e) => {
    const query = e.target.value.trim();
    
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    
    if (query.length === 0) {
      if (window.addMemberGroupChatId) {
        const fc = allContacts.filter(c => !currentGroupParticipants.has(c.email.toLowerCase()));
        renderParticipantsList(fc, "");
      } else {
        renderParticipantsList(allContacts, "");
      }
      return;
    }
    
    searchTimeout = setTimeout(() => {
      searchUsersForGroup(query);
    }, 300);
  });
  
  // Обработка Enter для добавления email напрямую
  groupParticipantSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const query = e.target.value.trim();
      const queryLower = query.toLowerCase();
      
      if (query && isValidEmail(query)) {
        // Проверяем, не добавлен ли уже этот email (с учетом регистра)
        const alreadySelected = Array.from(selectedParticipants).some(
          email => email.toLowerCase() === queryLower
        );
        
        if (alreadySelected) {
          showCreateGroupError("Этот участник уже выбран");
          e.target.value = "";
          return;
        }
        
        // Проверяем, не является ли этот email участником группы
        if (currentGroupParticipants.has(queryLower)) {
          showCreateGroupError("Этот пользователь уже является участником группы");
          e.target.value = "";
          return;
        }
        
        // Проверяем, есть ли этот email в текущих результатах поиска
        const currentItems = groupParticipantsList.querySelectorAll('.group-participant-item');
        let found = false;
        
        currentItems.forEach(item => {
          const checkbox = item.querySelector('input[type="checkbox"]');
          if (checkbox && checkbox.dataset.email.toLowerCase() === queryLower) {
            if (!checkbox.checked) {
              checkbox.checked = true;
              checkbox.dispatchEvent(new Event("change"));
            }
            found = true;
          }
        });
        
        // Если не найден в результатах, добавляем напрямую
        if (!found) {
          // Сохраняем email в оригинальном регистре (не lowercase), чтобы правильно отображался
          selectedParticipants.add(query);
          renderSelectedParticipants();
          e.target.value = "";
          // Показываем контакты или результаты поиска в зависимости от режима
          if (window.addMemberGroupChatId) {
            const filteredContacts = allContacts.filter(c => !currentGroupParticipants.has(c.email.toLowerCase()));
            renderParticipantsList(filteredContacts, "");
          } else {
            renderParticipantsList(allContacts, "");
          }
        }
      } else if (query && !isValidEmail(query)) {
        showCreateGroupError("Введите корректный email адрес");
      }
    }
  });
}

// Обработка создания группы или добавления участника
if (createGroupForm) {
  createGroupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    // Проверяем, открыта ли модалка для добавления участника
    const isAddMemberMode = window.addMemberGroupChatId && !createGroupModal.classList.contains("hidden");
    
    // Если режим добавления участника, убираем required с поля названия группы
    // чтобы избежать ошибки валидации браузера для скрытого поля
    if (isAddMemberMode && groupNameInput) {
      groupNameInput.removeAttribute("required");
    }
    
    if (isAddMemberMode) {
      // Режим добавления участника
      if (selectedParticipants.size === 0) {
        showCreateGroupError("Выберите хотя бы одного участника");
        return;
      }
      
      try {
        // Нормализуем email адреса (trim) и убираем пустые значения
        // Не ограничиваем формат на клиенте, так как backend умеет
        // принимать "нестандартные" адреса, если такой пользователь есть в базе
        const participantEmails = Array.from(selectedParticipants)
          .map(email => typeof email === 'string' ? email.trim() : String(email).trim())
          .filter(email => email.length > 0);
        
        if (participantEmails.length === 0) {
          showCreateGroupError("Выберите хотя бы одного участника с валидным email");
          return;
        }
        
        console.log("[addMembers] Отправка участников:", participantEmails);
        
        const resp = await fetch(`${API_BASE_URL}/api/groups/${window.addMemberGroupChatId}/add_members`, {
          method: "POST",
          credentials: 'include',
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participant_emails: participantEmails })
        });
        
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          const errorMessage = err.detail || err.message || "Не удалось добавить участника";
          console.error("[addMembers] Ошибка:", errorMessage);
          throw new Error(errorMessage);
        }
        
        const result = await resp.json().catch(() => ({}));
        console.log("[addMembers] Участники успешно добавлены:", result);
        
        closeCreateGroupModal();
        
        // Обновляем профиль группы, если он открыт
        if (typeof window.currentGroupChatId === 'string' && window.currentGroupChatId === window.addMemberGroupChatId) {
          // Перезагружаем данные группы
          try {
            const groupResp = await fetch(`${API_BASE_URL}/api/chats/${window.addMemberGroupChatId}`, {
              credentials: 'include'
            });
            if (groupResp.ok) {
              const groupData = await groupResp.json();
              if (typeof window.openGroupProfile === 'function') {
                await window.openGroupProfile(groupData);
              }
            }
          } catch (err) {
            console.error("Ошибка обновления профиля группы:", err);
          }
        }
        
        // Очищаем сохраненный chat_id
        window.addMemberGroupChatId = null;
      } catch (err) {
        console.error("Ошибка добавления участника:", err);
        showCreateGroupError(err.message || "Не удалось добавить участника");
      }
      return;
    }
    
    // Режим создания группы
    if (!groupNameInput) return;
    
    const name = groupNameInput.value.trim();
    if (!name) {
      showCreateGroupError("Укажите название группы");
      return;
    }
    
    if (selectedParticipants.size === 0) {
      showCreateGroupError("Выберите хотя бы одного участника");
      return;
    }
    
    // Фильтруем и нормализуем email перед отправкой.
    // Оставляем проверку только на пустые строки, чтобы совпадать с backend,
    // который допускает "нестандартные" адреса, если такие пользователи есть.
    const participantEmailsArray = Array.from(selectedParticipants)
      .map(email => {
        if (typeof email === 'string') return email.trim();
        const normalized = String(email).trim();
        if (!normalized) console.warn("Empty email in selectedParticipants");
        return normalized;
      })
      .filter(email => email.length > 0);
    
    console.log("Selected participants Set size:", selectedParticipants.size);
    console.log("Selected participants Set content:", Array.from(selectedParticipants));
    console.log("Filtered participants to send:", participantEmailsArray);
    
    if (participantEmailsArray.length === 0) {
      console.error("ERROR: No valid participants after filtering!");
      console.error("Original selectedParticipants:", Array.from(selectedParticipants));
      showCreateGroupError("Выберите хотя бы одного участника с валидным email");
      return;
    }
    
    const fd = new FormData();
    fd.append("name", name);
    
    // Добавляем участников - важно добавлять каждый email отдельно с одинаковым ключом
    participantEmailsArray.forEach((email, index) => {
      const trimmedEmail = email.trim();
      console.log(`Adding participant ${index + 1}: ${trimmedEmail}`);
      fd.append("participant_emails", trimmedEmail);
    });
    
    // Добавляем аватар, если он выбран
    if (groupAvatarInput && groupAvatarInput.files && groupAvatarInput.files[0]) {
      const avatarFile = groupAvatarInput.files[0];
      fd.append("avatar_file", avatarFile);
    }
    
    // Логируем содержимое FormData для отладки
    console.log("FormData contents:");
    for (let pair of fd.entries()) {
      console.log(pair[0] + ': ' + pair[1]);
    }
    
    try {
      const resp = await fetch(`${API_BASE_URL}/api/groups/create`, {
        method: "POST",
        body: fd,
        credentials: 'include'
        // НЕ добавляем Content-Type header - браузер установит его автоматически с boundary для FormData
      });
      
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail || "Не удалось создать группу");
      }
      
      const data = await resp.json();
      closeCreateGroupModal();
      
      // Переключаемся на вкладку "Чаты" и открываем созданную группу
      if (data.chat_id) {
        // Переключаемся на вкладку "Чаты"
        if (typeof window.switchTab === 'function') {
          window.switchTab("chats");
        } else {
          const chatsButton = document.getElementById("chatsButton");
          if (chatsButton) {
            chatsButton.click();
          }
        }
        
        // Перезагружаем страницу, чтобы группа появилась в списке чатов
        // и открываем созданную группу через URL
        setTimeout(() => {
          window.location.href = `/chat-${data.chat_id}`;
        }, 100);
      } else {
        // Если нет chat_id, просто перезагружаем страницу
        window.location.reload();
      }
    } catch (err) {
      console.error("Ошибка создания группы:", err);
      showCreateGroupError(err.message || "Не удалось создать группу");
    }
  });
}

// Обработка кнопки "Назад" в групповом чате (теперь не нужна, используется обычный чат)
// Удалено, так как группы открываются в обычном chatWindow

// Обработка клика на аватар группы теперь в main.js (строка ~4534)

// Открытие профиля группы (использует правую боковую панель)
async function openGroupProfile(groupData) {
  console.log("openGroupProfile called with data:", groupData);
  const profileSection = document.getElementById("profileSection");
  const profileName = document.getElementById("profileName");
  const profileUsername = document.getElementById("profileUsername");
  const profileEmail = document.getElementById("profileEmail");
  const profileQuote = document.getElementById("profileQuote");
  const profileHeaderBgImg = document.getElementById("profileHeaderBgImg");
  const profileCallBtn = document.getElementById("profileCallBtn");
  const profileVideoCallBtn = document.getElementById("profileVideoCallBtn");
  const profileGiftBtn = document.getElementById("profileGiftBtn");
  const profileAddMemberBtn = document.getElementById("profileAddMemberBtn");
  const profileMediaTabs = document.querySelectorAll(".profile-media-tab");
  const profileParticipantsTab = document.querySelector(".profile-participants-tab");
  
  if (!profileSection) {
    console.error("profileSection element not found!");
    return;
  }
  
  // Сохраняем chat_id группы для использования при добавлении участников
  window.currentGroupChatId = groupData.chat_id || groupData._id || groupData.id || null;
  
  // Проверяем, что chat_id получен
  if (!window.currentGroupChatId) {
    console.error("Не удалось получить chat_id группы:", groupData);
    return;
  }
  
  // Скрываем кнопки звонков для групп
  if (profileCallBtn) profileCallBtn.style.display = "none";
  if (profileVideoCallBtn) profileVideoCallBtn.style.display = "none";
  if (profileGiftBtn) profileGiftBtn.style.display = "none";
  
  // Показываем кнопку "Добавить участника" для групп
  if (profileAddMemberBtn) {
    profileAddMemberBtn.classList.remove("hidden");
    profileAddMemberBtn.style.display = "flex";
  }
  
  // Показываем вкладку "Участники"
  if (profileParticipantsTab) {
    profileParticipantsTab.classList.remove("hidden");
  }
  
  // Заполняем данные группы
  if (profileName) {
    profileName.textContent = groupData.group_name || groupData.chat_name || 'Группа';
  }

  if (profileUsername) {
    profileUsername.textContent = "";
    profileUsername.classList.add("hidden");
  }
  
  if (profileEmail) {
    const participantCount = Array.isArray(groupData.participants) 
      ? groupData.participants.length 
      : (groupData.participants ? 1 : 0);
    profileEmail.textContent = `Группа • ${participantCount} участников`;
  }
  
  if (profileQuote) {
    profileQuote.textContent = "Групповой чат";
  }
  
// Устанавливаем аватар группы
  if (profileHeaderBgImg) {
    let avatarUrl = groupData.group_avatar || groupData.chat_avatar;
    if (!avatarUrl || avatarUrl.includes("юзер.svg")) {
        avatarUrl = generateAvatar(groupData.group_name || groupData.chat_title, groupData.chat_id);
        profileHeaderBgImg.src = avatarUrl;
    } else {
        const separator = avatarUrl.includes('?') ? '&' : '?';
        profileHeaderBgImg.src = `${avatarUrl}${separator}t=${Date.now()}`;
        profileHeaderBgImg.onerror = function() {
          this.src = avatarUrl;
        };
    }
  }
  
  // Загружаем данные участников и сохраняем их
  try {
    // Убеждаемся, что participants - это массив email
    const participantEmails = Array.isArray(groupData.participants) 
      ? groupData.participants 
      : (groupData.participants ? [groupData.participants] : []);
    
    const participants = await loadGroupParticipants(
      participantEmails, 
      groupData.owner || groupData.group_owner || window.CURRENT_USER_EMAIL
    );
    
    // Сохраняем данные участников для использования в loadProfileContent
    window.currentGroupParticipantsData = {
      participants: participants,
      owner: groupData.owner || groupData.group_owner || window.CURRENT_USER_EMAIL
    };
  } catch (error) {
    console.error("Ошибка загрузки участников группы:", error);
    window.currentGroupParticipantsData = {
      participants: [],
      owner: groupData.owner || groupData.group_owner || window.CURRENT_USER_EMAIL
    };
  }
  
  // Показываем профиль (правая боковая панель)
  profileSection.classList.remove("hidden");
  const app = document.querySelector('.app');
  if (app) {
    app.classList.add('profile-open');
  }
  
  // Активируем вкладку "Участники" по умолчанию
  setTimeout(() => {
    if (profileParticipantsTab) {
      // Получаем все вкладки заново
      const allTabs = document.querySelectorAll(".profile-media-tab");
      // Убираем активный класс у всех вкладок
      allTabs.forEach(t => t.classList.remove("active"));
      // Добавляем активный класс к вкладке "Участники"
      profileParticipantsTab.classList.add("active");
      // Загружаем участников
      if (typeof window.loadProfileContent === 'function') {
        window.loadProfileContent('participants', '');
      }
    }
  }, 100);
}

// Загрузка данных участников группы
async function loadGroupParticipants(participantEmails, ownerEmail) {
  const participants = [];
  
  for (const email of participantEmails) {
    try {
      const resp = await fetch(`${API_BASE_URL}/api/user_profile?email=${encodeURIComponent(email)}`, {
        credentials: 'include'
      });
      if (resp.ok) {
        const userData = await resp.json();
        
        // Базовое имя из профиля пользователя
        let name = userData.full_name || userData.username || email;

        // Если пользователь есть в контактах — используем то имя, как он записан в контактах
        try {
          const contactsMap = window.CONTACTS_BY_EMAIL || {};
          const contactInfo = contactsMap[email];
          if (contactInfo) {
            name =
              contactInfo.contact_name ||
              contactInfo.display_name ||
              contactInfo.full_name ||
              contactInfo.username ||
              name;
          }
        } catch (e) {
          // Не ломаем загрузку, если что-то с картой контактов
        }

        participants.push({
          email: email,
          name,
          profile_picture: (userData.profile_picture && !userData.profile_picture.includes("юзер.svg")) ? userData.profile_picture : generateAvatar(name, email),
          is_admin: userData.is_admin || false,
          is_owner: email === ownerEmail // Правильно определяем владельца
        });
      } else {
        // Если не удалось загрузить, добавляем с базовыми данными
        let name = email;
        try {
          const contactsMap = window.CONTACTS_BY_EMAIL || {};
          const contactInfo = contactsMap[email];
          if (contactInfo) {
            name =
              contactInfo.contact_name ||
              contactInfo.display_name ||
              contactInfo.full_name ||
              contactInfo.username ||
              name;
          }
        } catch (e) {}

        participants.push({
          email: email,
          name,
          profile_picture: generateAvatar(name, email),
          is_admin: false,
          is_owner: email === ownerEmail
        });
      }
    } catch (err) {
      console.error(`Ошибка загрузки участника ${email}:`, err);
      let name = email;
      try {
        const contactsMap = window.CONTACTS_BY_EMAIL || {};
        const contactInfo = contactsMap[email];
        if (contactInfo) {
          name =
            contactInfo.contact_name ||
            contactInfo.display_name ||
            contactInfo.full_name ||
            contactInfo.username ||
            name;
        }
      } catch (e) {}

      participants.push({
        email: email,
        name,
        profile_picture: generateAvatar(name, email),
        is_admin: false,
        is_owner: email === ownerEmail
      });
    }
  }
  
  return participants;
}

// Event listeners
// Используем делегирование событий для кнопки создания группы, так как она может быть в скрытом разделе
document.addEventListener("click", (e) => {
  // Проверяем, является ли цель кнопкой или её дочерним элементом
  const btn = e.target.closest("#openCreateGroupBtn");
  // Также проверяем по ID, если клик был непосредственно на кнопке
  if (btn || e.target.id === "openCreateGroupBtn") {
    e.preventDefault();
    e.stopPropagation();
    openCreateGroupModal();
    return;
  }
});

// Также добавляем прямой обработчик для надежности (работает, когда кнопка видна)
if (openCreateGroupBtn) {
  openCreateGroupBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCreateGroupModal();
  });
}

if (createGroupCloseBtn) {
  createGroupCloseBtn.addEventListener("click", closeCreateGroupModal);
}

if (cancelCreateGroup) {
  cancelCreateGroup.addEventListener("click", closeCreateGroupModal);
}

if (createGroupModal) {
  createGroupModal.addEventListener("click", (e) => {
    if (e.target === createGroupModal) {
      closeCreateGroupModal();
    }
  });
}

// Загрузка групп при открытии вкладки
window.addEventListener("groupsTabOpened", () => {
  console.log("groupsTabOpened event received, loading groups...");
  loadGroups();
});

// Также загружаем группы при загрузке страницы, если вкладка "Группы" активна
document.addEventListener("DOMContentLoaded", () => {
  // Проверяем, активна ли вкладка "Группы" при загрузке
  const groupsButton = document.getElementById("groupsButton");
  const groupsSection = document.getElementById("groupsSection");
  if (groupsButton && groupsSection && 
      groupsButton.classList.contains("active") && 
      !groupsSection.classList.contains("hidden")) {
    console.log("Groups tab is active on page load, loading groups...");
    loadGroups();
  }
});

// Также загружаем группы при первом клике на кнопку "Группы" если они еще не загружены
if (openCreateGroupBtn) {
  // Используем MutationObserver для отслеживания изменения видимости секции групп
  const groupsSection = document.getElementById("groupsSection");
  if (groupsSection) {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          const isVisible = !groupsSection.classList.contains("hidden");
          if (isVisible && groupsList && groupsList.children.length === 0) {
            console.log("Groups section became visible, loading groups...");
            loadGroups();
          }
        }
      });
    });
    observer.observe(groupsSection, { attributes: true });
  }
}

// ===========================
// === Настройки группы ===
// ===========================

const groupSettingsModal = document.getElementById("groupSettingsModal");
const groupSettingsCloseBtn = document.getElementById("groupSettingsCloseBtn");
const groupSettingsContent = document.getElementById("groupSettingsContent");
const groupSettingsSubtitle = document.getElementById("groupSettingsSubtitle");
let currentGroupSettingsChatId = null;
// Делаем переменную доступной глобально для использования в main.js
window.currentGroupSettingsChatId = null;

// Элементы модалки участников (инициализируем после загрузки DOM)
let groupParticipantsModal = null;
let groupParticipantsCloseBtn = null;
let groupParticipantsContent = null;
let groupParticipantsSubtitle = null;
let currentGroupParticipantsChatId = null;

// Инициализация элементов модалки участников
function initGroupParticipantsModal() {
  groupParticipantsModal = document.getElementById("groupParticipantsModal");
  groupParticipantsCloseBtn = document.getElementById("groupParticipantsCloseBtn");
  groupParticipantsContent = document.getElementById("groupParticipantsContent");
  groupParticipantsSubtitle = document.getElementById("groupParticipantsSubtitle");
  
  // Обработчики событий для модального окна участников
  if (groupParticipantsCloseBtn) {
    groupParticipantsCloseBtn.addEventListener("click", closeGroupParticipantsModal);
  }

  if (groupParticipantsModal) {
    groupParticipantsModal.addEventListener("click", (e) => {
      if (e.target === groupParticipantsModal) {
        closeGroupParticipantsModal();
      }
    });
  }
}

// Инициализируем при загрузке DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGroupParticipantsModal);
} else {
  initGroupParticipantsModal();
}

// Открытие модального окна настроек группы
async function openGroupSettings(chatId) {
  console.log("[openGroupSettings] Вызвана функция с chatId:", chatId);
  console.log("[openGroupSettings] groupSettingsModal:", groupSettingsModal);
  
  if (!groupSettingsModal) {
    console.error("[openGroupSettings] groupSettingsModal не найден!");
    return;
  }
  
  if (!chatId) {
    console.error("[openGroupSettings] chatId не передан!");
    return;
  }
  
  currentGroupSettingsChatId = chatId;
  window.currentGroupSettingsChatId = chatId;
  
  try {
    console.log("[openGroupSettings] Загрузка настроек группы...");
    // Загружаем настройки группы
    const resp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/settings`, {
      credentials: 'include'
    });
    
    if (!resp.ok) {
      const errorData = await resp.json().catch(() => ({}));
      throw new Error(errorData.detail || "Не удалось загрузить настройки группы");
    }
    
    const settings = await resp.json();
    console.log("[openGroupSettings] Настройки загружены:", settings);
    
    // Отображаем форму настроек (даже если нет прав на изменение)
    // Права проверяются внутри формы
    renderGroupSettingsForm(settings);
    
    // Убираем класс hidden и показываем модалку
    console.log("[openGroupSettings] Показываем модалку...");
    console.log("[openGroupSettings] До: groupSettingsModal.classList:", groupSettingsModal.classList.toString());
    toggleHidden(groupSettingsModal, false);
    console.log("[openGroupSettings] После: groupSettingsModal.classList:", groupSettingsModal.classList.toString());
    console.log("[openGroupSettings] groupSettingsModal.style.display:", window.getComputedStyle(groupSettingsModal).display);
    
    // Дополнительно убеждаемся, что модалка видна
    groupSettingsModal.style.display = "flex";
    groupSettingsModal.style.zIndex = "10000";
    
    if (groupSettingsSubtitle) {
      groupSettingsSubtitle.textContent = settings.is_owner 
        ? "Вы владелец группы" 
        : "Настройки группы";
    }
  } catch (err) {
    console.error("[openGroupSettings] Ошибка загрузки настроек группы:", err);
    if (groupSettingsContent) {
      groupSettingsContent.innerHTML = `
        <div class="group-settings-error">
          Ошибка загрузки настроек: ${err.message}
        </div>
      `;
    }
    toggleHidden(groupSettingsModal, false);
    groupSettingsModal.style.display = "flex";
    groupSettingsModal.style.zIndex = "10000";
  }
}

// Отображение формы настроек группы
function renderGroupSettingsForm(settings) {
  if (!groupSettingsContent) return;
  
  const isOwner = settings.is_owner;
  const canEdit = settings.can_edit_settings;
  
  groupSettingsContent.innerHTML = `
    <form id="groupSettingsForm" class="group-settings-form">
      ${!canEdit ? `
        <div class="group-settings-info">
          Владелец группы не разрешил участникам изменять настройки. Вы можете только просматривать текущие настройки.
        </div>
      ` : ''}
      
      <!-- Название группы -->
      <div class="group-settings-item">
        <label class="group-settings-item-label">Название группы</label>
        <input 
          type="text" 
          id="groupSettingsName" 
          class="group-settings-input" 
          value="${escapeHtml(settings.group_name)}" 
          placeholder="Название группы"
          ${!canEdit ? 'disabled' : ''}
        />
      </div>
      
      <div class="group-settings-item">
        <label class="group-settings-item-label">Аватар группы</label>
        <div class="group-settings-avatar-section">
          <div class="group-settings-avatar-preview">
            <img id="groupSettingsAvatarImg" src="${(settings.group_avatar && !settings.group_avatar.includes("юзер.svg")) ? settings.group_avatar : generateAvatar(settings.group_name || 'Группа', currentGroupSettingsChatId)}" alt="Аватар группы" />
          </div>
          <div>
            <input type="file" id="groupSettingsAvatarInput" accept="image/*" style="display: none" ${!canEdit ? 'disabled' : ''} />
            <button type="button" class="group-settings-avatar-change-btn" id="groupSettingsAvatarChangeBtn" ${!canEdit ? 'disabled' : ''}>
              Изменить аватар
            </button>
          </div>
        </div>
      </div>
      
      <!-- Разрешение участникам менять настройки (только для владельца) -->
      ${isOwner ? `
        <div class="group-settings-item">
          <div class="group-settings-toggle">
            <div class="group-settings-toggle-label">
              <div class="group-settings-item-label">Разрешить участникам изменять настройки</div>
              <div class="group-settings-item-description">
                Если включено, все участники группы смогут изменять название и аватар группы
              </div>
            </div>
            <div 
              class="group-settings-toggle-switch ${settings.allow_members_edit_settings ? 'active' : ''}" 
              id="groupSettingsToggle"
              data-enabled="${settings.allow_members_edit_settings}"
            ></div>
          </div>
        </div>
      ` : ''}
      
      <div id="groupSettingsError" class="group-settings-error hidden"></div>
      <div id="groupSettingsSuccess" class="group-settings-success hidden"></div>
      
      <div class="group-settings-actions">
        <button type="button" class="secondary-btn" id="cancelGroupSettings">Отмена</button>
        <button type="submit" class="primary-btn" ${!canEdit ? 'disabled' : ''}>Сохранить</button>
      </div>
    </form>
    
    <!-- Кнопка управления участниками -->
    <div class="group-settings-item" id="groupParticipantsSection">
      <button type="button" class="group-settings-participants-btn" id="openGroupParticipantsBtn">
        <span>Участники</span>
        <span class="group-settings-btn-arrow">→</span>
      </button>
    </div>
  `;
  
  // Обработчики событий
  const avatarChangeBtn = document.getElementById("groupSettingsAvatarChangeBtn");
  const avatarInput = document.getElementById("groupSettingsAvatarInput");
  const avatarImg = document.getElementById("groupSettingsAvatarImg");
  const toggleSwitch = document.getElementById("groupSettingsToggle");
  const form = document.getElementById("groupSettingsForm");
  const cancelBtn = document.getElementById("cancelGroupSettings");
  const openParticipantsBtn = document.getElementById("openGroupParticipantsBtn");
  
  // Обработчик кнопки открытия модалки участников
  if (openParticipantsBtn) {
    openParticipantsBtn.addEventListener("click", () => {
      openGroupParticipantsModal(currentGroupSettingsChatId);
    });
  }
  
  if (avatarChangeBtn && avatarInput && canEdit) {
    avatarChangeBtn.addEventListener("click", () => {
      avatarInput.click();
    });
  }
  
  if (avatarInput) {
    avatarInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file && avatarImg) {
        const reader = new FileReader();
        reader.onload = (event) => {
          avatarImg.src = event.target.result;
        };
        reader.readAsDataURL(file);
      }
    });
  }
  
  if (toggleSwitch) {
    toggleSwitch.addEventListener("click", () => {
      const isEnabled = toggleSwitch.dataset.enabled === "true";
      toggleSwitch.dataset.enabled = (!isEnabled).toString();
      toggleSwitch.classList.toggle("active");
    });
  }
  
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await saveGroupSettings();
    });
  }
  
  if (cancelBtn) {
    cancelBtn.addEventListener("click", closeGroupSettings);
  }
}

// Сохранение настроек группы
async function saveGroupSettings() {
  if (!currentGroupSettingsChatId) return;
  
  // Проверяем права доступа
  try {
    const settingsResp = await fetch(`${API_BASE_URL}/api/groups/${currentGroupSettingsChatId}/settings`, {
      credentials: 'include'
    });
    if (!settingsResp.ok) {
      throw new Error("Не удалось проверить права доступа");
    }
    const settings = await settingsResp.json();
    if (!settings.can_edit_settings) {
      showGroupSettingsError("У вас нет прав на изменение настроек группы");
      return;
    }
  } catch (err) {
    showGroupSettingsError("Ошибка проверки прав доступа: " + err.message);
    return;
  }
  
  const nameInput = document.getElementById("groupSettingsName");
  const avatarInput = document.getElementById("groupSettingsAvatarInput");
  const toggleSwitch = document.getElementById("groupSettingsToggle");
  const errorDiv = document.getElementById("groupSettingsError");
  const successDiv = document.getElementById("groupSettingsSuccess");
  
  if (!nameInput) return;
  
  const newName = nameInput.value.trim();
  if (!newName) {
    showGroupSettingsError("Название группы не может быть пустым");
    return;
  }
  
  try {
    // Получаем текущие настройки, чтобы проверить, что изменилось
    const currentSettingsResp = await fetch(`${API_BASE_URL}/api/groups/${currentGroupSettingsChatId}/settings`, {
      credentials: 'include'
    });
    if (!currentSettingsResp.ok) {
      throw new Error("Не удалось получить текущие настройки");
    }
    const currentSettings = await currentSettingsResp.json();
    
    // Обновляем только то, что действительно изменилось
    const updateData = {};
    
    // Проверяем, изменилось ли название
    if (newName !== currentSettings.group_name) {
      updateData.group_name = newName;
    }
    
    // Обновляем разрешение только если пользователь владелец
    // ВАЖНО: Не добавляем это поле, если пользователь не владелец
    if (toggleSwitch && currentSettings.is_owner) {
      const newAllowEdit = toggleSwitch.dataset.enabled === "true";
      if (newAllowEdit !== currentSettings.allow_members_edit_settings) {
        updateData.allow_members_edit_settings = newAllowEdit;
      }
    } else if (toggleSwitch && !currentSettings.is_owner) {
      // Если пользователь не владелец, не отправляем allow_members_edit_settings
      // Это поле должно обрабатываться только владельцем
      console.log("Пользователь не является владельцем, пропускаем allow_members_edit_settings");
    }
    
    // Проверяем, есть ли новый аватар для загрузки
    const hasNewAvatar = avatarInput && avatarInput.files && avatarInput.files[0];
    
    // Если ничего не изменилось И нет нового аватара, просто возвращаемся
    if (Object.keys(updateData).length === 0 && !hasNewAvatar) {
      showGroupSettingsSuccess("Настройки не изменились");
      setTimeout(() => {
        closeGroupSettings();
      }, 1000);
      return;
    }
    
    // Обновляем настройки (название, разрешения), если есть изменения
    if (Object.keys(updateData).length > 0) {
      const resp = await fetch(`${API_BASE_URL}/api/groups/${currentGroupSettingsChatId}/settings`, {
        method: "PUT",
        credentials: 'include',
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updateData)
      });
      
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const errorMessage = err.detail || err.message || "Не удалось обновить настройки";
        throw new Error(errorMessage);
      }
      
      const settingsResult = await resp.json().catch(() => ({}));
      console.log("[saveGroupSettings] Настройки обновлены:", settingsResult);
    }
    
    // Если выбран новый аватар, загружаем его отдельно (можно обновлять только аватар)
    if (hasNewAvatar) {
      const formData = new FormData();
      formData.append("avatar_file", avatarInput.files[0]);
      
      const avatarResp = await fetch(`${API_BASE_URL}/api/groups/${currentGroupSettingsChatId}/avatar`, {
        method: "POST",
        credentials: 'include',
        body: formData
      });
      
      if (!avatarResp.ok) {
        const err = await avatarResp.json().catch(() => ({}));
        const errorMessage = err.detail || err.message || "Не удалось обновить аватар";
        throw new Error(errorMessage);
      }
      
        const avatarResult = await avatarResp.json().catch(() => ({}));
      console.log("[saveGroupSettings] Аватар обновлен:", avatarResult);
      
      // Обновляем аватар в модалке настроек сразу же
      const groupSettingsAvatarImg = document.getElementById("groupSettingsAvatarImg");
      if (groupSettingsAvatarImg && avatarResult.group_avatar) {
        const separator = avatarResult.group_avatar.includes('?') ? '&' : '?';
        const newAvatarUrl = `${avatarResult.group_avatar}${separator}t=${Date.now()}`;
        groupSettingsAvatarImg.src = newAvatarUrl;
        console.log("[saveGroupSettings] Аватар обновлен в модалке настроек");
      }
    }
    
    showGroupSettingsSuccess("Настройки группы успешно обновлены");
    
    // Обновляем данные в интерфейсе
    // WebSocket обновит интерфейс в реальном времени, поэтому просто закрываем модалку
    setTimeout(() => {
      closeGroupSettings();
    }, 1000);
  } catch (err) {
    console.error("Ошибка сохранения настроек группы:", err);
    showGroupSettingsError(err.message || "Не удалось сохранить настройки");
  }
}

// Показать ошибку
function showGroupSettingsError(message) {
  const errorDiv = document.getElementById("groupSettingsError");
  const successDiv = document.getElementById("groupSettingsSuccess");
  if (errorDiv) {
    errorDiv.textContent = message;
    toggleHidden(errorDiv, false);
  }
  if (successDiv) {
    toggleHidden(successDiv, true);
  }
}

// Показать успех
function showGroupSettingsSuccess(message) {
  const errorDiv = document.getElementById("groupSettingsError");
  const successDiv = document.getElementById("groupSettingsSuccess");
  if (successDiv) {
    successDiv.textContent = message;
    toggleHidden(successDiv, false);
  }
  if (errorDiv) {
    toggleHidden(errorDiv, true);
  }
}

// Закрытие модального окна настроек
function closeGroupSettings() {
  if (groupSettingsModal) {
    toggleHidden(groupSettingsModal, true);
  }
  currentGroupSettingsChatId = null;
  window.currentGroupSettingsChatId = null;
  if (groupSettingsContent) {
    groupSettingsContent.innerHTML = '<div class="group-settings-loading">Загрузка...</div>';
  }
}

// Экранирование HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Обработчики событий для модального окна настроек
if (groupSettingsCloseBtn) {
  groupSettingsCloseBtn.addEventListener("click", closeGroupSettings);
}

if (groupSettingsModal) {
  groupSettingsModal.addEventListener("click", (e) => {
    if (e.target === groupSettingsModal) {
      closeGroupSettings();
    }
  });
}

// Обработчики событий для модального окна участников уже настроены в initGroupParticipantsModal

// Обработчик клика на кнопку "Добавить участника"
const profileAddMemberBtn = document.getElementById("profileAddMemberBtn");
if (profileAddMemberBtn) {
  profileAddMemberBtn.addEventListener("click", () => {
    if (!window.currentGroupChatId) {
      console.error("Не указан chat_id группы");
      return;
    }
    // Открываем модалку добавления участников (используем модалку создания группы, но адаптируем)
    openAddMemberModal(window.currentGroupChatId);
  });
}

// Открытие модалки добавления участника в группу
async function openAddMemberModal(chatId) {
  if (!createGroupModal || !chatId) return;
  
  // Меняем заголовок модалки
  const modalHeader = createGroupModal.querySelector(".create-group-header h3");
  const modalSubtitle = createGroupModal.querySelector(".create-group-header p");
  if (modalHeader) modalHeader.textContent = "Добавить участника";
  if (modalSubtitle) modalSubtitle.textContent = "Выберите участника для добавления в группу";
  
  // Скрываем поля названия и аватара группы
  const groupNameLabel = createGroupModal.querySelector('label[for="groupName"]');
  const groupNameInput = document.getElementById("groupName");
  const groupAvatarLabel = createGroupModal.querySelector('label:has(+ .group-avatar-upload)');
  const groupAvatarUpload = createGroupModal.querySelector(".group-avatar-upload");
  
  if (groupNameLabel) groupNameLabel.style.display = "none";
  if (groupNameInput) {
    groupNameInput.style.display = "none";
    // Убираем required атрибут, чтобы избежать ошибки валидации браузера
    groupNameInput.removeAttribute("required");
    // Очищаем значение, чтобы не было проблем при валидации
    groupNameInput.value = "";
  }
  if (groupAvatarLabel) groupAvatarLabel.style.display = "none";
  if (groupAvatarUpload) groupAvatarUpload.style.display = "none";
  
  // Меняем текст кнопки отправки
  const submitBtn = createGroupModal.querySelector('button[type="submit"]');
  if (submitBtn) submitBtn.textContent = "Добавить";
  
  // Очищаем выбранных участников
  selectedParticipants.clear();
  if (createGroupError) toggleHidden(createGroupError, true);
  if (groupParticipantSearch) groupParticipantSearch.value = "";
  
  // Загружаем участников группы для исключения их из поиска
  await loadGroupParticipantsForFilter(chatId);
  
  // Загружаем контакты и показываем их по умолчанию
  const contacts = await loadContactsForGroup();
  // Фильтруем контакты, исключая участников группы
  const filteredContacts = contacts.filter(c => !currentGroupParticipants.has(c.email.toLowerCase()));
  renderParticipantsList(filteredContacts, ""); // Показываем контакты по умолчанию (без участников группы)
  renderSelectedParticipants();
  
  // Показываем модалку
  toggleHidden(createGroupModal, false);
  
  // Сохраняем chat_id для использования при отправке формы
  window.addMemberGroupChatId = chatId;
}

// Открытие модалки участников группы
async function openGroupParticipantsModal(chatId) {
  if (!groupParticipantsModal || !chatId) return;
  
  currentGroupParticipantsChatId = chatId;
  
  // Показываем модалку
  toggleHidden(groupParticipantsModal, false);
  groupParticipantsModal.style.display = "flex";
  groupParticipantsModal.style.zIndex = "10000";
  
  // Активируем вкладку "Участники" по умолчанию
  const participantsTab = document.getElementById("groupParticipantsModalTab");
  const adminsTab = document.getElementById("groupAdminsModalTab");
  
  if (participantsTab) {
    document.querySelectorAll("#groupParticipantsContent .group-participants-tab").forEach(tab => tab.classList.remove("active"));
    participantsTab.classList.add("active");
  }
  
  // Загружаем участников
  await loadGroupParticipantsForModal(chatId, "participants");
  
  // Настраиваем обработчики вкладок
  if (participantsTab) {
    participantsTab.onclick = () => {
      document.querySelectorAll("#groupParticipantsContent .group-participants-tab").forEach(tab => tab.classList.remove("active"));
      participantsTab.classList.add("active");
      loadGroupParticipantsForModal(chatId, "participants");
    };
  }
  
  if (adminsTab) {
    adminsTab.onclick = () => {
      document.querySelectorAll("#groupParticipantsContent .group-participants-tab").forEach(tab => tab.classList.remove("active"));
      adminsTab.classList.add("active");
      loadGroupParticipantsForModal(chatId, "admins");
    };
  }
}

// Закрытие модалки участников
function closeGroupParticipantsModal() {
  if (groupParticipantsModal) {
    toggleHidden(groupParticipantsModal, true);
  }
  currentGroupParticipantsChatId = null;
}

// Загрузка и отображение участников группы в модалке
async function loadGroupParticipantsForModal(chatId, tabType = "participants") {
  const participantsList = document.getElementById("groupParticipantsModalList");
  if (!participantsList || !chatId) return;
  
  // Показываем индикатор загрузки
  participantsList.innerHTML = '<div class="group-settings-loading">Загрузка...</div>';
  
  try {
    const resp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/participants`, {
      credentials: 'include'
    });
    
    if (!resp.ok) {
      throw new Error("Не удалось загрузить участников");
    }
    
    const data = await resp.json();
    const allParticipants = data.participants || [];
    const isOwner = data.is_owner || false;
    const isAdmin = data.is_admin || false;
    const canManageMembers = data.can_manage_members || false;
    
    // Фильтруем участников в зависимости от выбранной вкладки
    let participants = [];
    if (tabType === "admins") {
      // Показываем только админов и владельца
      participants = allParticipants.filter(p => p.is_admin || p.is_owner);
    } else {
      // Показываем всех участников
      participants = allParticipants;
    }
    
    participantsList.innerHTML = "";
    
    if (participants.length === 0) {
      const emptyMessage = tabType === "admins" 
        ? '<div class="group-participants-empty">Нет администраторов</div>'
        : '<div class="group-participants-empty">Нет участников</div>';
      participantsList.innerHTML = emptyMessage;
      return;
    }
    
    participants.forEach(participant => {
      const item = document.createElement("div");
      item.className = "group-participant-management-item";
      item.dataset.email = participant.email;
      
      const roleBadge = participant.is_owner 
        ? '<span class="group-participant-role-badge owner">Владелец</span>'
        : (participant.is_admin ? '<span class="group-participant-role-badge admin">Админ</span>' : '');
      
      // Права доступа не показываются в списке - только в модалке при нажатии на "Права доступа"
      
      item.innerHTML = `
        <div class="group-participant-management-info group-participant-clickable" data-email="${escapeHtml(participant.email)}" style="cursor: pointer;">
          <img src="${participant.profile_picture || generateAvatar(participant.name, participant.email)}" alt="${participant.name}" class="group-participant-management-avatar" />
          <div class="group-participant-management-details">
            <div class="group-participant-management-name">
              ${escapeHtml(participant.name)}
              ${participant.is_current_user ? ' <span class="group-participant-current">(Вы)</span>' : ''}
            </div>
            <div class="group-participant-management-email">${escapeHtml(participant.email)}</div>
            ${roleBadge}
          </div>
        </div>
        <div class="group-participant-management-actions">
          <!-- Убрали все кнопки - управление только через клик на участника -->
        </div>
      `;
      
      participantsList.appendChild(item);
    });
    
    // Обработчики кнопок управления
    setupParticipantsManagementHandlers(chatId, isOwner, isAdmin, "modal");
    
    // Обработчик клика на участника для открытия модалки с информацией
    participantsList.querySelectorAll(".group-participant-clickable").forEach(clickable => {
      clickable.addEventListener("click", async (e) => {
        // Не открываем модалку, если клик был на кнопку
        if (e.target.closest(".group-participant-management-actions")) {
          return;
        }
        const email = clickable.dataset.email;
        if (email) {
          await openParticipantInfoModal(chatId, email, isOwner, isAdmin);
        }
      });
    });
    
  } catch (err) {
    console.error("Ошибка загрузки участников:", err);
    participantsList.innerHTML = `<div class="group-settings-error">Ошибка загрузки участников: ${err.message}</div>`;
  }
}

// Загрузка и отображение участников группы в настройках (старая функция для совместимости)
async function loadGroupParticipantsForSettings(chatId, settings, tabType = "participants") {
  // Перенаправляем на модалку участников
  await openGroupParticipantsModal(chatId);
}

// Настройка обработчиков для управления участниками
function setupParticipantsManagementHandlers(chatId, isOwner, isAdmin, containerType = "modal") {
  const participantsList = containerType === "modal" 
    ? document.getElementById("groupParticipantsModalList")
    : document.getElementById("groupParticipantsList");
  if (!participantsList) return;
  
  // Удаление участника
  participantsList.querySelectorAll(".remove-member-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const email = btn.dataset.email;
      const participantItem = btn.closest(".group-participant-management-item");
      const participantName = participantItem?.querySelector(".group-participant-management-name")?.textContent?.trim() || email;
      
      if (!confirm(`Вы уверены, что хотите удалить ${participantName} из группы?`)) {
        return;
      }
      
      try {
        const resp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/remove_member`, {
          method: "DELETE",
          credentials: 'include',
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ member_email: email })
        });
        
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.detail || err.message || "Не удалось удалить участника");
        }
        
        // Перезагружаем список участников
        // Определяем активную вкладку
        const activeTab = document.querySelector("#groupParticipantsContent .group-participants-tab.active");
        const tabType = activeTab?.dataset.tab || "participants";
        await loadGroupParticipantsForModal(chatId, tabType);
        
        // Показываем сообщение об успехе
        const successMsg = document.createElement("div");
        successMsg.className = "group-settings-success";
        successMsg.textContent = "Участник успешно удален из группы";
        successMsg.style.position = "fixed";
        successMsg.style.top = "20px";
        successMsg.style.right = "20px";
        successMsg.style.zIndex = "10001";
        document.body.appendChild(successMsg);
        setTimeout(() => successMsg.remove(), 3000);
      } catch (err) {
        console.error("Ошибка удаления участника:", err);
        showGroupSettingsError(err.message || "Не удалось удалить участника");
      }
    });
  });
  
  // Настройка прав доступа для админа (только для владельца)
  if (isOwner) {
    participantsList.querySelectorAll(".manage-rights-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const email = btn.dataset.email;
        // Находим участника чтобы определить является ли он админом
        const participantsResp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/participants`, {
          credentials: 'include'
        });
        if (participantsResp.ok) {
          const participantsData = await participantsResp.json();
          const participant = participantsData.participants?.find(p => p.email.toLowerCase() === email.toLowerCase());
          await openParticipantRightsModal(chatId, email, participant?.is_admin || false);
        }
      });
    });
  }
  
  // Назначение админа (только для владельца)
  if (isOwner) {
    participantsList.querySelectorAll(".set-admin-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const email = btn.dataset.email;
        const participantItem = btn.closest(".group-participant-management-item");
        const participantName = participantItem?.querySelector(".group-participant-management-name")?.textContent?.trim() || email;
        
        if (!confirm(`Назначить ${participantName} администратором группы?`)) {
          return;
        }
        
        try {
          const resp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/set_admin`, {
            method: "POST",
            credentials: 'include',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ member_email: email })
          });
          
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || err.message || "Не удалось назначить админа");
          }
          
          // Перезагружаем список участников
          // Определяем активную вкладку
          const activeTab = document.querySelector("#groupParticipantsContent .group-participants-tab.active");
          const tabType = activeTab?.dataset.tab || "participants";
          await loadGroupParticipantsForModal(chatId, tabType);
          
          // Показываем сообщение об успехе
          const successMsg = document.createElement("div");
          successMsg.className = "group-settings-success";
          successMsg.textContent = "Администратор успешно назначен";
          successMsg.style.position = "fixed";
          successMsg.style.top = "20px";
          successMsg.style.right = "20px";
          successMsg.style.zIndex = "10001";
          document.body.appendChild(successMsg);
          setTimeout(() => successMsg.remove(), 3000);
        } catch (err) {
          console.error("Ошибка назначения админа:", err);
          showGroupSettingsError(err.message || "Не удалось назначить админа");
        }
      });
    });
    
    // Снятие админа (только для владельца)
    participantsList.querySelectorAll(".remove-admin-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const email = btn.dataset.email;
        const participantItem = btn.closest(".group-participant-management-item");
        const participantName = participantItem?.querySelector(".group-participant-management-name")?.textContent?.trim() || email;
        
        if (!confirm(`Снять ${participantName} с должности администратора?`)) {
          return;
        }
        
        try {
          const resp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/remove_admin`, {
            method: "DELETE",
            credentials: 'include',
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ member_email: email })
          });
          
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || err.message || "Не удалось снять админа");
          }
          
          // Перезагружаем список участников
          // Определяем активную вкладку
          const activeTab = document.querySelector("#groupParticipantsContent .group-participants-tab.active");
          const tabType = activeTab?.dataset.tab || "participants";
          await loadGroupParticipantsForModal(chatId, tabType);
          
          // Показываем сообщение об успехе
          const successMsg = document.createElement("div");
          successMsg.className = "group-settings-success";
          successMsg.textContent = "Администратор успешно снят";
          successMsg.style.position = "fixed";
          successMsg.style.top = "20px";
          successMsg.style.right = "20px";
          successMsg.style.zIndex = "10001";
          document.body.appendChild(successMsg);
          setTimeout(() => successMsg.remove(), 3000);
        } catch (err) {
          console.error("Ошибка снятия админа:", err);
          showGroupSettingsError(err.message || "Не удалось снять админа");
        }
      });
    });
  }
}

// Открытие модалки с информацией об участнике
async function openParticipantInfoModal(chatId, participantEmail, isOwner, isAdmin) {
  const participantInfoModal = document.getElementById("participantInfoModal");
  const participantInfoContent = document.getElementById("participantInfoContent");
  const participantInfoCloseBtn = document.getElementById("participantInfoCloseBtn");
  
  if (!participantInfoModal || !participantInfoContent || !chatId || !participantEmail) return;
  
  // Показываем индикатор загрузки
  participantInfoContent.innerHTML = '<div class="group-settings-loading">Загрузка...</div>';
  
  // Показываем модалку
  toggleHidden(participantInfoModal, false);
  participantInfoModal.style.display = "flex";
  participantInfoModal.style.zIndex = "10001";
  
  try {
    // Загружаем информацию об участнике
    const userResp = await fetch(`${API_BASE_URL}/api/user_profile?email=${encodeURIComponent(participantEmail)}`, {
      credentials: 'include'
    });
    
    if (!userResp.ok) {
      throw new Error("Не удалось загрузить информацию об участнике");
    }
    
    const userData = await userResp.json();
    
    // Загружаем информацию об участнике в группе
    const participantsResp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/participants`, {
      credentials: 'include'
    });
    
    if (!participantsResp.ok) {
      throw new Error("Не удалось загрузить информацию об участнике в группе");
    }
    
    const participantsData = await participantsResp.json();
    const participant = participantsData.participants?.find(p => p.email.toLowerCase() === participantEmail.toLowerCase());
    
    if (!participant) {
      throw new Error("Участник не найден");
    }
    
    const participantName = userData.full_name || userData.username || participantEmail;
    let participantAvatar = userData.profile_picture || participant.profile_picture;
    if (!participantAvatar || participantAvatar.includes("юзер.svg")) {
      participantAvatar = generateAvatar(participantName, participantEmail);
    }
    
    // Формируем HTML с информацией об участнике
    let infoHTML = `
      <div class="group-settings-item">
        <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 24px;">
          <img src="${participantAvatar}" alt="${escapeHtml(participantName)}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover;" />
          <div>
            <div style="font-size: 20px; font-weight: 600; color: var(--color-text-dark); margin-bottom: 4px;">
              ${escapeHtml(participantName)}
              ${participant.is_current_user ? ' <span style="color: var(--color-text-inactive); font-weight: normal;">(Вы)</span>' : ''}
            </div>
            <div style="font-size: 14px; color: var(--color-text-inactive); margin-bottom: 8px;">
              ${escapeHtml(participantEmail)}
            </div>
            ${participant.is_owner ? '<span class="group-participant-role-badge owner">Владелец</span>' : ''}
            ${participant.is_admin && !participant.is_owner ? '<span class="group-participant-role-badge admin">Админ</span>' : ''}
            ${!participant.is_admin && !participant.is_owner ? '<span class="group-participant-role-badge" style="background: #f3f4f6; color: #6b7280;">Участник</span>' : ''}
          </div>
        </div>
    `;
    
    // Права доступа не показываются здесь - они показываются только в модалке "Права доступа"
    
    // Если это владелец, показываем информацию о правах
    if (participant.is_owner) {
      infoHTML += `
        <div class="group-settings-item" style="margin-top: 16px;">
          <div class="group-settings-item-label" style="margin-bottom: 12px;">Права владельца:</div>
          <div class="group-participant-rights-info">
            <div class="group-participant-rights-list">
              <div style="padding: 4px 0;">✓ Все права управления группой</div>
              <div style="padding: 4px 0;">✓ Назначение и снятие администраторов</div>
              <div style="padding: 4px 0;">✓ Настройка прав доступа администраторов</div>
              <div style="padding: 4px 0;">✓ Удаление участников</div>
              <div style="padding: 4px 0;">✓ Редактирование информации группы</div>
            </div>
          </div>
        </div>
      `;
    }
    
    // Кнопки действий (только для владельца)
    if (isOwner && !participant.is_owner) {
      infoHTML += `
        <div class="group-settings-actions" style="margin-top: 24px; border-top: 1px solid var(--color-divider); padding-top: 16px;">
          <button type="button" class="group-participant-action-btn manage-rights-btn" id="participantManageRightsBtn" data-email="${escapeHtml(participantEmail)}" style="width: 100%; margin-bottom: 8px;">
            Настроить права доступа
          </button>
          ${participant.is_admin ? `
            <button type="button" class="group-participant-action-btn remove-admin-btn" id="participantRemoveAdminBtn" data-email="${escapeHtml(participantEmail)}" style="width: 100%; margin-bottom: 8px;">
              Снять с должности админа
            </button>
          ` : `
            <button type="button" class="group-participant-action-btn set-admin-btn" id="participantSetAdminBtn" data-email="${escapeHtml(participantEmail)}" style="width: 100%; margin-bottom: 8px;">
              Назначить админом
            </button>
          `}
          ${!participant.is_current_user ? `
            <button type="button" class="group-participant-action-btn remove-member-btn" id="participantRemoveBtn" data-email="${escapeHtml(participantEmail)}" style="width: 100%;">
              Удалить из группы
            </button>
          ` : ''}
        </div>
      `;
    }
    
    infoHTML += `</div>`;
    
    participantInfoContent.innerHTML = infoHTML;
    
    // Настраиваем обработчики кнопок
    if (isOwner && !participant.is_owner) {
      const manageRightsBtn = document.getElementById("participantManageRightsBtn");
      if (manageRightsBtn) {
        manageRightsBtn.addEventListener("click", () => {
          closeParticipantInfoModal();
          openParticipantRightsModal(chatId, participantEmail, participant.is_admin);
        });
      }
      
      const setAdminBtn = document.getElementById("participantSetAdminBtn");
      if (setAdminBtn) {
        setAdminBtn.addEventListener("click", async () => {
          if (!confirm(`Назначить ${participantName} администратором группы?`)) {
            return;
          }
          
          try {
            const resp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/set_admin`, {
              method: "POST",
              credentials: 'include',
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ member_email: participantEmail })
            });
            
            if (!resp.ok) {
              const err = await resp.json().catch(() => ({}));
              throw new Error(err.detail || err.message || "Не удалось назначить админа");
            }
            
            closeParticipantInfoModal();
            // Перезагружаем список участников
            const activeTab = document.querySelector("#groupParticipantsContent .group-participants-tab.active");
            const tabType = activeTab?.dataset.tab || "participants";
            await loadGroupParticipantsForModal(chatId, tabType);
            
            // Показываем сообщение об успехе
            const successMsg = document.createElement("div");
            successMsg.className = "group-settings-success";
            successMsg.textContent = "Администратор успешно назначен";
            successMsg.style.position = "fixed";
            successMsg.style.top = "20px";
            successMsg.style.right = "20px";
            successMsg.style.zIndex = "10001";
            document.body.appendChild(successMsg);
            setTimeout(() => successMsg.remove(), 3000);
          } catch (err) {
            console.error("Ошибка назначения админа:", err);
            alert(err.message || "Не удалось назначить админа");
          }
        });
      }
      
      const removeAdminBtn = document.getElementById("participantRemoveAdminBtn");
      if (removeAdminBtn) {
        removeAdminBtn.addEventListener("click", async () => {
          if (!confirm(`Снять ${participantName} с должности администратора?`)) {
            return;
          }
          
          try {
            const resp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/remove_admin`, {
              method: "DELETE",
              credentials: 'include',
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ member_email: participantEmail })
            });
            
            if (!resp.ok) {
              const err = await resp.json().catch(() => ({}));
              throw new Error(err.detail || err.message || "Не удалось снять админа");
            }
            
            closeParticipantInfoModal();
            // Перезагружаем список участников
            const activeTab = document.querySelector("#groupParticipantsContent .group-participants-tab.active");
            const tabType = activeTab?.dataset.tab || "participants";
            await loadGroupParticipantsForModal(chatId, tabType);
            
            // Показываем сообщение об успехе
            const successMsg = document.createElement("div");
            successMsg.className = "group-settings-success";
            successMsg.textContent = "Администратор успешно снят";
            successMsg.style.position = "fixed";
            successMsg.style.top = "20px";
            successMsg.style.right = "20px";
            successMsg.style.zIndex = "10001";
            document.body.appendChild(successMsg);
            setTimeout(() => successMsg.remove(), 3000);
          } catch (err) {
            console.error("Ошибка снятия админа:", err);
            alert(err.message || "Не удалось снять админа");
          }
        });
      }
      
      const removeBtn = document.getElementById("participantRemoveBtn");
      if (removeBtn) {
        removeBtn.addEventListener("click", async () => {
          if (!confirm(`Вы уверены, что хотите удалить ${participantName} из группы?`)) {
            return;
          }
          
          try {
            const resp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/remove_member`, {
              method: "DELETE",
              credentials: 'include',
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ member_email: participantEmail })
            });
            
            if (!resp.ok) {
              const err = await resp.json().catch(() => ({}));
              throw new Error(err.detail || err.message || "Не удалось удалить участника");
            }
            
            closeParticipantInfoModal();
            // Перезагружаем список участников
            const activeTab = document.querySelector("#groupParticipantsContent .group-participants-tab.active");
            const tabType = activeTab?.dataset.tab || "participants";
            await loadGroupParticipantsForModal(chatId, tabType);
            
            // Показываем сообщение об успехе
            const successMsg = document.createElement("div");
            successMsg.className = "group-settings-success";
            successMsg.textContent = "Участник успешно удален из группы";
            successMsg.style.position = "fixed";
            successMsg.style.top = "20px";
            successMsg.style.right = "20px";
            successMsg.style.zIndex = "10001";
            document.body.appendChild(successMsg);
            setTimeout(() => successMsg.remove(), 3000);
          } catch (err) {
            console.error("Ошибка удаления участника:", err);
            alert(err.message || "Не удалось удалить участника");
          }
        });
      }
    }
    
  } catch (err) {
    console.error("Ошибка загрузки информации об участнике:", err);
    participantInfoContent.innerHTML = `<div class="group-settings-error">Ошибка: ${err.message}</div>`;
  }
}

// Закрытие модалки информации об участнике
function closeParticipantInfoModal() {
  const participantInfoModal = document.getElementById("participantInfoModal");
  if (participantInfoModal) {
    toggleHidden(participantInfoModal, true);
  }
}

// Инициализация обработчиков модалки информации об участнике
function initParticipantInfoModal() {
  const participantInfoModal = document.getElementById("participantInfoModal");
  const participantInfoCloseBtn = document.getElementById("participantInfoCloseBtn");
  
  if (participantInfoCloseBtn) {
    participantInfoCloseBtn.addEventListener("click", closeParticipantInfoModal);
  }
  
  if (participantInfoModal) {
    participantInfoModal.addEventListener("click", (e) => {
      if (e.target === participantInfoModal) {
        closeParticipantInfoModal();
      }
    });
  }
}

// Инициализируем при загрузке DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initParticipantInfoModal);
} else {
  initParticipantInfoModal();
}

// Открытие модалки настройки прав участника (админа или обычного участника)
async function openParticipantRightsModal(chatId, participantEmail, isAdmin) {
  const adminRightsModal = document.getElementById("adminRightsModal");
  const adminRightsContent = document.getElementById("adminRightsContent");
  const adminRightsCloseBtn = document.getElementById("adminRightsCloseBtn");
  const adminRightsSubtitle = document.getElementById("adminRightsSubtitle");
  
  if (!adminRightsModal || !adminRightsContent || !chatId || !participantEmail) return;
  
  // Загружаем информацию об участнике
  try {
    const resp = await fetch(`${API_BASE_URL}/api/user_profile?email=${encodeURIComponent(participantEmail)}`, {
      credentials: 'include'
    });
    
    if (!resp.ok) {
      throw new Error("Не удалось загрузить информацию об участнике");
    }
    
    const participantData = await resp.json();
    const participantName = participantData.full_name || participantData.username || participantEmail;
    
    // Загружаем текущие права участника из списка участников
    let participantRights = {
      can_send_messages: true,        // Отправка сообщений
      can_send_media: true,           // Отправка медиа (фото, видео, голосовые)
      can_delete_messages: false,     // Удаление сообщений (по умолчанию false для обычных участников)
      can_manage_members: false,      // Управление участниками (только для админов)
      can_remove_members: false,      // Удаление участников (только для админов)
      can_add_members: false,         // Добавление участников (только для админов)
      can_edit_group_info: false      // Редактирование информации группы (только для админов)
    };
    
    // Если это админ, устанавливаем права по умолчанию для админа
    if (isAdmin) {
      participantRights.can_delete_messages = true;
      participantRights.can_manage_members = true;
      participantRights.can_remove_members = true;
      participantRights.can_add_members = true;
    }
    
    // Загружаем список участников для получения текущих прав
    try {
      const participantsResp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/participants`, {
        credentials: 'include'
      });
      if (participantsResp.ok) {
        const participantsData = await participantsResp.json();
        const participant = participantsData.participants?.find(p => p.email.toLowerCase() === participantEmail.toLowerCase());
        if (participant && participant.rights) {
          participantRights = participant.rights;
        }
      }
    } catch (e) {
      console.error("Ошибка загрузки прав участника:", e);
    }
    
    // Отображаем форму настроек прав
    adminRightsContent.innerHTML = `
      <div class="group-settings-item">
        <div class="group-settings-item-label" style="margin-bottom: 16px;">
          Настройка прав для: <strong>${escapeHtml(participantName)}</strong>
          ${isAdmin ? '<span class="group-participant-role-badge admin" style="margin-left: 8px;">Админ</span>' : '<span class="group-participant-role-badge" style="background: #f3f4f6; color: #6b7280; margin-left: 8px;">Участник</span>'}
        </div>
        
        <div style="margin-bottom: 16px; padding: 12px; background: #f0f9ff; border-radius: 8px; border-left: 3px solid #3b82f6;">
          <div style="font-size: 13px; color: #1e40af; font-weight: 600; margin-bottom: 4px;">Текущие права доступа:</div>
          <div style="font-size: 12px; color: #1e3a8a; line-height: 1.6;">
            ${participantRights.can_send_messages !== false ? '✓ Отправка сообщений<br/>' : '✗ Отправка сообщений<br/>'}
            ${participantRights.can_send_media !== false ? '✓ Отправка фото, видео, голосовых<br/>' : '✗ Отправка фото, видео, голосовых<br/>'}
            ${participantRights.can_delete_messages !== false ? '✓ Удаление сообщений<br/>' : '✗ Удаление сообщений<br/>'}
            ${isAdmin ? `
              ${participantRights.can_manage_members !== false ? '✓ Управление участниками группы<br/>' : '✗ Управление участниками группы<br/>'}
              ${participantRights.can_remove_members !== false ? '✓ Удаление участников из группы<br/>' : '✗ Удаление участников из группы<br/>'}
              ${participantRights.can_add_members !== false ? '✓ Добавление участников в группу<br/>' : '✗ Добавление участников в группу<br/>'}
              ${participantRights.can_edit_group_info ? '✓ Редактирование информации группы<br/>' : '✗ Редактирование информации группы<br/>'}
            ` : ''}
          </div>
        </div>
        
        <div class="group-settings-item">
          <div class="group-settings-toggle">
            <div class="group-settings-toggle-label">
              <div class="group-settings-item-label">Отправка сообщений</div>
              <div class="group-settings-item-description">
                Разрешить отправлять текстовые сообщения в группу
              </div>
            </div>
            <div 
              class="group-settings-toggle-switch ${participantRights.can_send_messages !== false ? 'active' : ''}" 
              id="rightCanSendMessages"
              data-enabled="${participantRights.can_send_messages !== false}"
            ></div>
          </div>
        </div>
        
        <div class="group-settings-item">
          <div class="group-settings-toggle">
            <div class="group-settings-toggle-label">
              <div class="group-settings-item-label">Отправка медиа</div>
              <div class="group-settings-item-description">
                Разрешить отправлять фото, видео и голосовые сообщения
              </div>
            </div>
            <div 
              class="group-settings-toggle-switch ${participantRights.can_send_media !== false ? 'active' : ''}" 
              id="rightCanSendMedia"
              data-enabled="${participantRights.can_send_media !== false}"
            ></div>
          </div>
        </div>
        
        <div class="group-settings-item">
          <div class="group-settings-toggle">
            <div class="group-settings-toggle-label">
              <div class="group-settings-item-label">Удаление сообщений</div>
              <div class="group-settings-item-description">
                Разрешить удалять сообщения в группе
              </div>
            </div>
            <div 
              class="group-settings-toggle-switch ${participantRights.can_delete_messages !== false ? 'active' : ''}" 
              id="rightCanDeleteMessages"
              data-enabled="${participantRights.can_delete_messages !== false}"
            ></div>
          </div>
        </div>
        
        ${isAdmin ? `
        <div class="group-settings-item">
          <div class="group-settings-toggle">
            <div class="group-settings-toggle-label">
              <div class="group-settings-item-label">Управление участниками</div>
              <div class="group-settings-item-description">
                Разрешить добавлять и удалять участников группы
              </div>
            </div>
            <div 
              class="group-settings-toggle-switch ${participantRights.can_manage_members !== false ? 'active' : ''}" 
              id="rightCanManageMembers"
              data-enabled="${participantRights.can_manage_members !== false}"
            ></div>
          </div>
        </div>
        
        <div class="group-settings-item">
          <div class="group-settings-toggle">
            <div class="group-settings-toggle-label">
              <div class="group-settings-item-label">Удаление участников</div>
              <div class="group-settings-item-description">
                Разрешить удалять участников из группы
              </div>
            </div>
            <div 
              class="group-settings-toggle-switch ${participantRights.can_remove_members !== false ? 'active' : ''}" 
              id="rightCanRemoveMembers"
              data-enabled="${participantRights.can_remove_members !== false}"
            ></div>
          </div>
        </div>
        
        <div class="group-settings-item">
          <div class="group-settings-toggle">
            <div class="group-settings-toggle-label">
              <div class="group-settings-item-label">Добавление участников</div>
              <div class="group-settings-item-description">
                Разрешить добавлять новых участников в группу
              </div>
            </div>
            <div 
              class="group-settings-toggle-switch ${participantRights.can_add_members !== false ? 'active' : ''}" 
              id="rightCanAddMembers"
              data-enabled="${participantRights.can_add_members !== false}"
            ></div>
          </div>
        </div>
        
        <div class="group-settings-item">
          <div class="group-settings-toggle">
            <div class="group-settings-toggle-label">
              <div class="group-settings-item-label">Редактирование информации группы</div>
              <div class="group-settings-item-description">
                Разрешить изменять название и аватар группы
              </div>
            </div>
            <div 
              class="group-settings-toggle-switch ${participantRights.can_edit_group_info ? 'active' : ''}" 
              id="rightCanEditGroupInfo"
              data-enabled="${participantRights.can_edit_group_info}"
            ></div>
          </div>
        </div>
        ` : ''}
        
        <div id="adminRightsError" class="group-settings-error hidden"></div>
        <div id="adminRightsSuccess" class="group-settings-success hidden"></div>
        
        <div class="group-settings-actions">
          <button type="button" class="secondary-btn" id="cancelAdminRights">Отмена</button>
          <button type="button" class="primary-btn" id="saveAdminRights">Сохранить</button>
        </div>
      </div>
    `;
    
    // Настраиваем обработчики переключателей
    const toggles = adminRightsContent.querySelectorAll(".group-settings-toggle-switch");
    toggles.forEach(toggle => {
      toggle.addEventListener("click", () => {
        const isEnabled = toggle.dataset.enabled === "true";
        toggle.dataset.enabled = (!isEnabled).toString();
        toggle.classList.toggle("active");
      });
    });
    
    // Обработчик сохранения
    const saveBtn = document.getElementById("saveAdminRights");
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        await saveAdminRights(chatId, participantEmail);
      });
    }
    
    // Обработчик отмены
    const cancelBtn = document.getElementById("cancelAdminRights");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        closeAdminRightsModal();
      });
    }
    
    // Показываем модалку
    toggleHidden(adminRightsModal, false);
    adminRightsModal.style.display = "flex";
    adminRightsModal.style.zIndex = "10001";
    
  } catch (err) {
    console.error("Ошибка загрузки информации об админе:", err);
    adminRightsContent.innerHTML = `<div class="group-settings-error">Ошибка: ${err.message}</div>`;
  }
}

// Сохранение прав участника
async function saveAdminRights(chatId, participantEmail) {
  const errorDiv = document.getElementById("adminRightsError");
  const successDiv = document.getElementById("adminRightsSuccess");
  
  try {
    const rights = {
      can_send_messages: document.getElementById("rightCanSendMessages")?.dataset.enabled === "true",
      can_send_media: document.getElementById("rightCanSendMedia")?.dataset.enabled === "true",
      can_delete_messages: document.getElementById("rightCanDeleteMessages")?.dataset.enabled === "true"
    };
    
    // Добавляем права админа только если они есть в форме
    const manageMembersEl = document.getElementById("rightCanManageMembers");
    if (manageMembersEl) {
      rights.can_manage_members = manageMembersEl.dataset.enabled === "true";
      rights.can_remove_members = document.getElementById("rightCanRemoveMembers")?.dataset.enabled === "true";
      rights.can_add_members = document.getElementById("rightCanAddMembers")?.dataset.enabled === "true";
      rights.can_edit_group_info = document.getElementById("rightCanEditGroupInfo")?.dataset.enabled === "true";
    }
    
    // Отправляем на сервер (используем API для прав участника)
    const resp = await fetch(`${API_BASE_URL}/api/groups/${chatId}/participant_rights`, {
      method: "PUT",
      credentials: 'include',
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participant_email: participantEmail,
        rights: rights
      })
    });
    
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || err.message || "Не удалось сохранить права доступа");
    }
    
    // Показываем успех
    if (successDiv) {
      successDiv.textContent = "Права доступа успешно сохранены";
      toggleHidden(successDiv, false);
    }
    if (errorDiv) {
      toggleHidden(errorDiv, true);
    }
    
    // Закрываем модалку через секунду
    setTimeout(() => {
      closeAdminRightsModal();
      // Перезагружаем список участников
      const activeTab = document.querySelector("#groupParticipantsContent .group-participants-tab.active");
      const tabType = activeTab?.dataset.tab || "participants";
      loadGroupParticipantsForModal(chatId, tabType);
    }, 1000);
    
  } catch (err) {
    console.error("Ошибка сохранения прав админа:", err);
    if (errorDiv) {
      errorDiv.textContent = err.message || "Не удалось сохранить права доступа";
      toggleHidden(errorDiv, false);
    }
    if (successDiv) {
      toggleHidden(successDiv, true);
    }
  }
}

// Закрытие модалки прав админа
function closeAdminRightsModal() {
  const adminRightsModal = document.getElementById("adminRightsModal");
  if (adminRightsModal) {
    toggleHidden(adminRightsModal, true);
  }
}

// Инициализация обработчиков модалки прав админа
function initAdminRightsModal() {
  const adminRightsModal = document.getElementById("adminRightsModal");
  const adminRightsCloseBtn = document.getElementById("adminRightsCloseBtn");
  
  if (adminRightsCloseBtn) {
    adminRightsCloseBtn.addEventListener("click", closeAdminRightsModal);
  }
  
  if (adminRightsModal) {
    adminRightsModal.addEventListener("click", (e) => {
      if (e.target === adminRightsModal) {
        closeAdminRightsModal();
      }
    });
  }
}

// Инициализируем при загрузке DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdminRightsModal);
} else {
  initAdminRightsModal();
}

// Экспортируем функции для использования в других модулях
window.loadGroups = loadGroups;
window.openGroupChat = openGroupChat;
window.renderGroupMessage = renderGroupMessage;
window.openGroupProfile = openGroupProfile;
window.openGroupSettings = openGroupSettings;
window.openGroupParticipantsModal = openGroupParticipantsModal;
