from fastapi import APIRouter, Depends, Form, HTTPException, status, Request, UploadFile, File
from fastapi.responses import JSONResponse
from typing import Annotated, Optional, Dict, Any, List
from datetime import datetime, timedelta
import re
import shutil
import os
from pathlib import Path
from bson import ObjectId
from pydantic import BaseModel

import backend.db.database as db_module
from backend.dependencies import get_current_user
from backend.auth.auth_utils import hash_password, verify_password

# Абсолютные пути для сохранения аватаров, чтобы они открывались по /images/avatars/...
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # корень проекта
IMAGES_DIR = BASE_DIR / "images"
AVATARS_DIR = IMAGES_DIR / "avatars"
AVATARS_DIR.mkdir(parents=True, exist_ok=True)

# Файловый путь и URL-префикс
UPLOAD_FOLDER_FS = AVATARS_DIR                # куда пишем файл на диске
UPLOAD_FOLDER_URL_PREFIX = "/images/avatars"  # откуда его раздаёт StaticFiles в main.py

router = APIRouter(
    tags=["Users"],
)
class BlockRequest(BaseModel):
    user_id: str   # email собеседника
    chat_id: str   # id чата (ObjectId в строке)

# --- Запросы контактов ---
class AddContactRequest(BaseModel):
    email: str
    first_name: str
    last_name: Optional[str] = None
def _normalize_contact_email(raw_email: Optional[str]) -> str:
    """
    Relaxed email validator: we allow short aliases like 'i@i' that exist in test data,
    but still require the '@' symbol and non-empty parts around it.
    """
    email = (raw_email or "").strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Укажите корректную почту контакта.")
    local, domain, *_ = email.split("@") + [""]
    if not local or not domain:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Укажите корректную почту контакта.")
    return email


async def check_privacy_access(
    target_user_email: str,
    viewer_email: str,
    privacy_type: str,  # "last_seen" or "profile_photo"
    users_collection
) -> bool:
    """
    Проверяет, может ли viewer_email видеть privacy_type для target_user_email.
    Возвращает True если доступ разрешен, False если нет.
    """
    # Если пользователь смотрит свой профиль - всегда разрешено
    if target_user_email == viewer_email:
        return True
    
    # Получаем настройки конфиденциальности целевого пользователя
    target_user: Optional[Dict[str, Any]] = await users_collection.find_one(
        {"email": target_user_email},
        {"privacy_settings": 1}
    )
    
    if not target_user:
        return False
    
    privacy_settings = target_user.get("privacy_settings", {})
    
    if privacy_type == "last_seen":
        visibility = privacy_settings.get("last_seen_visibility", "everyone")
    elif privacy_type == "profile_photo":
        visibility = privacy_settings.get("profile_photo_visibility", "everyone")
    else:
        return True  # По умолчанию разрешаем
    
    # Если "everyone" - все могут видеть
    if visibility == "everyone":
        return True
    
    # Если "nobody" - никто не может видеть (кроме самого пользователя, но это уже проверено выше)
    if visibility == "nobody":
        return False
    
    # Если "contacts" - проверяем, является ли viewer контактом target_user
    if visibility == "contacts":
        viewer_user: Optional[Dict[str, Any]] = await users_collection.find_one(
            {"email": viewer_email},
            {"contacts": 1}
        )
        if not viewer_user:
            return False
        
        contacts = viewer_user.get("contacts", [])
        # Проверяем, есть ли target_user_email в контактах viewer
        contact_emails = [c.get("email") for c in contacts if c.get("email")]
        return target_user_email in contact_emails
    
    return True



