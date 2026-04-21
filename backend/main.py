from fastapi import FastAPI, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta
import os
from pathlib import Path
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware

# ── Пути ─────────────────────────────────────────────
# Определяем пути в самом начале
BACKEND_DIR = Path(__file__).resolve().parent          # .../Flicker/backend
PROJECT_ROOT = BACKEND_DIR.parent                     # .../Flicker

# ── Загрузка .env ────────────────────────────────────
# Загружаем .env из корня проекта, используя абсолютный путь
dotenv_path = PROJECT_ROOT / ".env"
load_dotenv(dotenv_path)
print(f"Загрузка .env из: {dotenv_path}, существует: {dotenv_path.exists()}")


# ── ИЗМЕНЕНИЕ CWD ДЛЯ ШАБЛОНОВ ───────────────────────
# ВАЖНО: Новый auth.py использует Jinja2Templates(directory="auth").
# Это относительный путь. Мы предполагаем, что шаблоны (auth.html) 
# находятся в PROJECT_ROOT / "frontend" / "auth".
# Чтобы Jinja2 нашел папку "auth", мы меняем CWD на "frontend".

FRONTEND_DIR = PROJECT_ROOT / "frontend"
print(f"Проверка {FRONTEND_DIR}, существует: {FRONTEND_DIR.exists()}")
if FRONTEND_DIR.exists():
    os.chdir(FRONTEND_DIR)
    print(f"Рабочая директория изменена на: {os.getcwd()} (для Jinja2)")
else:
    print(f"ВНИМАНИЕ: Не найдена папка {FRONTEND_DIR}. Шаблоны Jinja2 (auth.html) могут не загрузиться.")

# ── Импорты, зависящие от CWD ────────────────────────
# Теперь, когда CWD = .../frontend, импорт auth.py
# успешно создаст Jinja2Templates(directory="auth")
from backend.routes import auth, users, chats, bots, calls, emojis
import backend.db.database as db_module
from backend.dependencies import get_current_user

# ── Шаблоны для чатов ────────────────────────────────
# Импортируем chats_templates из chats.py, где уже настроены все фильтры
from backend.routes.chats import chats_templates

# -----------------------------------------------------

# Цвета для аватаров с инициалами
AVATAR_COLORS = [
    "#FFADAD", "#FFD6A5", "#FDFFB6", "#CAFFBF", "#9BF6FF", "#A0C4FF", "#BDB2FF", "#FFC6FF",
    "#E57373", "#F06292", "#BA68C8", "#9575CD", "#7986CB", "#64B5F6", "#4FC3F7", "#4DD0E1",
    "#4DB6AC", "#81C784", "#AED581", "#DCE775", "#FFD54F", "#FFB74D", "#FF8A65", "#A1887F",
    "#F48FB1", "#CE93D8", "#B39DDB", "#9FA8DA", "#90CAF9", "#81D4FA", "#80DEEA", "#80CBC4"
]

def get_avatar_color(text: str) -> str:
    """Генерирует цвет на основе текста (email, имя и т.д.)"""
    if not text:
        return AVATAR_COLORS[0]
    
    # Простой хэш для определения цвета
    hash_val = 0
    for char in text:
        hash_val = ord(char) + ((hash_val << 5) - hash_val)
    
    index = abs(hash_val) % len(AVATAR_COLORS)
    return AVATAR_COLORS[index]

def generate_avatar_url(name: str, identifier: str, size: int = 100) -> str:
    """
    Генерирует SVG аватар с инициалами.
    """
    try:
        if name is None:
            name = "?"
        name = str(name)
        
        if identifier is None:
            identifier = name
        identifier = str(identifier)

        if not name.strip():
            name = "?"
        
        display_name = name.strip()
        initial = display_name[0].upper()
        color = get_avatar_color(identifier)
        
        # Создаем SVG
        svg = f'''
        <svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
            <rect width="{size}" height="{size}" fill="{color}" />
            <text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#FFFFFF" 
                  font-family="Arial, sans-serif" font-size="{size * 0.5}px" font-weight="bold">{initial}</text>
        </svg>
        '''
        
        # Кодируем в base64
        import base64
        svg_bytes = svg.encode('utf-8')
        base64_bytes = base64.b64encode(svg_bytes)
        base64_string = base64_bytes.decode('ascii')
        
        return f"data:image/svg+xml;base64,{base64_string}"
    except Exception as e:
        print(f"Error generating avatar: {e}")
        return "/images/юзер.svg"

