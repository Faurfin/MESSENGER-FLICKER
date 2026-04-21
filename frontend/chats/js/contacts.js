// ===========================
// === Contacts Page Script ===
// ===========================

import { generateAvatar } from "./modules/avatar.js";

const API_BASE_URL = window.location.origin;

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

const toggleHidden = (el, hidden) => {
  if (!el) return;
  if (hidden) {
    el.classList.add("hidden");
  } else {
    el.classList.remove("hidden");
  }
};

const defaultContactsEmptyText =
  (contactsEmpty && contactsEmpty.textContent) || "Пока нет контактов";

function formatContactStatus(lastSeen, isOnline) {
  // Если lastSeen равен null или undefined (скрыт настройками конфиденциальности)
  if (lastSeen === null || lastSeen === undefined || lastSeen === "") {
    return ""; // Не показываем статус, если он скрыт
  }

  if (isOnline) {
    return "В сети";
  }

  // Иногда backend может прислать строку "online"
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
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffMs / (1000 * 60));
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);
    const diffMonth = Math.floor(diffDay / 30);
    const diffYear = Math.floor(diffDay / 365);
    
    if (diffSec < 60) return "Только что";
    if (diffMin < 60) return `Был(а) ${diffMin} мин. назад`;
    if (diffHour < 24) return `Был(а) ${diffHour} ч. назад`;
    if (diffDay === 1) {
      const timeStr = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      return `Был(а) вчера в ${timeStr}`;
    }
    if (diffDay < 7) return `Был(а) ${diffDay} дн. назад`;
    if (diffWeek < 4) return `Был(а) ${diffWeek} нед. назад`;
    if (diffMonth < 12) return `Был(а) ${diffMonth} мес. назад`;
    if (diffYear > 0) return `Был(а) ${diffYear} г. назад`;
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (e) {
    return typeof lastSeen === "string" ? lastSeen : "";
  }
}

function renderContactsList(contacts = []) {
  if (!contactsList) return;
  contactsList.innerHTML = "";

  if (!contacts || contacts.length === 0) {
    if (contactsEmpty) contactsEmpty.textContent = defaultContactsEmptyText;
    toggleHidden(contactsEmpty, false);
    return;
  }
  toggleHidden(contactsEmpty, true);

  contacts.forEach((c) => {
    const displayName =
      c.display_name || c.full_name || c.username || c.email || "Контакт";
    const metaText = `${displayName} ${c.email || ""} ${
      c.username || ""
    }`.toLowerCase();
    
    const isOnline = c.is_online || false;
    const lastSeen = c.last_seen;
    const status = formatContactStatus(lastSeen, isOnline);
    const statusClass = isOnline ? "online" : "";

    const li = document.createElement("li");
    li.className = "contact-card";
    li.dataset.filterText = metaText;
    li.dataset.email = c.email || "";
    li.dataset.username = c.username || "";
    li.dataset.displayName = displayName;
    const avatar = (c.profile_picture && !c.profile_picture.includes("юзер.svg")) ? c.profile_picture : generateAvatar(displayName, c.email);
    li.innerHTML = `
      <div class="contact-avatar">
        <img src="${avatar}" alt="${displayName}" />
        ${isOnline ? '<div class="contact-online-dot"></div>' : ''}
      </div>
      <div class="contact-info">
        <div class="contact-name">
          ${displayName}
          ${c.is_favorite ? '<span class="contact-name-star">⭐</span>' : ''}
        </div>
        <div class="contact-status ${statusClass}">${status}</div>
      </div>
    `;

    // Клик по контакту — открываем чат с ним на странице чатов
    li.addEventListener("click", () => {
      const chatsBtn = document.getElementById("chatsButton");
      if (chatsBtn) {
        chatsBtn.click();
      }
      setTimeout(() => {
        if (typeof startChatWithUser === "function" && c.email) {
          startChatWithUser(c.email, displayName, c.username || "");
        }
      }, 0);
    });

    contactsList.appendChild(li);
  });
}

// === 1. ПРАВИЛЬНАЯ ФУНКЦИЯ ЗАГРУЗКИ КОНТАКТОВ ===
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

// === 2. ПРАВИЛЬНЫЙ ОБРАБОТЧИК ДОБАВЛЕНИЯ КОНТАКТА ===
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

      const data = await resp.json();
      closeAddContactModal();
      await loadContacts(); // Теперь это сработает!

      // Кричим на всё приложение, что контакт добавлен, чтобы обновить списки чатов мгновенно!
      if (data && data.contact) {
        window.dispatchEvent(new CustomEvent('contactAdded', {detail: data.contact}));
      }

    } catch (err) {
      console.error("Ошибка добавления контакта:", err);
      showAddContactError("Произошла ошибка, попробуйте еще раз");
    }
  });
}

// Invite Link Handler (Standalone Contacts Page)
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
      const originalText = contactsInviteLinkBtn.textContent;
      contactsInviteLinkBtn.textContent = "Ссылка скопирована!";
      contactsInviteLinkBtn.classList.add("copied");
      
      setTimeout(() => {
        contactsInviteLinkBtn.textContent = originalText;
        contactsInviteLinkBtn.classList.remove("copied");
      }, 2000);
    });
  });
}

function openAddContactModal() {
  if (!addContactModal) return;
  toggleHidden(addContactModal, false);
  if (addContactError) toggleHidden(addContactError, true);
  if (contactFirstNameInput) contactFirstNameInput.focus();
}

function closeAddContactModal() {
  toggleHidden(addContactModal, true);
  if (addContactForm) addContactForm.reset();
  if (addContactError) toggleHidden(addContactError, true);
}

function showAddContactError(message) {
  if (!addContactError) return;
  addContactError.textContent = message;
  toggleHidden(addContactError, false);
}

// Event listeners
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

// Close modal on backdrop click
if (addContactModal) {
  addContactModal.addEventListener("click", (e) => {
    if (e.target === addContactModal) {
      closeAddContactModal();
    }
  });
}

// Load contacts on page load
loadContacts();