@router.get("/api/contacts", summary="Список контактов текущего пользователя")
async def list_contacts(current_user: Annotated[Dict[str, Any], Depends(get_current_user)]):
    users_collection = db_module.get_users_collection()

    user_doc: Optional[Dict[str, Any]] = await users_collection.find_one(
        {"email": current_user["email"]},
        {"contacts": 1}
    )
    contacts_raw: List[Dict[str, Any]] = user_doc.get("contacts", []) if user_doc else []

    enriched_contacts: List[Dict[str, Any]] = []
    for contact in contacts_raw:
        contact_email = contact.get("email")
        if not contact_email:
            continue

        contact_name = (
            contact.get("display_name")
            or " ".join(
                part for part in [contact.get("first_name"), contact.get("last_name")] if part
            ).strip()
        )

        target_user = await users_collection.find_one(
            {"email": contact_email},
            {"username": 1, "full_name": 1, "profile_picture": 1, "last_seen": 1, "blocked_users": 1, "_id": 0}
        )

        # Определяем статус онлайн на основе last_seen
        is_online = False
        last_seen = None
        if target_user:
            # Если владелец контакта заблокировал текущего пользователя, всегда показываем "офлайн давно"
            blocked_users = target_user.get("blocked_users", []) or []
            viewer_is_blocked = current_user["email"] in blocked_users

            if viewer_is_blocked:
                fake_last_seen = datetime.utcnow() - timedelta(days=30)
                last_seen = fake_last_seen.isoformat() + "Z"
                is_online = False
            else:
                last_seen_data = target_user.get("last_seen")
                if last_seen_data and isinstance(last_seen_data, datetime):
                    last_seen = last_seen_data.isoformat() + "Z"
                    online_threshold = datetime.utcnow() - timedelta(minutes=5)
                    if last_seen_data > online_threshold:
                        is_online = True

        # Проверяем настройки конфиденциальности для last_seen
        can_see_last_seen = await check_privacy_access(
            contact_email, 
            current_user["email"], 
            "last_seen", 
            users_collection
        )
        if not can_see_last_seen:
            last_seen = None
            is_online = False

        # Проверяем настройки конфиденциальности для profile_picture
        can_see_profile_photo = await check_privacy_access(
            contact_email,
            current_user["email"],
            "profile_photo",
            users_collection
        )
        profile_picture = "/images/юзер.svg"
        if target_user:
            blocked_users = target_user.get("blocked_users", []) or []
            viewer_is_blocked = current_user["email"] in blocked_users
        else:
            viewer_is_blocked = False

        if viewer_is_blocked:
            profile_picture = "/images/юзер.svg"
        elif can_see_profile_photo and target_user:
            profile_picture = target_user.get("profile_picture") or "/images/юзер.svg"

        enriched_contacts.append({
            "email": contact_email,
            "display_name": contact_name or (target_user.get("full_name") if target_user else None) or contact_email,
            "first_name": contact.get("first_name"),
            "last_name": contact.get("last_name"),
            "username": target_user.get("username") if target_user else None,
            "full_name": target_user.get("full_name") if target_user else None,
            "profile_picture": profile_picture,
            "found": bool(target_user),
            "is_online": is_online,
            "last_seen": last_seen,
            "is_favorite": contact.get("is_favorite", False)
        })

    return {
        "contacts": enriched_contacts,
        "count": len(enriched_contacts)
    }