# Добавляем функцию генерации аватаров в глобальное пространство имен Jinja
chats_templates.env.globals['generate_avatar'] = generate_avatar_url

app = FastAPI(
    title="Flicker Messenger API",
    description="API для веб-мессенджера Flicker, включая регистрацию, аутентификацию и чаты.",
    version="1.0.0",
)

# ── Отладочная информация ────────────────────────────
print("=" * 50)
print("ПРОВЕРКА СТАТИЧЕСКИХ ПУТЕЙ:")
print(f"PROJECT_ROOT: {PROJECT_ROOT}")
# Рабочая директория теперь должна быть .../frontend
print(f"Текущая рабочая директория: {os.getcwd()}") 

# ── CORS и базовые security-заголовки ────────────────
allowed_origins_env = os.getenv("CORS_ORIGINS", "")
if allowed_origins_env:
    allowed_origins = [origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()]
else:
    allowed_origins = []

if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Добавляем сжатие ответов для оптимизации производительности
app.add_middleware(GZipMiddleware, minimum_size=1000)  # Сжимаем ответы больше 1KB


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("X-XSS-Protection", "1; mode=block")
    # HSTS имеет смысл только за reverse-proxy c HTTPS
    if os.getenv("ENABLE_HSTS", "").lower() == "true":
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=63072000; includeSubDomains; preload",
        )
    return response

# ── Статика для аутентификации ───────────────────────
# Используем PROJECT_ROOT (абсолютный путь), CWD не влияет
auth_static = PROJECT_ROOT / "frontend" / "auth" 
print(f"Auth static dir: {auth_static}, exists: {auth_static.exists()}")
if auth_static.exists():
    print("Файлы в auth static:")
    for file in auth_static.iterdir():
        print(f"  - {file.name}")
    # ВАЖНО: StaticFiles(directory=...) должен быть АБСОЛЮТНЫМ путем
    app.mount("/auth_static", StaticFiles(directory=str(auth_static)), name="auth_static")

# ── Статика для чатов ────────────────────────────────
chats_static = PROJECT_ROOT / "frontend" / "chats"
print(f"Chats static dir: {chats_static}, exists: {chats_static.exists()}")
if chats_static.exists():
    print("Файлы в chats static:")
    for file in chats_static.iterdir():
        print(f"  - {file.name}")
    app.mount("/chats_static", StaticFiles(directory=str(chats_static)), name="chats_static")

# ── Картинки ─────────────────────────────────────────
images_dir = PROJECT_ROOT / "images"
print(f"Images dir: {images_dir}, exists: {images_dir.exists()}")
if images_dir.exists():
    print("Файлы в images:")
    for file in images_dir.iterdir():
        print(f"  - {file.name}")
    app.mount("/images", StaticFiles(directory=str(images_dir)), name="images")

# ── Общая статика (favicon и др.) ────────────────────
static_dir = PROJECT_ROOT / "static"
print(f"Static dir: {static_dir}, exists: {static_dir.exists()}")
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

print("=" * 50)

# ── Папка для загрузок ───────────────────────────────
UPLOAD_FOLDER = images_dir / "avatars"
UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)

# ── События приложения ───────────────────────────────
@app.on_event("startup")
async def startup_event():
    print("Приложение запускается: Подключение к базе данных...")
    await db_module.connect_db()
    print("Подключение к базе данных установлено.")
    # Создание индексов для оптимизации производительности
    from backend.db import indexes
    await indexes.ensure_indexes()

@app.on_event("shutdown")
async def shutdown_event():
    print("Приложение завершает работу: Закрытие подключения к базе данных...")
    await db_module.close_db()
    print("Подключение к базе данных закрыто.")

# ── Маршруты ─────────────────────────────────────────
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(chats.router)
app.include_router(bots.router)
app.include_router(calls.router)
app.include_router(emojis.router)

# ИЗМЕНЕНО: Главная страница теперь показывает чаты напрямую (без /chats)
@app.get("/", response_class=HTMLResponse, summary="Главная страница (чаты или аутентификация)")
@app.get("/{initial_slug}", response_class=HTMLResponse, summary="Главная страница с конкретным чатом")
async def read_root(request: Request, initial_slug: Optional[str] = None, search_query: Optional[str] = None):
    """
    Если пользователь авторизован - показываем страницу чатов.
    Иначе перенаправляем на страницу аутентификации.
    """
    try:
        current_user = await get_current_user(request)
    except Exception:
        # Если токена нет или он невалидный — показываем страницу регистрации/логина
        return RedirectResponse(url="/auth_page?tab=register", status_code=status.HTTP_303_SEE_OTHER)
    
    # Пользователь авторизован - показываем страницу чатов
    users_collection = db_module.get_users_collection()
    chats_collection = db_module.get_chats_collection()
    user_data: Optional[Dict[str, Any]] = await users_collection.find_one({"email": current_user["email"]})
    if not user_data:
        return RedirectResponse(url="/auth_page?tab=register", status_code=status.HTTP_303_SEE_OTHER)

    contacts = user_data.get("contacts", []) or []
    contact_map = {}
    for contact in contacts:
        c_email = contact.get("email")
        if not c_email:
            continue
        display_name = contact.get("display_name") or " ".join(
            part for part in [contact.get("first_name"), contact.get("last_name")] if part
        ).strip()
        contact_map[c_email] = display_name

    found_users: List[Dict[str, Any]] = []
    if search_query and len(search_query.strip()) >= 1:
        search_term = search_query.strip()
        found_users = await users_collection.find({
            "$and": [
                {"$or": [{"username": {"$regex": search_term, "$options": "i"}}, {"email": {"$regex": search_term, "$options": "i"}}, {"full_name": {"$regex": search_term, "$options": "i"}}]},
                {"email": {"$ne": current_user["email"]}}
            ]},
        {"username": 1, "email": 1, "full_name": 1, "_id": 0, "profile_picture": 1}
        ).to_list(100)
        found_users = [
            {"username": user.get("username"), "email": user.get("email"), "full_name": user.get("full_name", user.get("username")), "profile_picture": user.get("profile_picture", "/images/юзер.svg")}
            for user in found_users
        ]

    # === ГАРАНТИРУЕМ НАЛИЧИЕ ЧАТА "ИЗБРАННОЕ" ДЛЯ ПОЛЬЗОВАТЕЛЯ ===
    favorite_chat: Optional[Dict[str, Any]] = await chats_collection.find_one(
        {"participants": [current_user["email"]], "chat_type": "favorite"}
    )
    if not favorite_chat:
        favorite_doc = {
            "participants": [current_user["email"]],
            "messages": [],
            "created_at": datetime.utcnow(),
            "last_message_at": datetime.utcnow(),
            "chat_type": "favorite",
            "unread_count": {},
        }
        insert_result = await chats_collection.insert_one(favorite_doc)
        favorite_chat = {**favorite_doc, "_id": insert_result.inserted_id}

    user_chats_raw: List[Dict[str, Any]] = await chats_collection.find(
        {"participants": current_user["email"]}
    ).sort("last_message_at", -1).to_list(100)
    
    # === ОПТИМИЗАЦИЯ: Batch-запрос пользователей вместо N+1 ===
    # Собираем все email'ы участников из всех чатов
    all_participant_emails = set()
    group_sender_emails = set()  # Email'ы отправителей последних сообщений в группах
    
    for chat_doc in user_chats_raw:
        chat_type = chat_doc.get("chat_type", "private")
        is_group = chat_type == "group" or len(chat_doc["participants"]) > 2
        
        # Добавляем участников чата
        for p in chat_doc.get("participants", []):
            if p != current_user["email"]:
                all_participant_emails.add(p)
        
        # Для групповых чатов добавляем email отправителя последнего сообщения
        if is_group:
            filtered_messages = [msg for msg in chat_doc.get("messages", []) if current_user["email"] not in msg.get("deleted_for_users", [])]
            if filtered_messages:
                last_msg = filtered_messages[-1]
                sender_email = last_msg.get("sender_id") or last_msg.get("sender_email")
                if sender_email and sender_email != current_user["email"]:
                    group_sender_emails.add(sender_email)
    
    # Один batch-запрос для всех пользователей
    all_user_emails = list(all_participant_emails | group_sender_emails)
    users_batch = {}
    if all_user_emails:
        users_cursor = users_collection.find(
            {"email": {"$in": all_user_emails}},
            {
                "username": 1,
                "full_name": 1,
                "profile_picture": 1,
                "email": 1,
                "last_seen": 1,
                "privacy_settings": 1,
                "blocked_users": 1,
                "_id": 0,
            }
        )
        async for user_doc in users_cursor:
            email = user_doc.get("email")
            if email:
                users_batch[email] = user_doc
    
    # Получаем contacts текущего пользователя один раз
    current_user_doc = await users_collection.find_one(
        {"email": current_user["email"]},
        {"contacts": 1}
    )
    current_user_contacts = []
    if current_user_doc:
        current_user_contacts = current_user_doc.get("contacts", [])
    current_user_contact_emails = {c.get("email") for c in current_user_contacts if c.get("email")}
    
    formatted_user_chats: List[Dict[str, Any]] = []
    manager = chats.manager  # Импортируем manager из chats
    
    for chat_doc in user_chats_raw:
        chat_type = chat_doc.get("chat_type", "private")
        is_group = chat_type == "group" or len(chat_doc["participants"]) > 2
        other_participant_email = next((p for p in chat_doc["participants"] if p != current_user["email"]), None)
        filtered_messages = [msg for msg in chat_doc.get("messages", []) if current_user["email"] not in msg.get("deleted_for_users", [])]

        last_message = filtered_messages[-1] if filtered_messages else None

        if last_message is not None:
            last_timestamp = last_message.get("timestamp") or chat_doc.get("last_message_at")
        else:
            last_timestamp = chat_doc.get("created_at", datetime.min)

        # Формируем человекочитаемое превью последнего сообщения
        last_message_content = None
        if last_message:
            msg_type = last_message.get("type") or "text"
            if msg_type == "audio":
                last_message_content = "Голосовое сообщение"
            elif msg_type == "image":
                last_message_content = "Фотография"
            elif msg_type == "video":
                last_message_content = "Видео"
            elif msg_type == "file":
                last_message_content = last_message.get("filename") or "Файл"
            else:
                last_message_content = last_message.get("content") or None

        chat_info: Dict[str, Any] = {
            "chat_id": str(chat_doc["_id"]),
            "last_message_timestamp": last_timestamp,
            "last_message_content": last_message_content,
            "created_at": chat_doc.get("created_at", datetime.min),
            "interlocutor_email": other_participant_email,
            "is_group": is_group,
            "last_message_status": None,
            "is_online": False,
            "last_seen": None,
            "interlocutor_username": None,
            "is_favorite": False,
        }
        
        if last_message and last_message.get("sender_id") == current_user["email"]:
            read_by_others = any(email != current_user["email"] for email in last_message.get("read_by", []))
            if read_by_others:
                chat_info["last_message_status"] = "read"
            else:
                chat_info["last_message_status"] = "sent"

                # === ИСПРАВЛЕНИЕ: Ищем счетчик с экранированными точками ===
        unread_counts = chat_doc.get("unread_count", {})
        actual_count = 0
        safe_current_email = current_user["email"].replace(".", "_dot_").lower()
        for k, v in unread_counts.items():
            if k.lower() == safe_current_email:
                actual_count = v
                break
        chat_info["unread_count"] = actual_count

        # === ОБРАБОТКА ТИПОВ ЧАТОВ (боты, избранное, группы, обычные) ===
        chat_type = chat_doc.get("chat_type", "private")
        is_bot_chat = chat_type == "bot"
        bot_id = chat_doc.get("bot_id")
        
        if chat_type == "group":
            # Групповой чат
            chat_info["chat_title"] = chat_doc.get("group_name", "Группа")
            chat_info["chat_avatar"] = chat_doc.get("group_avatar", "/images/юзер.svg")
            chat_info["is_bot"] = False
            chat_info["is_group"] = True
            chat_info["group_name"] = chat_doc.get("group_name", "Группа")
            chat_info["group_avatar"] = chat_doc.get("group_avatar", "/images/юзер.svg")
            chat_info["group_owner"] = chat_doc.get("owner")
            # Для групповых чатов формируем превью последнего сообщения с ником отправителя
            if last_message:
                sender_email = last_message.get("sender_id") or last_message.get("sender_email")
                if sender_email and sender_email != current_user["email"]:
                    # Используем данные из batch-запроса вместо отдельного find_one
                    sender_user = users_batch.get(sender_email)
                    if sender_user:
                        sender_name = sender_user.get("full_name") or sender_user.get("username") or sender_email
                        if last_message_content and msg_type == "text":
                            last_message_content = f"{sender_name}: {last_message_content}"
        elif is_bot_chat and bot_id:
            from backend.routes.bots import AVAILABLE_BOTS
            bot = next((b for b in AVAILABLE_BOTS if b["bot_id"] == bot_id), None)
            if bot:
                chat_info["chat_title"] = bot["name"]
                chat_info["chat_avatar"] = bot["avatar"]
                chat_info["is_bot"] = True
                chat_info["is_online"] = False
                chat_info["last_seen"] = "bot"
            else:
                chat_info["chat_title"] = "Бот"
                chat_info["chat_avatar"] = "/images/юзер.svg"
                chat_info["is_bot"] = True
                chat_info["is_online"] = False
                chat_info["last_seen"] = "bot"
                chat_info["interlocutor_username"] = None
        elif chat_type == "favorite":
            chat_info["chat_title"] = "Избранное"
            chat_info["chat_avatar"] = "/images/avatars/favorit.png"
            chat_info["is_bot"] = False
            chat_info["is_favorite"] = True
            chat_info["interlocutor_email"] = current_user["email"]
            chat_info["interlocutor_username"] = None
        elif not is_group and other_participant_email:
            # Используем данные из batch-запроса вместо отдельного find_one
            other_user_data: Optional[Dict[str, Any]] = users_batch.get(other_participant_email)
            
            # Проверяем настройки конфиденциальности перед установкой is_online
            # is_online будет установлен только если last_seen виден
            privacy_settings = other_user_data.get("privacy_settings", {}) if other_user_data else {}
            last_seen_visibility = privacy_settings.get("last_seen_visibility", "everyone")
            
            # Устанавливаем is_online только если статус виден
            if last_seen_visibility == "nobody":
                chat_info["is_online"] = False
            elif last_seen_visibility == "contacts":
                # Используем уже загруженные контакты
                if other_participant_email in current_user_contact_emails:
                    chat_info["is_online"] = other_participant_email in manager.active_connections
                else:
                    chat_info["is_online"] = False
            else:  # everyone
                chat_info["is_online"] = other_participant_email in manager.active_connections

            if other_user_data:
                # Проверяем, заблокировал ли собеседник текущего пользователя
                blocked_users = other_user_data.get("blocked_users", []) or []
                viewer_is_blocked = current_user["email"] in blocked_users

                contact_display_name = contact_map.get(other_participant_email)
                chat_title = contact_display_name or other_user_data.get("full_name", other_user_data.get("username", "Неизвестный пользователь"))
                chat_info["contact_display_name"] = contact_display_name
                chat_info["chat_title"] = chat_title
                
                # Проверяем настройки конфиденциальности для profile_picture
                privacy_settings = other_user_data.get("privacy_settings", {})
                profile_photo_visibility = privacy_settings.get("profile_photo_visibility", "everyone")
                can_see_profile_photo = True
                
                # Инициализируем current_user_doc для использования в обоих блоках
                current_user_doc = None
                
                if profile_photo_visibility == "nobody":
                    can_see_profile_photo = False
                elif profile_photo_visibility == "contacts":
                    # Используем уже загруженные контакты
                    can_see_profile_photo = other_participant_email in current_user_contact_emails
                
                if viewer_is_blocked:
                    # Если собеседник заблокировал нас, всегда показываем дефолтный аватар
                    chat_info["chat_avatar"] = "/images/юзер.svg"
                elif can_see_profile_photo:
                    chat_info["chat_avatar"] = other_user_data.get("profile_picture", "/images/юзер.svg")
                else:
                    chat_info["chat_avatar"] = "/images/юзер.svg"
                
                chat_info["interlocutor_username"] = other_user_data.get("username")
                
                # Проверяем настройки конфиденциальности для last_seen
                last_seen_visibility = privacy_settings.get("last_seen_visibility", "everyone")
                can_see_last_seen = True

                if viewer_is_blocked:
                    # Если нас заблокировали, всегда показываем "давно не был(а) в сети"
                    fake_last_seen = datetime.utcnow() - timedelta(days=30)
                    chat_info["last_seen"] = fake_last_seen.isoformat() + "Z"
                    chat_info["is_online"] = False
                else:
                    if last_seen_visibility == "nobody":
                        can_see_last_seen = False
                    elif last_seen_visibility == "contacts":
                        # Используем уже загруженные контакты
                        can_see_last_seen = other_participant_email in current_user_contact_emails
                    
                    if can_see_last_seen:
                        last_seen_data = other_user_data.get("last_seen")
                        if isinstance(last_seen_data, datetime):
                            chat_info["last_seen"] = last_seen_data.isoformat() + "Z"
                        elif last_seen_data == "online":
                            if not chat_info["is_online"]:
                                chat_info["last_seen"] = None 
                            else:
                                chat_info["last_seen"] = "online"
                        else:
                            chat_info["last_seen"] = None
                    else:
                        chat_info["last_seen"] = None
            else:
                chat_info["chat_title"] = "Неизвестный пользователь"
                chat_info["chat_avatar"] = "/images/юзер.svg"
        else:
            chat_info["chat_title"] = "Общий чат"
            chat_info["chat_avatar"] = "/images/юзер.svg"

        # === Флаг блокировки для списка чатов: текущий пользователь заблокировал собеседника ===
        blocked_list = chat_doc.get("blocked", [])
        current_email = current_user["email"]
        chat_info["is_blocked"] = any(
            b.get("blocker") == current_email and b.get("blocked") == other_participant_email
            for b in blocked_list
        ) if (not is_group and other_participant_email) else False
        
        formatted_user_chats.append(chat_info)

    formatted_user_chats.sort(key=lambda x: x.get("last_message_timestamp", x.get("created_at", datetime.min)), reverse=True)

    # Нормализуем путь к аватару пользователя для шаблона
    raw_avatar = user_data.get("profile_picture")
    if not raw_avatar:
        user_avatar_url = "/images/юзер.svg"
    else:
        avatar_str = str(raw_avatar).strip()
        if avatar_str.startswith("http://") or avatar_str.startswith("https://") or avatar_str.startswith("/"):
            user_avatar_url = avatar_str
        else:
            # В БД может быть только имя файла — добавляем /static/uploads/
            user_avatar_url = f"/static/uploads/{avatar_str}"

    template_data: Dict[str, Any] = {
        "request": request,
        "generate_avatar": generate_avatar_url,
        "user_data": user_data,
        "username": user_data.get("username", "Пользователь"),
        "user_email": user_data.get("email", ""),
        "user_id": str(user_data.get("_id")),
        "user_profile_picture": user_avatar_url,
        "search_results": found_users,
        "current_search_query": search_query,
        "user_chats": formatted_user_chats,
        "initial_chat_slug": initial_slug,
        "contacts_count": len(contact_map),
    }
    return chats_templates.TemplateResponse("chats.html", template_data)