@router.post("/api/contacts", summary="Добавить пользователя в контакты")
async def add_contact(
    request: Request,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)] = None
):
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]

    payload_email: Optional[str] = None
    payload_first_name: Optional[str] = None
    payload_last_name: Optional[str] = None

    # Поддержка JSON, form-data и fallback на сырой body
    body: Dict[str, Any] = {}
    raw_body = await request.body()
    content_type = request.headers.get("content-type", "")

    if raw_body:
        # Сначала пытаемся как JSON независимо от content-type
        try:
            body = await request.json()
        except Exception:
            body = {}

    if not body:
        # Если JSON не прочитался — пробуем form-data
        try:
            form = await request.form()
            body = dict(form)
        except Exception:
            body = {}

    payload_email = (body.get("email") or body.get("contact_email") or "").strip()
    payload_first_name = (body.get("first_name") or body.get("firstName") or body.get("name") or "").strip()
    raw_last = body.get("last_name") or body.get("lastName") or ""
    payload_last_name = raw_last.strip() if raw_last else None

    # Валидация email (разрешаем короткие адреса вида i@i)
    payload_email = _normalize_contact_email(payload_email)
    if not payload_first_name or not payload_first_name.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Имя обязательно.")

    payload_email = payload_email.lower().strip()
    payload_first_name = payload_first_name.strip()
    payload_last_name = payload_last_name.strip() if payload_last_name else None

    if payload_email.lower() == user_email.lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Нельзя добавить себя в контакты.")

    target_user: Optional[Dict[str, Any]] = await users_collection.find_one(
        {"email": payload_email},
        {"username": 1, "full_name": 1, "profile_picture": 1}
    )
    if not target_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Пользователя нет в Figma")

    display_name = f"{payload_first_name} {payload_last_name}".strip() if payload_last_name else payload_first_name

    # Проверяем, существует ли контакт
    existing_contact = await users_collection.find_one(
        {"email": user_email, "contacts.email": payload_email},
        {"_id": 1, "contacts.$": 1}
    )
    
    is_update = False
    if existing_contact:
        # Контакт уже существует - обновляем имя
        is_update = True
        await users_collection.update_one(
            {"email": user_email, "contacts.email": payload_email},
            {
                "$set": {
                    "contacts.$.first_name": payload_first_name,
                    "contacts.$.last_name": payload_last_name,
                    "contacts.$.display_name": display_name
                }
            }
        )
    else:
        # Контакт не существует - добавляем новый
        await users_collection.update_one(
            {"email": user_email},
            {
                "$addToSet": {
                    "contacts": {
                        "email": payload_email,
                        "first_name": payload_first_name,
                        "last_name": payload_last_name,
                        "display_name": display_name
                    }
                }
            }
        )

    return {
        "message": "Контакт обновлен" if is_update else "Контакт добавлен",
        "contact": {
            "email": payload_email,
            "display_name": display_name,
            "profile_picture": target_user.get("profile_picture") or "/images/юзер.svg",
            "username": target_user.get("username"),
            "full_name": target_user.get("full_name")
        }
    }


@router.get("/api/users/search", summary="Поиск пользователей по имени, username или email")
async def search_users(
    request: Request,
    query: str,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)],
):
    """
    Глобальный поиск по ВСЕМ пользователям (кроме текущего)
    по полям: username, email, full_name (регистронезависимо).
    """
    q = (query or "").strip()
    if len(q) < 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Поисковый запрос не может быть пустым.",
        )

    users_collection = db_module.get_users_collection()
    search_term = q.lstrip("@")
    if not search_term:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Поисковый запрос не может быть пустым.",
        )
    pattern = re.escape(search_term)

    found_users: List[Dict[str, Any]] = await users_collection.find(
        {
            "$and": [
                {
                    "$or": [
                        {"username": {"$regex": pattern, "$options": "i"}},
                        {"email": {"$regex": pattern, "$options": "i"}},
                        {"full_name": {"$regex": pattern, "$options": "i"}},
                    ]
                },
                {"email": {"$ne": current_user["email"]}},
            ]
        },
        {
            "username": 1,
            "email": 1,
            "full_name": 1,
            "profile_picture": 1,
            "_id": 0,
        },
    ).to_list(100)

    results = [
        {
            "username": user.get("username"),
            "email": user.get("email"),
            "full_name": user.get("full_name", user.get("username")),
            "profile_picture": user.get("profile_picture"),
        }
        for user in found_users
    ]

    return {"users": results}


@router.get("/users/me")
async def read_users_me(current_user: Annotated[Dict[str, Any], Depends(get_current_user)]):
    return {"message": "Вы авторизованы!", "user": current_user["email"], "username": current_user["username"]}


@router.get("/api/user_status")
async def get_user_status(email: str):
    users_collection = db_module.get_users_collection()

    user_data: Optional[Dict[str, Any]] = await users_collection.find_one({"email": email}, {"last_seen": 1})
    if not user_data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Пользователь не найден.")

    last_seen = user_data.get("last_seen")

    is_online = False
    if last_seen and isinstance(last_seen, datetime):
        online_threshold = datetime.utcnow() - timedelta(minutes=5)
        if last_seen > online_threshold:
            is_online = True

    return JSONResponse(content={"is_online": is_online})