# Роут для коротких ссылок на чаты теперь обрабатывается в read_root через initial_slug
@app.get("/welcome", response_class=HTMLResponse, summary="Приветственная страница после входа")
async def welcome_page():
    return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)

@app.get("/contacts", response_class=HTMLResponse, summary="Страница контактов")
async def contacts_page(request: Request):
    """
    Отдельная страница для контактов, открываемая в новом окне.
    """
    try:
        current_user = await get_current_user(request)
    except Exception:
        # Если токена нет или он невалидный — перенаправляем на страницу аутентификации
        return RedirectResponse(url="/auth_page?tab=register", status_code=status.HTTP_303_SEE_OTHER)
    
    # Пользователь авторизован - показываем страницу контактов
    users_collection = db_module.get_users_collection()
    user_data: Optional[Dict[str, Any]] = await users_collection.find_one({"email": current_user["email"]})
    if not user_data:
        return RedirectResponse(url="/auth_page?tab=register", status_code=status.HTTP_303_SEE_OTHER)

    # Нормализуем путь к аватару пользователя для шаблона
    raw_avatar = user_data.get("profile_picture")
    if not raw_avatar:
        user_avatar_url = "/images/юзер.svg"
    else:
        avatar_str = str(raw_avatar).strip()
        if avatar_str.startswith("http://") or avatar_str.startswith("https://") or avatar_str.startswith("/"):
            user_avatar_url = avatar_str
        else:
            user_avatar_url = f"/static/uploads/{avatar_str}"

    template_data: Dict[str, Any] = {
        "request": request,
        "username": user_data.get("username", "Пользователь"),
        "user_email": user_data.get("email", ""),
        "user_id": str(user_data.get("_id")),
        "user_profile_picture": user_avatar_url,
    }
    return chats_templates.TemplateResponse("contacts.html", template_data)

@app.get("/favicon.ico")
async def favicon():
    favicon_path = PROJECT_ROOT / "static" / "favicon.ico"
    if favicon_path.exists():
        return FileResponse(favicon_path)
    return ""