# --- Обновление профиля ---
@router.post("/api/profile/update")
async def update_user_profile(
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)],
    username: Optional[str] = Form(None),
    first_name: Optional[str] = Form(None),
    last_name: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
    about: Optional[str] = Form(None),
    profile_picture: Optional[UploadFile] = File(None)
):
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]

    update_fields: Dict[str, Any] = {}
    if username is not None:
        username = username.strip().lstrip("@")
        if not username:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Никнейм не может быть пустым.")
        escaped = re.escape(username)
        existing_user_with_username: Optional[Dict[str, Any]] = await users_collection.find_one(
            {
                "username": {"$regex": f"^{escaped}$", "$options": "i"},
                "email": {"$ne": user_email},
            },
            {"_id": 1},
        )
        if existing_user_with_username:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Никнейм уже занят.")
        update_fields["username"] = username
    if first_name is not None:
        update_fields["first_name"] = first_name
    if last_name is not None:
        update_fields["last_name"] = last_name
    if language is not None:
        update_fields["language"] = language
    if about is not None:
        update_fields["about"] = about

    if profile_picture and profile_picture.filename:
        file_extension = os.path.splitext(profile_picture.filename)[1]
        filename = f"{user_email.replace('@', '_').replace('.', '_')}_{datetime.now().strftime('%Y%m%d%H%M%S')}{file_extension}"
        file_path = UPLOAD_FOLDER_FS / filename

        try:
            existing_user: Optional[Dict[str, Any]] = await users_collection.find_one({"email": user_email})
            if existing_user and existing_user.get("profile_picture"):
                # profile_picture хранится как URL вида /images/avatars/...
                old_url = str(existing_user["profile_picture"])
                if old_url.startswith("/"):
                    old_fs_path = BASE_DIR / old_url.lstrip("/")
                    if old_fs_path.exists() and old_fs_path.is_file() and old_fs_path.name != "юзер.svg":
                        try:
                            old_fs_path.unlink()
                        except Exception:
                            pass

            with open(file_path, "wb") as buffer:
                shutil.copyfileobj(profile_picture.file, buffer)

            profile_picture_url = f"{UPLOAD_FOLDER_URL_PREFIX}/{filename}"
            update_fields["profile_picture"] = profile_picture_url
        except Exception:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Ошибка при загрузке файла.")

    # full_name формируем из first/last, иначе используем username (если поменяли) или текущее значение
    if "first_name" in update_fields or "last_name" in update_fields or "username" in update_fields:
        existing_user: Optional[Dict[str, Any]] = await users_collection.find_one({"email": user_email})

        current_first_name = update_fields.get("first_name", existing_user.get("first_name", ""))
        current_last_name = update_fields.get("last_name", existing_user.get("last_name", ""))

        if current_first_name and current_last_name:
            update_fields["full_name"] = f"{current_first_name} {current_last_name}"
        elif current_first_name:
            update_fields["full_name"] = current_first_name
        elif current_last_name:
            update_fields["full_name"] = current_last_name
        else:
            update_fields["full_name"] = update_fields.get("username") or existing_user.get("username", "")

    if update_fields:
        await users_collection.update_one(
            {"email": user_email},
            {"$set": update_fields}
        )
        return {
            "message": "Профиль успешно обновлен.",
            "avatar_url": update_fields.get("profile_picture"),
            "user_email": user_email,
            "username": update_fields.get("username"),
            "full_name": update_fields.get("full_name")
        }
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Нет данных для обновления.")


# --- Публичный профиль ---
@router.get("/api/user_profile")
async def get_user_profile_by_email(
    email: str,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    users_collection = db_module.get_users_collection()
    viewer_email = current_user["email"]

    user_data: Optional[Dict[str, Any]] = await users_collection.find_one(
        {"email": email},
        {
            "username": 1,
            "email": 1,
            "full_name": 1,
            "first_name": 1,
            "last_name": 1,
            "language": 1,
            "about": 1,
            "profile_picture": 1,
            "phone": 1,
            "last_seen": 1,
            "blocked_users": 1,
            "_id": 0,
        },
    )

    if not user_data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Пользователь не найден.")

    if not user_data.get("full_name"):
        user_data["full_name"] = user_data.get("username", "")

    # Если владелец профиля заблокировал просматривающего, скрываем реальный статус и аватар
    blocked_users = user_data.get("blocked_users", []) or []
    viewer_is_blocked = viewer_email in blocked_users

    if viewer_is_blocked:
        # Показываем как "давно не был в сети" и дефолтный аватар
        fake_last_seen = datetime.utcnow() - timedelta(days=30)
        user_data["last_seen"] = fake_last_seen
        user_data["is_online"] = False
        user_data["profile_picture"] = "/images/юзер.svg"
        # blocked_users наружу не отдаем
        user_data.pop("blocked_users", None)
        return user_data

    # Проверяем настройки конфиденциальности для last_seen
    can_see_last_seen = await check_privacy_access(email, viewer_email, "last_seen", users_collection)
    if not can_see_last_seen:
        user_data["last_seen"] = None
        user_data["is_online"] = False
    else:
        # Вычисляем is_online на основе last_seen
        last_seen = user_data.get("last_seen")
        is_online = False
        if last_seen and isinstance(last_seen, datetime):
            online_threshold = datetime.utcnow() - timedelta(minutes=5)
            if last_seen > online_threshold:
                is_online = True
        user_data["is_online"] = is_online

    # Проверяем настройки конфиденциальности для profile_picture
    can_see_profile_photo = await check_privacy_access(email, viewer_email, "profile_photo", users_collection)
    if not can_see_profile_photo:
        user_data["profile_picture"] = "/images/юзер.svg"

    # blocked_users наружу не отдаем
    user_data.pop("blocked_users", None)
    return user_data


# --- Блокировка ---
@router.post("/api/block_user")
async def block_user(
    data: BlockRequest,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """
    Заблокировать пользователя в рамках конкретного чата:
    - в документе чата в массиве blocked хранится пара {blocker, blocked}
    - в документе пользователя-заблокировщика email собеседника добавляется в blocked_users (черный список)
    """
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]

    try:
        chat_obj_id = ObjectId(data.chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Неверный формат chat_id")

    chat = await chats_collection.find_one({"_id": chat_obj_id})
    if not chat:
        raise HTTPException(status_code=404, detail="Чат не найден.")

    # В актуальной схеме участники чата хранятся в participants
    users_in_chat = chat.get("participants", []) or chat.get("users", [])

    # нормализуем участников в список строк (email или str(ObjectId))
    normalized_users = []
    for u in users_in_chat:
        if isinstance(u, dict):
            if "email" in u:
                normalized_users.append(str(u["email"]))
            elif "_id" in u:
                normalized_users.append(str(u["_id"]))
        else:
            normalized_users.append(str(u))

    if str(data.user_id) not in normalized_users:
        raise HTTPException(status_code=404, detail=f"Пользователь {data.user_id} не состоит в чате.")

    block_entry = {"blocker": user_email, "blocked": data.user_id}

    # 1) помечаем блокировку в документе чата
    await chats_collection.update_one(
        {"_id": chat_obj_id},
        {"$addToSet": {"blocked": block_entry}}
    )

    # 2) добавляем пользователя в глобальный черный список блокирующего
    await users_collection.update_one(
        {"email": user_email},
        {"$addToSet": {"blocked_users": data.user_id}}
    )

    return {"message": f"Вы заблокировали {data.user_id} в чате."}

# --- Разблокировка ---
@router.post("/api/unblock_user")
async def unblock_user(
    data: BlockRequest,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """
    Разблокировать пользователя в рамках чата и удалить его из глобального черного списка.
    """
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]

    try:
        chat_obj_id = ObjectId(data.chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Неверный формат chat_id")

    block_entry = {"blocker": user_email, "blocked": data.user_id}

    # 1) убираем блокировку в документе чата
    await chats_collection.update_one(
        {"_id": chat_obj_id},
        {"$pull": {"blocked": block_entry}}
    )

    # 2) удаляем пользователя из глобального черного списка
    await users_collection.update_one(
        {"email": user_email},
        {"$pull": {"blocked_users": data.user_id}}
    )

    return {"message": f"Вы разблокировали {data.user_id} в чате."}


# --- Проверка статуса ---
@router.post("/api/check_block_status")
async def check_block_status(
    data: BlockRequest,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    chats_collection = db_module.get_chats_collection()
    user_email = current_user["email"]

    try:
        chat_obj_id = ObjectId(data.chat_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Неверный формат chat_id")

    chat = await chats_collection.find_one({"_id": chat_obj_id}, {"blocked": 1})
    if not chat:
        raise HTTPException(status_code=404, detail="Чат не найден.")

    blocked_list = chat.get("blocked", [])

    user_view_blocked = any(b["blocker"] == user_email and b["blocked"] == data.user_id for b in blocked_list)
    other_view_blocked = any(b["blocker"] == data.user_id and b["blocked"] == user_email for b in blocked_list)

    return {
        "user_view_blocked": user_view_blocked,
        "other_view_blocked": other_view_blocked
    }


# ===================================================================
# === НАСТРОЙКИ КОНФИДЕНЦИАЛЬНОСТИ =================================
# ===================================================================

class PrivacySettingsUpdate(BaseModel):
    last_seen_visibility: Optional[str] = "everyone"  # everyone, contacts, nobody
    profile_photo_visibility: Optional[str] = "everyone"  # everyone, contacts, nobody

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class UpdateEmailRequest(BaseModel):
    new_email: str

class BlockUserRequest(BaseModel):
    email: str

class UnblockUserRequest(BaseModel):
    email: str

@router.get("/api/privacy/settings", summary="Получить настройки конфиденциальности")
async def get_privacy_settings(
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Получает настройки конфиденциальности текущего пользователя."""
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]
    
    user_doc: Optional[Dict[str, Any]] = await users_collection.find_one(
        {"email": user_email},
        {"privacy_settings": 1, "email": 1}
    )
    
    if not user_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Пользователь не найден.")
    
    privacy_settings = user_doc.get("privacy_settings", {})
    
    return {
        "last_seen_visibility": privacy_settings.get("last_seen_visibility", "everyone"),
        "profile_photo_visibility": privacy_settings.get("profile_photo_visibility", "everyone"),
        "email": user_doc.get("email", user_email)
    }

@router.put("/api/privacy/settings", summary="Обновить настройки конфиденциальности")
async def update_privacy_settings(
    settings: PrivacySettingsUpdate,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Обновляет настройки конфиденциальности текущего пользователя."""
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]
    
    valid_visibilities = ["everyone", "contacts", "nobody"]
    if settings.last_seen_visibility not in valid_visibilities:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Некорректное значение для видимости последнего посещения.")
    if settings.profile_photo_visibility not in valid_visibilities:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Некорректное значение для видимости фото профиля.")
    
    update_data = {
        "privacy_settings.last_seen_visibility": settings.last_seen_visibility,
        "privacy_settings.profile_photo_visibility": settings.profile_photo_visibility
    }
    
    await users_collection.update_one(
        {"email": user_email},
        {"$set": update_data}
    )
    
    return {
        "message": "Настройки конфиденциальности обновлены.",
        "last_seen_visibility": settings.last_seen_visibility,
        "profile_photo_visibility": settings.profile_photo_visibility
    }

@router.post("/api/privacy/change-password", summary="Сменить пароль")
async def change_password(
    request: ChangePasswordRequest,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Меняет пароль пользователя."""
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]
    
    if len(request.new_password) < 6:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Пароль должен быть не менее 6 символов.")
    
    user_doc: Optional[Dict[str, Any]] = await users_collection.find_one(
        {"email": user_email},
        {"hashed_password": 1}
    )
    
    if not user_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Пользователь не найден.")
    
    if not verify_password(request.current_password, user_doc["hashed_password"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Неверный текущий пароль.")
    
    new_hashed_password = hash_password(request.new_password)
    
    await users_collection.update_one(
        {"email": user_email},
        {"$set": {"hashed_password": new_hashed_password}}
    )
    
    return {"message": "Пароль успешно изменен."}

@router.post("/api/privacy/update-email", summary="Обновить email")
async def update_email(
    request: UpdateEmailRequest,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Обновляет email пользователя."""
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]
    new_email = request.new_email.strip().lower()
    
    if "@" not in new_email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Некорректный email.")
    
    # Проверяем, не занят ли email
    existing_user = await users_collection.find_one({"email": new_email})
    if existing_user:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Этот email уже занят.")
    
    # Обновляем email
    await users_collection.update_one(
        {"email": user_email},
        {"$set": {"email": new_email}}
    )
    
    return {"message": "Email успешно обновлен.", "new_email": new_email}

@router.get("/api/privacy/blocked", summary="Получить черный список")
async def get_blocked_users(
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Получает список заблокированных пользователей."""
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]
    
    user_doc: Optional[Dict[str, Any]] = await users_collection.find_one(
        {"email": user_email},
        {"blocked_users": 1}
    )
    
    if not user_doc:
        return []
    
    blocked_emails = user_doc.get("blocked_users", [])
    if not blocked_emails:
        return []
    
    # Получаем информацию о заблокированных пользователях
    blocked_users = []
    for email in blocked_emails:
        blocked_user = await users_collection.find_one(
            {"email": email},
            {"email": 1, "username": 1, "full_name": 1, "profile_picture": 1}
        )
        if blocked_user:
            blocked_users.append({
                "email": blocked_user.get("email"),
                "username": blocked_user.get("username"),
                "full_name": blocked_user.get("full_name"),
                "profile_picture": blocked_user.get("profile_picture")
            })
    
    return blocked_users

@router.post("/api/privacy/block", summary="Заблокировать пользователя")
async def block_user(
    request: BlockUserRequest,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Добавляет пользователя в черный список."""
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]
    block_email = request.email.strip().lower()
    
    if block_email == user_email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Нельзя заблокировать самого себя.")
    
    # Проверяем, существует ли пользователь
    target_user = await users_collection.find_one({"email": block_email})
    if not target_user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Пользователь не найден.")
    
    # Добавляем в черный список
    user_doc: Optional[Dict[str, Any]] = await users_collection.find_one(
        {"email": user_email},
        {"blocked_users": 1}
    )
    
    blocked_users = user_doc.get("blocked_users", []) if user_doc else []
    if block_email not in blocked_users:
        blocked_users.append(block_email)
        await users_collection.update_one(
            {"email": user_email},
            {"$set": {"blocked_users": blocked_users}}
        )
    
    return {"message": "Пользователь заблокирован.", "email": block_email}

@router.post("/api/privacy/unblock", summary="Разблокировать пользователя")
async def unblock_user(
    request: UnblockUserRequest,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Удаляет пользователя из черного списка."""
    users_collection = db_module.get_users_collection()
    user_email = current_user["email"]
    unblock_email = request.email.strip().lower()
    
    user_doc: Optional[Dict[str, Any]] = await users_collection.find_one(
        {"email": user_email},
        {"blocked_users": 1}
    )
    
    if not user_doc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Пользователь не найден.")
    
    blocked_users = user_doc.get("blocked_users", [])
    if unblock_email in blocked_users:
        blocked_users.remove(unblock_email)
        await users_collection.update_one(
            {"email": user_email},
            {"$set": {"blocked_users": blocked_users}}
        )
    
    return {"message": "Пользователь разблокирован.", "email": unblock_email}

