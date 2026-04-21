# backend/chats.py
from fastapi import (
    APIRouter, Depends, Form, HTTPException, 
    status, Request, UploadFile, File,
    WebSocket, WebSocketDisconnect
)
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from typing import Annotated, Optional, Dict, Any, List
from datetime import datetime, timezone, timedelta
from bson import ObjectId
import uuid
import shutil
from pathlib import Path
from mimetypes import guess_type
from urllib.parse import quote, urlparse
from pydantic import BaseModel
import json      
import asyncio   
import subprocess
import tempfile
import re
import os

import backend.db.database as db_module
from backend.dependencies import get_current_user
import aiohttp
from bs4 import BeautifulSoup
from backend.routes import calls

# --- (Блок импортов и настроек Jinja - без изменений) ---
BASE_DIR = Path(__file__).resolve().parent.parent.parent
CHATS_TEMPLATES_DIR = BASE_DIR / "frontend" / "chats"
chats_templates = Jinja2Templates(directory=str(CHATS_TEMPLATES_DIR))
def format_time_filter(timestamp):
    if not timestamp: return ""
    try:
        # Определяем локальный часовой пояс (UTC+3 для России)
        local_tz = timezone(timedelta(hours=3))
        
        if isinstance(timestamp, datetime):
            # Если datetime уже есть, конвертируем в локальный часовой пояс
            if timestamp.tzinfo is None:
                # Если нет информации о часовом поясе, считаем что это UTC
                dt_local = timestamp.replace(tzinfo=timezone.utc).astimezone(local_tz)
            else:
                dt_local = timestamp.astimezone(local_tz)
            return dt_local.strftime("%H:%M")
        
        # Парсим ISO строку
        dt_object = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        # Конвертируем в локальный часовой пояс
        dt_local = dt_object.astimezone(local_tz)
        return dt_local.strftime("%H:%M")
    except (ValueError, TypeError): return ""
chats_templates.env.filters["format_time"] = format_time_filter
# Исправляем путь к папке загрузок: используем абсолютный путь относительно PROJECT_ROOT
UPLOAD_DIR = BASE_DIR / "static" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
router = APIRouter(tags=["Chats"])
# --- (Конец блока без изменений) ---

# ===================================================================
# === Функция для извлечения превью изображения из ссылки ==========
# ===================================================================
async def extract_link_preview(url: str) -> Optional[str]:
    """
    Извлекает URL превью изображения из ссылки через Open Graph мета-теги.
    Возвращает URL изображения или None, если не удалось извлечь.
    """
    try:
        # Используем Microlink API для получения Open Graph данных
        async with aiohttp.ClientSession() as session:
            try:
                async with session.get(
                    f"https://api.microlink.io/data?url={quote(url, safe='')}",
                    timeout=aiohttp.ClientTimeout(total=5)
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        # Проверяем наличие изображения в ответе
                        if data.get("data") and data["data"].get("image"):
                            image_url = data["data"]["image"].get("url")
                            if image_url:
                                return image_url
            except Exception:
                pass
            
            # Fallback: парсим HTML напрямую для извлечения og:image
            try:
                async with session.get(
                    url,
                    timeout=aiohttp.ClientTimeout(total=5),
                    headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
                ) as response:
                    if response.status == 200:
                        html = await response.text()
                        soup = BeautifulSoup(html, 'html.parser')
                        
                        # Ищем og:image
                        og_image = soup.find("meta", property="og:image")
                        if og_image and og_image.get("content"):
                            image_url = og_image["content"]
                            # Если относительный URL, делаем абсолютным
                            if image_url.startswith("//"):
                                image_url = "https:" + image_url
                            elif image_url.startswith("/"):
                                parsed = urlparse(url)
                                image_url = f"{parsed.scheme}://{parsed.netloc}{image_url}"
                            return image_url
                        
                        # Ищем twitter:image как fallback
                        twitter_image = soup.find("meta", attrs={"name": "twitter:image"})
                        if twitter_image and twitter_image.get("content"):
                            image_url = twitter_image["content"]
                            if image_url.startswith("//"):
                                image_url = "https:" + image_url
                            elif image_url.startswith("/"):
                                parsed = urlparse(url)
                                image_url = f"{parsed.scheme}://{parsed.netloc}{image_url}"
                            return image_url
            except Exception:
                pass
    except Exception:
        pass
    
    return None

async def extract_link_preview_async(url: str, chat_id: ObjectId, message_id: ObjectId):
    """
    Асинхронно извлекает превью и обновляет сообщение в БД.
    Используется для фонового обновления превью после отправки сообщения.
    """
    try:
        preview_image = await extract_link_preview(url)
        if preview_image:
            chats_collection = db_module.get_chats_collection()
            await chats_collection.update_one(
                {"_id": chat_id, "messages._id": message_id},
                {"$set": {"messages.$.link_preview": preview_image}}
            )
            # Отправляем обновление через WebSocket
            chat = await chats_collection.find_one({"_id": chat_id})
            if chat:
                participants = chat.get("participants", [])
                update_data = {
                    "type": "link_preview_update",
                    "chat_id": str(chat_id),
                    "message_id": str(message_id),
                    "link_preview": preview_image
                }
                await manager.broadcast_to_participants(participants, update_data)
    except Exception as e:
        print(f"Ошибка при извлечении превью в фоне: {e}")
# ===================================================================
# === КОНЕЦ ФУНКЦИИ ================================================
# ===================================================================

def _find_ffmpeg() -> str:
    """
    Ищет ffmpeg в системе. Проверяет PATH и типичные места установки на Windows.
    """
    # Сначала проверяем в PATH
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return ffmpeg_path
    
    # На Windows проверяем типичные места установки
    if os.name == 'nt':  # Windows
        possible_paths = [
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe",
            os.path.join(os.environ.get("LOCALAPPDATA", ""), "ffmpeg", "bin", "ffmpeg.exe"),
            os.path.join(os.environ.get("PROGRAMFILES", ""), "ffmpeg", "bin", "ffmpeg.exe"),
        ]
        
        for path in possible_paths:
            if path and os.path.exists(path):
                return path
    
    # Если не найден, возвращаем "ffmpeg" для стандартного поиска
    return "ffmpeg"

def _run_ffmpeg_convert(input_path: Path, output_path: Path) -> None:
    """
    Конвертирует входной аудиофайл в MP3 с помощью ffmpeg.
    Требует, чтобы ffmpeg был установлен в системе/контейнере.
    """
    # Проверяем, что входной файл существует
    if not input_path.exists():
        raise RuntimeError(f"Входной файл не найден: {input_path}")
    
    # Проверяем размер входного файла
    input_size = input_path.stat().st_size
    if input_size == 0:
        raise RuntimeError(f"Входной файл пуст: {input_path}")
    
    # Убеждаемся, что директория для выходного файла существует
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Удаляем выходной файл, если он существует
    if output_path.exists():
        try:
            output_path.unlink(missing_ok=True)
        except Exception:
            pass
    
    # Находим ffmpeg
    ffmpeg_exe = _find_ffmpeg()
    
    cmd = [
        ffmpeg_exe,
        "-y",  # Перезаписывать выходной файл
        "-i", str(input_path),
        "-ac", "1",  # Моно
        "-ar", "48000",  # Частота дискретизации
        "-b:a", "96k",  # Битрейт
        "-f", "mp3",  # Формат вывода
        str(output_path),
    ]
    
    try:
        proc = subprocess.run(
            cmd, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            timeout=30,  # Таймаут 30 секунд
            check=False
        )
        
        if proc.returncode != 0:
            error_msg = proc.stderr.decode('utf-8', errors='ignore')
            raise RuntimeError(f"ffmpeg failed (code {proc.returncode}): {error_msg}")
        
        # Проверяем, что выходной файл был создан
        if not output_path.exists():
            raise RuntimeError(f"Выходной файл не был создан: {output_path}")
        
        # Проверяем размер выходного файла
        output_size = output_path.stat().st_size
        if output_size == 0:
            raise RuntimeError(f"Выходной файл пуст: {output_path}")
            
    except subprocess.TimeoutExpired:
        raise RuntimeError("Конвертация аудио превысила время ожидания (30 секунд)")
    except FileNotFoundError:
        raise RuntimeError(f"ffmpeg не найден по пути: {ffmpeg_exe}. Убедитесь, что ffmpeg установлен и добавлен в PATH, или укажите полный путь к ffmpeg.")

def _probe_duration_seconds(file_path: Path) -> float:
    """
    Получает длительность аудио в секундах через ffprobe.
    Возвращает 0.0 при ошибке.
    """
    try:
        # Проверяем, что файл существует
        if not file_path.exists():
            return 0.0
        
        cmd = [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(file_path),
        ]
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if proc.returncode == 0:
            return float(proc.stdout.strip())
    except Exception:
        pass
    return 0.0

# ===================================================================
# === ConnectionManager (перенесен в websocket_manager.py) =========
# ===================================================================
from backend.routes.websocket_manager import manager
# ===================================================================
# === КОНЕЦ БЛОКА ===================================================
# ===================================================================


# ===================================================================
# === НОВАЯ ФУНКЦИЯ: Рассылка статуса Online/Offline =================
# ===================================================================
async def broadcast_status_update(user_email: str, status: str, last_seen: Optional[datetime] = None):
    """
    Оповещает всех, у кого есть чат с этим пользователем, о его новом статусе.
    """
    chats_collection = db_module.get_chats_collection()
    
    # 1. Найти все чаты, где участвует пользователь
    user_chats_cursor = chats_collection.find({"participants": user_email}, {"participants": 1})
    
    # 2. Собрать УНИКАЛЬНЫЙ список всех "собеседников" (обозревателей)
    observers = set()
    async for chat in user_chats_cursor:
        for p in chat.get("participants", []):
            if p != user_email:
                observers.add(p)
    
    if not observers:
        return
        
    # 3. Подготовить сообщение
    payload = {
        "type": "status_update",
        "user_email": user_email,
        "status": status,
    }
    if status == "offline" and last_seen:
        payload["last_seen"] = last_seen.isoformat() + "Z"
    
    # 4. Разослать сообщение только тем, кто СЕЙЧАС онлайн
    active_observers = [email for email in observers if email in manager.active_connections]
    if active_observers:
        print(f"[Status] Broadcasting {user_email} is {status} to {active_observers}")
        await manager.broadcast_to_participants(active_observers, payload)
# ===================================================================
# === КОНЕЦ НОВОГО БЛОКА ============================================
# ===================================================================


# ===================================================================
# === WebSocket-эндпоинт (ОБНОВЛЕН) =================================
# ===================================================================
@router.websocket("/ws/{user_email}")
async def websocket_endpoint(websocket: WebSocket, user_email: str):
    # --- Получаем коллекции ---
    users_collection = db_module.get_users_collection()
    chats_collection = db_module.get_chats_collection()
    normalized_email = user_email.strip().lower()
    
    # === ЛОГИКА ПОДКЛЮЧЕНИЯ ===
    await manager.connect(normalized_email, websocket)
    # 1. Обновить статус в БД
    await users_collection.update_one({"email": normalized_email}, {"$set": {"last_seen": "online"}})
    # 2. Оповестить контакты, что мы в сети
    await broadcast_status_update(normalized_email, "online")
    
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")
            chat_id_str = data.get("chat_id")

            if msg_type == "ping":
                await websocket.send_json({"type": "pong", "ts": datetime.utcnow().isoformat() + "Z"})
                continue
            
            # === ОБРАБОТКА СОБЫТИЙ ЗВОНКОВ ===
            if msg_type in ["call_initiate", "call_accept", "call_reject", "call_end", 
                           "call_offer", "call_answer", "call_ice_candidate"]:
                result = None
                try:
                    if msg_type == "call_initiate":
                        result = await calls.handle_call_initiate(normalized_email, data)
                    elif msg_type == "call_accept":
                        result = await calls.handle_call_accept(normalized_email, data)
                    elif msg_type == "call_reject":
                        result = await calls.handle_call_reject(normalized_email, data)
                    elif msg_type == "call_end":
                        result = await calls.handle_call_end(normalized_email, data)
                    elif msg_type == "call_offer":
                        result = await calls.handle_call_offer(normalized_email, data)
                    elif msg_type == "call_answer":
                        result = await calls.handle_call_answer(normalized_email, data)
                    elif msg_type == "call_ice_candidate":
                        result = await calls.handle_call_ice_candidate(normalized_email, data)
                    
                    if result:
                        await websocket.send_json(result)
                except Exception as e:
                    print(f"[WS] Call error for {normalized_email}: {e}")
                    await websocket.send_json({
                        "type": "call_error",
                        "error": str(e)
                    })
                continue
            
            # === ОБРАБОТКА СОБЫТИЙ АУДИО-ЧАТОВ ===
            if msg_type in ["create_audio_chat", "join_audio_chat", "leave_audio_chat",
                           "audio_chat_offer", "audio_chat_answer", "audio_chat_ice_candidate"]:
                result = None
                try:
                    if msg_type == "create_audio_chat":
                        result = await calls.handle_create_audio_chat(normalized_email, data)
                    elif msg_type == "join_audio_chat":
                        result = await calls.handle_join_audio_chat(normalized_email, data)
                    elif msg_type == "leave_audio_chat":
                        result = await calls.handle_leave_audio_chat(normalized_email, data)
                    elif msg_type == "audio_chat_offer":
                        result = await calls.handle_audio_chat_offer(normalized_email, data)
                    elif msg_type == "audio_chat_answer":
                        result = await calls.handle_audio_chat_answer(normalized_email, data)
                    elif msg_type == "audio_chat_ice_candidate":
                        result = await calls.handle_audio_chat_ice_candidate(normalized_email, data)
                    
                    if result:
                        await websocket.send_json(result)
                except Exception as e:
                    print(f"[WS] Audio chat error for {normalized_email}: {e}")
                    await websocket.send_json({
                        "type": "audio_chat_error",
                        "error": str(e)
                    })
                continue
            
            if not chat_id_str:
                continue

            try:
                chat_oid = ObjectId(chat_id_str)
            except Exception:
                continue # Неверный ID чата

            chat = await chats_collection.find_one({"_id": chat_oid})
            if not chat or normalized_email not in [p.lower() for p in chat.get("participants", [])]:
                continue # Чат не найден или юзер не в нем
            
            other_participants = [p for p in chat["participants"] if p.lower() != normalized_email]

            # === ЛОГИКА "ПЕЧАТАЕТ" ===
            if msg_type == "typing" or msg_type == "stopped_typing":
                if not other_participants:
                    continue
                broadcast_data = {
                    "type": msg_type,
                    "chat_id": chat_id_str,
                    "sender_email": normalized_email
                }
                await manager.broadcast_to_participants(other_participants, broadcast_data)

            # === ЛОГИКА: "ПРОЧИТАТЬ СООБЩЕНИЯ" ===
            elif msg_type == "mark_as_read":
                safe_email = normalized_email.replace(".", "_dot_")

                # Обнуляем счетчик в документе чата
                await chats_collection.update_one(
                    {"_id": chat_oid},
                    {"$set": {f"unread_count.{safe_email}": 0}}
                )

                # Проставляем галочки прочитано в самих сообщениях
                messages_to_mark_ids = []
                for msg in chat.get("messages", []):
                    if msg.get("sender_id") != normalized_email and normalized_email not in msg.get("read_by", []):
                        messages_to_mark_ids.append(msg["_id"])

                if messages_to_mark_ids:
                    await chats_collection.update_one(
                        {"_id": chat_oid},
                        {"$addToSet": {"messages.$[elem].read_by": normalized_email}},
                        array_filters=[{"elem._id": {"$in": messages_to_mark_ids}}]
                    )

                # Отправляем синие галочки собеседнику
                if other_participants and messages_to_mark_ids:
                    await manager.broadcast_to_participants(other_participants, {
                        "type": "messages_read",
                        "chat_id": chat_id_str,
                        "reader_email": normalized_email,
                        "message_ids": [str(mid) for mid in messages_to_mark_ids]
                    })

                # Сбрасываем счетчик на всех твоих открытых вкладках
                await manager.send_to_user(normalized_email, {
                    "type": "unread_count_update",
                    "chat_id": chat_id_str,
                    "count": 0
                })

    except WebSocketDisconnect:
        # === ЛОГИКА ОТКЛЮЧЕНИЯ ===
        print(f"[WS] Disconnect detected for {normalized_email}")
        last_seen_time = datetime.utcnow()
        # 1. Обновить статус в БД
        await users_collection.update_one({"email": normalized_email}, {"$set": {"last_seen": last_seen_time}})
        # 2. Оповестить контакты, что мы НЕ в сети
        await broadcast_status_update(normalized_email, "offline", last_seen_time)
        # 3. Отключить из менеджера
        manager.disconnect(normalized_email)
        
    except Exception as e:
        # === ЛОГИКА ОШИБКИ (аналогично отключению) ===
        print(f"[WS] WebSocket error for {normalized_email}: {e}")
        last_seen_time = datetime.utcnow()
        await users_collection.update_one({"email": normalized_email}, {"$set": {"last_seen": last_seen_time}})
        await broadcast_status_update(normalized_email, "offline", last_seen_time)
        manager.disconnect(normalized_email)
# ===================================================================
# === КОНЕЦ БЛОКА ===================================================
# ===================================================================


class DeleteMessageBody(BaseModel):
    delete_for_all: bool

# ===================================================================
# Роуты /chats удалены по требованию - логика перенесена в main.py
# ===================================================================


# ===================================================================
# === WebRTC ICE Servers (STUN/TURN) — для работы звонков через NAT ===
# ===================================================================
@router.get("/api/webrtc-ice-servers", summary="Получить ICE серверы для WebRTC (STUN/TURN)")
async def get_webrtc_ice_servers():
    """
    Возвращает конфигурацию ICE серверов для WebRTC.
    TURN сервер критически важен для звонков между пользователями в разных сетях (не локально).
    Настройте TURN через переменные окружения:
    - METERED_APP_NAME и METERED_API_KEY — для Metered Open Relay (бесплатно 20 GB/мес)
    - Или TURN_URL, TURN_USERNAME, TURN_CREDENTIAL — для своего TURN сервера
    """
    ice_servers = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
        {"urls": "stun:stun2.l.google.com:19302"},
        {"urls": "stun:stun3.l.google.com:19302"},
        {"urls": "stun:stun4.l.google.com:19302"},
    ]
    
    # Metered Open Relay (бесплатный TURN) — требуется регистрация на metered.ca
    metered_app = os.getenv("METERED_APP_NAME", "").strip()
    metered_key = os.getenv("METERED_API_KEY", "").strip()
    if metered_app and metered_key:
        try:
            async with aiohttp.ClientSession() as session:
                url = f"https://{metered_app}.metered.live/api/v1/turn/credentials?apiKey={metered_key}"
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        if isinstance(data, list):
                            ice_servers = data
                        elif isinstance(data, dict) and "iceServers" in data:
                            ice_servers = data["iceServers"]
                        else:
                            pass  # оставляем STUN по умолчанию
        except Exception as e:
            print(f"[WebRTC] Ошибка загрузки Metered TURN: {e}")
    
    # Альтернатива: свой TURN сервер (coturn и т.д.)
    turn_url = os.getenv("TURN_URL", "").strip()
    turn_user = os.getenv("TURN_USERNAME", "").strip()
    turn_cred = os.getenv("TURN_CREDENTIAL", "").strip()
    if turn_url and turn_user and turn_cred:
        ice_servers.append({
            "urls": turn_url,
            "username": turn_user,
            "credential": turn_cred,
        })
    
    return {"iceServers": ice_servers}


@router.post("/start_chat", summary="Инициировать или открыть личный чат", response_model=Dict[str, str])
async def start_chat_api(current_user: Annotated[Dict[str, Any], Depends(get_current_user)], target_email: Annotated[str, Form()]):
    # ... (без изменений) ...
    users_collection = db_module.get_users_collection()
    chats_collection = db_module.get_chats_collection()
    current_user_email = current_user["email"]
    if current_user_email == target_email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Нельзя начать чат с самим собой.")
    target_user_exists: Optional[Dict[str, Any]] = await users_collection.find_one({"email": target_email})
    if not target_user_exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Целевой пользователь не найден.")
    participants = sorted([current_user_email, target_email])
    existing_chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"participants": participants, "chat_type": "private"})
    if existing_chat:
        chat_id = str(existing_chat["_id"])
    else:
        new_chat_document = {"participants": participants, "messages": [], "created_at": datetime.utcnow(), "last_message_at": datetime.utcnow(), "chat_type": "private", "unread_count": {}}
        insert_result = await chats_collection.insert_one(new_chat_document)
        chat_id = str(insert_result.inserted_id)
        try:
            # Рассылаем событие участникам, чтобы чат сразу появился в списке
            await manager.broadcast_to_participants(participants, {
                "type": "chat_created",
                "chat_id": chat_id,
                "chat_type": "private"
            })
        except Exception as e:
            print(f"[start_chat] Failed to broadcast chat_created: {e}")
    return JSONResponse(content={"chat_id": chat_id})

# ===================================================================
# === get_chat_data (Без изменений) =================================
# ===================================================================
@router.get("/api/chat/{chat_id}", summary="Получить данные конкретного чата")
async def get_chat_data(
    chat_id: str, 
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)],
    limit: int = 50,  # По умолчанию загружаем последние 50 сообщений
    offset: int = 0    # Смещение для пагинации
):
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    current_user_doc = await users_collection.find_one(
        {"email": current_user["email"]},
        {"contacts": 1}
    )
    contact_map = {}
    if current_user_doc:
        for contact in current_user_doc.get("contacts", []):
            c_email = contact.get("email")
            if not c_email:
                continue
            contact_map[c_email] = contact.get("display_name") or " ".join(
                part for part in [contact.get("first_name"), contact.get("last_name")] if part
            ).strip()
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Чат не найден.")

    # Проверяем участие пользователя без учета регистра email
    current_email_norm = current_user["email"].strip().lower()
    participants_norm = {p.strip().lower() for p in chat.get("participants", [])}
    if current_email_norm not in participants_norm:
        print(f"[get_chat_data] ОШИБКА ДОСТУПА: пользователь {current_email_norm} не в списке участников {participants_norm}")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этому чату.")
    
    print(f"[get_chat_data] Доступ разрешен для пользователя {current_email_norm}")
    
    chat_type = chat.get("chat_type", "private")
    is_group = chat_type == "group" or len(chat["participants"]) > 2
    other_participant_email = next((p for p in chat["participants"] if p != current_user["email"]), None)
    
    # === ОБРАБОТКА ТИПОВ ЧАТОВ (БОТЫ / ИЗБРАННОЕ / ГРУППЫ / ОБЫЧНЫЕ) ===
    is_bot_chat = chat_type == "bot"
    bot_id = chat.get("bot_id")
    contact_display_name = None
    
    if chat_type == "group":
        # Групповой чат
        chat_title = chat.get("group_name", "Группа")
        chat_avatar = chat.get("group_avatar", "/images/юзер.svg")
        other_user_data = None
    elif is_bot_chat and bot_id:
        # Импортируем список ботов
        from backend.routes.bots import AVAILABLE_BOTS
        bot = next((b for b in AVAILABLE_BOTS if b["bot_id"] == bot_id), None)
        if bot:
            chat_title = bot["name"]
            chat_avatar = bot["avatar"]
            other_user_data = None  # Для ботов нет данных пользователя
        else:
            chat_title = "Бот"
            chat_avatar = "/images/юзер.svg"
            other_user_data = None
    elif chat_type == "favorite":
        # Чат "Избранное" — личные сообщения самому себе
        other_user_data = None
        chat_title = "Избранное"
        # Аватарка из images/avatars с именем favorit.png (как в списке чатов)
        chat_avatar = "/images/avatars/favorit.png"
    else:
        # Обычная логика для пользователей
        other_user_data: Optional[Dict[str, Any]] = None
        other_user_data = None
        if other_participant_email:
            other_user_data = await users_collection.find_one(
                {"email": other_participant_email},
                {"username": 1, "full_name": 1, "profile_picture": 1, "_id": 0}
            )

        contact_display_name = contact_map.get(other_participant_email) if other_participant_email else None
        chat_title = contact_display_name or (other_user_data.get("full_name", other_user_data.get("username", "Неизвестный пользователь")) if other_user_data else "Приватный чат")
        chat_avatar = other_user_data.get("profile_picture", "/images/юзер.svg") if other_user_data else "/images/юзер.svg"
    # === КОНЕЦ ОБРАБОТКИ БОТОВ ===

    # === БЛОКИРОВКИ В КОНКРЕТНОМ ЧАТЕ =====================================
    blocked_list = chat.get("blocked", [])
    current_email = current_user["email"]

    user_view_blocked = False   # текущий пользователь заблокировал собеседника
    other_view_blocked = False  # собеседник заблокировал текущего пользователя

    if not is_group and not is_bot_chat and chat_type == "private" and other_participant_email:
        user_view_blocked = any(
            b.get("blocker") == current_email and b.get("blocked") == other_participant_email
            for b in blocked_list
        )
        other_view_blocked = any(
            b.get("blocker") == other_participant_email and b.get("blocked") == current_email
            for b in blocked_list
        )

        # Если собеседник заблокировал нас, в этом конкретном чате скрываем его реальный аватар
        if other_view_blocked:
            chat_avatar = "/images/юзер.svg"

    messages_data: List[Dict[str, Any]] = []
    all_messages = chat.get("messages", [])
    
    # === ОПТИМИЗАЦИЯ: Фильтруем удаленные сообщения и применяем пагинацию ===
    # Сначала фильтруем удаленные сообщения
    filtered_messages = []
    for msg in all_messages:
        deleted_for_users = msg.get("deleted_for_users")
        if deleted_for_users is None:
            deleted_for_users = []
        elif not isinstance(deleted_for_users, list):
            deleted_for_users = []
        
        if current_user["email"] not in deleted_for_users:
            filtered_messages.append(msg)
    
    # Применяем пагинацию: берем последние (limit + offset) сообщений, затем последние limit
    total_messages = len(filtered_messages)
    start_idx = max(0, total_messages - limit - offset)
    end_idx = total_messages - offset
    paginated_messages = filtered_messages[start_idx:end_idx] if end_idx > 0 else []
    
    # === ОПТИМИЗАЦИЯ: Batch-запрос для отправителей в групповых чатах ===
    sender_emails = set()
    if chat_type == "group":
        for msg in paginated_messages:
            sender_email = msg.get("sender_id") or msg.get("sender_email")
            if sender_email:
                sender_emails.add(sender_email)
    
    # Один batch-запрос для всех отправителей
    senders_batch = {}
    if sender_emails:
        senders_cursor = users_collection.find(
            {"email": {"$in": list(sender_emails)}},
            {"username": 1, "full_name": 1, "profile_picture": 1, "email": 1}
        )
        async for sender_doc in senders_cursor:
            email = sender_doc.get("email")
            if email:
                senders_batch[email] = sender_doc
    
    # Отладочное логирование
    print(f"[get_chat_data] Чат {chat_id}: всего сообщений в БД: {len(all_messages)}, отфильтровано: {len(filtered_messages)}, загружается: {len(paginated_messages)}")
    
    for msg in paginated_messages:
        # Сообщения уже отфильтрованы выше, обрабатываем все
        msg_copy = msg.copy()
        
        # === 1. ИСПРАВЛЕНИЕ для ObjectId (из прошлого раза) ===
        msg_id = msg.get("_id")
        if msg_id is None:
            # Если у сообщения нет _id, создаем новый (для старых сообщений)
            msg_id = ObjectId()
            msg_copy["_id"] = str(msg_id)
        elif isinstance(msg_id, ObjectId):
            msg_copy["_id"] = str(msg_id)
        else:
            msg_copy["_id"] = str(msg_id)
        
        # Убеждаемся, что _id всегда строка
        if not isinstance(msg_copy.get("_id"), str):
            msg_copy["_id"] = str(msg_copy.get("_id"))
        
        # === 2. ИСПРАВЛЕНИЕ для datetime (НОВАЯ ОШИБКА) ===
        # Этот блок конвертирует 'timestamp' в строку
        if isinstance(msg_copy.get("timestamp"), datetime):
            msg_copy["timestamp"] = msg_copy["timestamp"].isoformat() + "Z"
        
        # Этот блок конвертирует 'edited_at' в строку
        if isinstance(msg_copy.get("edited_at"), datetime):
            msg_copy["edited_at"] = msg_copy["edited_at"].isoformat() + "Z"
        # === КОНЕЦ ИСПРАВЛЕНИЙ ===

        msg_copy["read_by"] = msg.get("read_by", [])
        
        # Для групповых чатов добавляем информацию об отправителе (используем batch-запрос)
        if chat_type == "group":
            sender_email = msg.get("sender_id") or msg.get("sender_email")
            if sender_email:
                sender_user = senders_batch.get(sender_email)
                if sender_user:
                    msg_copy["sender_name"] = sender_user.get("full_name") or sender_user.get("username") or sender_email
                    msg_copy["sender_avatar"] = sender_user.get("profile_picture") or "/images/юзер.svg"
                else:
                    msg_copy["sender_name"] = sender_email
                    msg_copy["sender_avatar"] = "/images/юзер.svg"
        
        messages_data.append(msg_copy)
    
    print(f"[get_chat_data] Чат {chat_id}: отфильтровано сообщений: {len(messages_data)}")
    
    # Убеждаемся, что messages_data всегда список
    if not isinstance(messages_data, list):
        print(f"[get_chat_data] ОШИБКА: messages_data не список, тип: {type(messages_data)}")
        messages_data = []
    
    # Получаем закрепленное сообщение
    pinned_message_id = chat.get("pinned_message_id")
    pinned_message = None
    if pinned_message_id:
        # Конвертируем pinned_message_id в ObjectId для сравнения
        try:
            pinned_oid = pinned_message_id if isinstance(pinned_message_id, ObjectId) else ObjectId(pinned_message_id)
        except Exception:
            pinned_oid = None
        
        if pinned_oid:
            pinned_msg = next((msg for msg in chat.get("messages", []) if msg.get("_id") == pinned_oid or str(msg.get("_id")) == str(pinned_oid)), None)
        else:
            pinned_msg = None
        if pinned_msg and current_user["email"] not in pinned_msg.get("deleted_for_users", []):
            pinned_message = pinned_msg.copy()
            pinned_message["_id"] = str(pinned_message["_id"])
            if isinstance(pinned_message.get("timestamp"), datetime):
                pinned_message["timestamp"] = pinned_message["timestamp"].isoformat() + "Z"
            if isinstance(pinned_message.get("edited_at"), datetime):
                pinned_message["edited_at"] = pinned_message["edited_at"].isoformat() + "Z"
            pinned_message["read_by"] = pinned_msg.get("read_by", [])
            
    # Получаем username собеседника для заголовка страницы
    interlocutor_username = None
    if other_user_data and not is_bot_chat and chat_type != "favorite":
        interlocutor_username = other_user_data.get("username")

    # Для групп: мапа email -> username для упоминаний (@username)
    # ОПТИМИЗАЦИЯ: используем batch-запрос вместо N+1
    participants_usernames: Dict[str, str] = {}
    users_batch_for_audio_chat: Dict[str, Dict] = {}  # Для оптимизации поиска создателя аудио-чата
    if chat_type == "group":
        participant_emails = chat.get("participants", [])
        if participant_emails:
            # Используем batch-запрос для всех участников (получаем больше данных для аудио-чата)
            participants_cursor = users_collection.find(
                {"email": {"$in": participant_emails}},
                {"username": 1, "email": 1, "full_name": 1, "profile_picture": 1, "_id": 0}
            )
            async for u in participants_cursor:
                email = u.get("email")
                username = u.get("username")
                if email:
                    if username:
                        participants_usernames[email] = username
                    # Сохраняем полные данные для использования в аудио-чате
                    users_batch_for_audio_chat[email] = u
    
    # === ОПТИМИЗАЦИЯ: Проверка активного аудио-чата для группы ===
    # Используем быстрый поиск вместо перебора всех чатов
    active_audio_chat = None
    if chat_type == "group":
        # Ищем активный аудио-чат для этого чата
        room_data = None
        room_id = None
        for rid, rdata in calls.active_audio_chats.items():
            if rdata.get("chat_id") == chat_id:
                room_data = rdata
                room_id = rid
                break
        
        if room_data and room_id:
            # Получаем данные создателя (batch-запрос уже выполнен выше, если создатель в списке участников)
            creator_email = room_data.get("creator", "")
            creator_name = "Неизвестный"
            creator_avatar = None
            
            if creator_email:
                # Используем данные из users_batch_for_audio_chat если они есть (для оптимизации)
                creator_user = users_batch_for_audio_chat.get(creator_email)
                if not creator_user:
                    # Fallback: отдельный запрос только если не найден в batch
                    creator_user = await users_collection.find_one(
                        {"email": creator_email},
                        {"full_name": 1, "username": 1, "profile_picture": 1}
                    )
                
                if creator_user:
                    creator_name = creator_user.get("full_name") or creator_user.get("username") or creator_email
                    creator_avatar = creator_user.get("profile_picture")
                else:
                    creator_name = creator_email.split("@")[0]  # Используем часть email как имя
            
            active_audio_chat = {
                "audio_room_id": room_id,
                "chat_id": chat_id,
                "creator": creator_email,
                "creator_name": creator_name,
                "creator_avatar": creator_avatar or "/images/юзер.svg",
                "participants": room_data.get("participants", []),
                "created_at": room_data.get("created_at").isoformat() + "Z" if room_data.get("created_at") else None
            }
    
    # Убеждаемся, что messages всегда присутствует и является списком
    # Информация о пагинации
    total_messages_count = len(filtered_messages)
    has_more = (offset + limit) < total_messages_count
    
    response_data = {
        "chat_id": str(chat["_id"]), 
        "chat_title": chat_title, 
        "chat_avatar": chat_avatar, 
        "contact_display_name": contact_display_name if not is_bot_chat and chat_type != "favorite" and chat_type != "group" else None,
        "messages": messages_data if isinstance(messages_data, list) else [],
        "current_user_email": current_user["email"], 
        "interlocutor_email": other_participant_email,
        "interlocutor_username": interlocutor_username,  # Username для заголовка страницы
        "is_group": is_group or chat_type == "group",
        "is_bot": is_bot_chat,  # Флаг для фронтенда
        "is_favorite": chat_type == "favorite",  # Новый флаг "Избранное"
        "bot_id": bot_id if is_bot_chat else None,  # ID бота для фронтенда
        "pinned_message": pinned_message,
        "pinned_message_id": str(pinned_message_id) if pinned_message_id else None,
        "group_name": chat.get("group_name") if chat_type == "group" else None,
        "group_owner": chat.get("owner") if chat_type == "group" else None,
        # Информация о пагинации
        "pagination": {
            "limit": limit,
            "offset": offset,
            "total": total_messages_count,
            "has_more": has_more,
            "loaded": len(messages_data)
        },
        # Активный аудио-чат (если есть)
        "active_audio_chat": active_audio_chat,
        "participants": chat.get("participants", []) if chat_type == "group" else None,
        "participants_usernames": participants_usernames if chat_type == "group" else None,
        # Состояние блокировки в этом чате
        "is_blocked": {
            "blocked_by_me": user_view_blocked,
            "blocked_me": other_view_blocked,
        } if not is_group and not is_bot_chat and chat_type == "private" and other_participant_email else None,
    }
    
    print(f"[get_chat_data] Отправляем ответ с {len(response_data['messages'])} сообщениями")
    return JSONResponse(content=response_data)

# ===================================================================
# === get_chat_media - Получить медиа из чата =======================
# ===================================================================
@router.get("/api/chat/{chat_id}/media", summary="Получить медиа (фото и видео) из чата")
async def get_chat_media(chat_id: str, current_user: Annotated[Dict[str, Any], Depends(get_current_user)]):
    """Возвращает только фото и видео из чата для отображения в профиле"""
    chats_collection = db_module.get_chats_collection()
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Чат не найден.")
    if current_user["email"] not in chat["participants"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этому чату.")
    
    media_items = []
    for msg in chat.get("messages", []):
        # Пропускаем удаленные сообщения
        if current_user["email"] in msg.get("deleted_for_users", []):
            continue
        
        # Берем только фото и видео
        msg_type = msg.get("type", "")
        if msg_type in ["image", "video"] and msg.get("file_url"):
            media_item = {
                "id": str(msg.get("_id")),
                "type": msg_type,
                "file_url": msg.get("file_url"),
                "filename": msg.get("filename"),
                "timestamp": msg.get("timestamp").isoformat() + "Z" if isinstance(msg.get("timestamp"), datetime) else str(msg.get("timestamp", ""))
            }
            media_items.append(media_item)
    
    # Сортируем по времени (новые сначала)
    media_items.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    
    return JSONResponse(content={
        "chat_id": str(chat["_id"]),
        "media": media_items
    })

# ===================================================================
# === get_chat_links - Получить ссылки из чата ======================
# ===================================================================
@router.get("/api/chat/{chat_id}/links", summary="Получить ссылки из чата")
async def get_chat_links(chat_id: str, current_user: Annotated[Dict[str, Any], Depends(get_current_user)]):
    """Возвращает ссылки из сообщений чата для отображения в профиле"""
    chats_collection = db_module.get_chats_collection()
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Чат не найден.")
    if current_user["email"] not in chat["participants"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этому чату.")
    
    # Регулярное выражение для поиска URL
    url_pattern = re.compile(r'https?://[^\s<>"{}|\\^`\[\]]+', re.IGNORECASE)
    
    links = []
    for msg in chat.get("messages", []):
        if current_user["email"] in msg.get("deleted_for_users", []):
            continue
        
        content = msg.get("content", "")
        if content:
            # Ищем все URL в тексте сообщения
            found_urls = url_pattern.findall(content)
            for url in found_urls:
                # Извлекаем домен для title
                try:
                    parsed_url = urlparse(url)
                    title = parsed_url.netloc.replace('www.', '') if parsed_url.netloc else url
                except:
                    title = url
                
                link_item = {
                    "id": str(msg.get("_id")),
                    "url": url,
                    "title": title,  # Домен вместо "Ссылка"
                    "preview_image": msg.get("link_preview"),  # Используем сохраненное превью из сообщения
                    "timestamp": msg.get("timestamp").isoformat() + "Z" if isinstance(msg.get("timestamp"), datetime) else str(msg.get("timestamp", ""))
                }
                links.append(link_item)
    
    # Сортируем по времени (новые сначала)
    links.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    
    return JSONResponse(content={
        "chat_id": str(chat["_id"]),
        "links": links
    })

# ===================================================================
# === get_chat_files - Получить файлы из чата =======================
# ===================================================================
@router.get("/api/chat/{chat_id}/files", summary="Получить файлы из чата")
async def get_chat_files(chat_id: str, current_user: Annotated[Dict[str, Any], Depends(get_current_user)]):
    """Возвращает файлы (не медиа) из чата для отображения в профиле"""
    chats_collection = db_module.get_chats_collection()
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Чат не найден.")
    if current_user["email"] not in chat["participants"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этому чату.")
    
    files = []
    for msg in chat.get("messages", []):
        if current_user["email"] in msg.get("deleted_for_users", []):
            continue
        
        # Берем только файлы (не изображения и не видео)
        msg_type = msg.get("type", "")
        if msg_type == "file" and msg.get("file_url"):
            file_path = UPLOAD_DIR / Path(msg.get("file_url")).name
            file_size = 0
            if file_path.exists():
                file_size = os.path.getsize(file_path)
            
            file_item = {
                "id": str(msg.get("_id")),
                "file_url": msg.get("file_url"),
                "filename": msg.get("filename"),
                "size": file_size,
                "timestamp": msg.get("timestamp").isoformat() + "Z" if isinstance(msg.get("timestamp"), datetime) else str(msg.get("timestamp", ""))
            }
            files.append(file_item)
    
    # Сортируем по времени (новые сначала)
    files.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    
    return JSONResponse(content={
        "chat_id": str(chat["_id"]),
        "files": files
    })

# ===================================================================
# === get_chat_voice - Получить голосовые сообщения из чата =========
# ===================================================================
@router.get("/api/chat/{chat_id}/voice", summary="Получить голосовые сообщения из чата")
async def get_chat_voice(chat_id: str, current_user: Annotated[Dict[str, Any], Depends(get_current_user)]):
    """Возвращает голосовые сообщения из чата для отображения в профиле"""
    chats_collection = db_module.get_chats_collection()
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Чат не найден.")
    if current_user["email"] not in chat["participants"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этому чату.")
    
    voice_items = []
    for msg in chat.get("messages", []):
        if current_user["email"] in msg.get("deleted_for_users", []):
            continue
        
        # Берем только голосовые сообщения
        msg_type = msg.get("type", "")
        if msg_type == "audio" and msg.get("file_url"):
            voice_item = {
                "id": str(msg.get("_id")),
                "file_url": msg.get("file_url"),
                "duration": msg.get("duration", 0),
                "timestamp": msg.get("timestamp").isoformat() + "Z" if isinstance(msg.get("timestamp"), datetime) else str(msg.get("timestamp", ""))
            }
            voice_items.append(voice_item)
    
    # Сортируем по времени (новые сначала)
    voice_items.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
    
    return JSONResponse(content={
        "chat_id": str(chat["_id"]),
        "voice": voice_items
    })

# ===================================================================
# === КОНЕЦ БЛОКА ===================================================
# ===================================================================


# ===================================================================
# === send_message (Без изменений) ==================================
# ===================================================================
@router.post("/api/send_message/{chat_id}", summary="Отправить сообщение в чат")
async def send_message(
    chat_id: str,
    message_content: Annotated[Optional[str], Form()] = None,
    file: Annotated[Optional[UploadFile], File()] = None,
    reply_to_id: Annotated[Optional[str], Form()] = None,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)] = None
):
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    if not message_content and not file:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Необходимо отправить либо текст, либо файл.")
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Чат не найден.")
    if current_user["email"] not in chat["participants"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этому чату.")

    # Проверяем блокировку: если собеседник заблокировал текущего пользователя, запрещаем отправку
    chat_type = chat.get("chat_type", "private")
    participants = chat.get("participants", [])
    other_email = None
    if chat_type == "private" and len(participants) == 2:
        other_email = next((p for p in participants if p != current_user["email"]), None)

    if other_email:
        blocked_list = chat.get("blocked", [])
        blocked_by_other = any(
            b.get("blocker") == other_email and b.get("blocked") == current_user["email"]
            for b in blocked_list
        )
        if blocked_by_other:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Вы не можете отправлять сообщения: пользователь вас заблокировал."
            )

    # Обработка reply_to
    reply_to_data = None
    if reply_to_id:
        try:
            reply_oid = ObjectId(reply_to_id)
            # Находим сообщение, на которое отвечаем
            for msg in chat.get("messages", []):
                if msg.get("_id") == reply_oid:
                    reply_to_data = {
                        "_id": str(msg.get("_id")),
                        "sender_id": msg.get("sender_id"),
                        "content": msg.get("content") or msg.get("filename") or "",
                        "type": msg.get("type", "text")
                    }
                    break
        except Exception:
            pass  # Игнорируем неверный reply_to_id

    new_message = {
        "_id": ObjectId(), 
        "sender_id": current_user["email"],
        "content": message_content,
        "timestamp": datetime.utcnow(),
        "type": "text",
        "file_url": None,
        "filename": None,
        "deleted_for_users": [],
        "read_by": [],
        "reply_to": reply_to_data,
        "link_preview": None  # URL превью изображения для ссылок
    }
    
    # --- (Логика сохранения файла - без изменений) ---
    if file:
        file_extension = Path(file.filename).suffix
        unique_filename = f"{uuid.uuid4()}{file_extension}"
        file_path = UPLOAD_DIR / unique_filename
        with file_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        mime_type, _ = guess_type(str(file_path))
        is_image = mime_type and mime_type.startswith("image")
        is_video = mime_type and mime_type.startswith("video")
        if is_image: new_message["type"] = "image"
        elif is_video: new_message["type"] = "video"
        else: new_message["type"] = "file"
        new_message["file_url"] = f"/static/uploads/{unique_filename}"
        new_message["filename"] = file.filename
        new_message["file_size"] = file_path.stat().st_size
    if new_message["content"] is None:
        new_message["content"] = ""
    # --- (Конец логики файла) ---
    
    # --- Извлечение превью для ссылок ---
    if message_content and not file:
        url_pattern = re.compile(r'https?://[^\s<>"{}|\\^`\[\]]+', re.IGNORECASE)
        found_urls = url_pattern.findall(message_content)
        if found_urls:
            # Берем первую найденную ссылку
            first_url = found_urls[0]
            # Пытаемся получить превью (с таймаутом 3 секунды)
            try:
                preview_image = await asyncio.wait_for(extract_link_preview(first_url), timeout=3.0)
                if preview_image:
                    new_message["link_preview"] = preview_image
            except (asyncio.TimeoutError, Exception):
                # Если не успели или ошибка, извлекаем в фоне после сохранения
                pass

    update_unread_ops = {}
    other_participants = []
    for p_email in chat.get("participants", []):
        if p_email.lower() != current_user["email"].lower():
            other_participants.append(p_email)
            # Экранируем точки для MongoDB
            safe_email = p_email.replace(".", "_dot_")
            update_unread_ops[f"unread_count.{safe_email}"] = 1
    
    # Сохраняем сообщение
    update_query = {"$push": {"messages": new_message}, "$set": {"last_message_at": new_message["timestamp"]}}
    if update_unread_ops:
        update_query["$inc"] = update_unread_ops
        
    await chats_collection.update_one({"_id": chat_oid}, update_query)
    
    # Если превью не было получено, пытаемся извлечь в фоне
    if message_content and not file and not new_message.get("link_preview"):
        url_pattern = re.compile(r'https?://[^\s<>"{}|\\^`\[\]]+', re.IGNORECASE)
        found_urls = url_pattern.findall(message_content)
        if found_urls:
            first_url = found_urls[0]
            # Запускаем фоновую задачу для извлечения превью
            asyncio.create_task(extract_link_preview_async(first_url, chat_oid, new_message["_id"]))

    update_unread_ops = {}
    other_participants = []
    for p_email in chat.get("participants", []):
        if p_email != current_user["email"]:
            other_participants.append(p_email)
            update_unread_ops[f"unread_count.{p_email}"] = 1
    
    # ===================================================================

    new_message_for_response = new_message.copy()
    new_message_for_response["_id"] = str(new_message_for_response["_id"])
    new_message_for_response["timestamp"] = new_message_for_response["timestamp"].isoformat() + "Z"
    new_message_for_response["chat_id"] = chat_id
    
    # Для групповых чатов добавляем информацию об отправителе
    chat_type = chat.get("chat_type", "private")
    if chat_type == "group":
        sender_email = current_user["email"]
        try:
            sender_user = await users_collection.find_one(
                {"email": sender_email},
                {"username": 1, "full_name": 1, "profile_picture": 1}
            )
            if sender_user:
                new_message_for_response["sender_name"] = sender_user.get("full_name") or sender_user.get("username") or sender_email
                new_message_for_response["sender_avatar"] = sender_user.get("profile_picture") or "/images/юзер.svg"
            else:
                new_message_for_response["sender_name"] = sender_email
                new_message_for_response["sender_avatar"] = "/images/юзер.svg"
        except Exception as e:
            # Не блокируем доставку сообщений из-за проблем с профилем отправителя
            print(f"[send_message] failed to load sender profile for group message: {e}")
            new_message_for_response["sender_name"] = sender_email
            new_message_for_response["sender_avatar"] = "/images/юзер.svg"
    
    participants = chat.get("participants", [])
    await manager.broadcast_to_participants(participants, new_message_for_response)
    
    updated_chat = await chats_collection.find_one({"_id": chat_oid}, {"unread_count": 1})
    unread_counts = updated_chat.get("unread_count", {})

    tasks = []
    for email in other_participants:
        safe_email = email.replace(".", "_dot_")
        tasks.append(
            manager.send_to_user(email, {
                "type": "unread_count_update",
                "chat_id": chat_id,
                "count": unread_counts.get(safe_email, 1)
            })
        )
    if tasks:
        await asyncio.gather(*tasks)
    
    # === ОБРАБОТКА БОТОВ ===
    # Если это чат с ботом и отправлено текстовое сообщение, получаем ответ от бота
    if chat.get("chat_type") == "bot" and message_content and not file:
        bot_id = chat.get("bot_id")
        if bot_id:
            # Импортируем функцию для обработки сообщения боту
            from backend.routes.bots import process_bot_message
            # Запускаем в фоне, чтобы не блокировать ответ
            asyncio.create_task(
                process_bot_message(bot_id, message_content, chat_id, current_user["email"])
            )
    # === КОНЕЦ ОБРАБОТКИ БОТОВ ===
    
    return JSONResponse(content={"message_data": new_message_for_response})
# ===================================================================
# === КОНЕЦ БЛОКА ===================================================
# ===================================================================

@router.post("/api/upload_audio/{chat_id}", summary="Загрузить голосовое сообщение")
async def upload_audio_message(
    chat_id: str,
    file: Annotated[UploadFile, File()],
    duration: Annotated[Optional[float], Form()] = None,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)] = None
):
    """
    Принимает аудиофайл с клиента (например webm/ogg), конвертирует в mp3,
    сохраняет и создает сообщение типа 'audio' с длительностью.
    """
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    try:
        chat_oid = ObjectId(chat_id)
    except Exception as e:
        print(f"Ошибка парсинга chat_id: {e}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Чат не найден.")
    if current_user["email"] not in chat["participants"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Нет доступа к чату.")

    # 1) Сохраняем входной файл во временный путь
    tmp_in_path = None
    unique_name = None
    output_path = None
    
    try:
        # Проверяем, что файл был передан
        if not file:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Файл не был передан.")
        
        # Проверяем размер файла до загрузки
        file.file.seek(0, 2)  # Переходим в конец файла
        file_size_check = file.file.tell()
        file.file.seek(0)  # Возвращаемся в начало
        
        if file_size_check == 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Загруженный файл пуст.")
        
        # Определяем расширение файла
        file_ext = Path(file.filename or "audio.webm").suffix
        if not file_ext or file_ext not in [".webm", ".ogg", ".wav", ".mp3", ".m4a"]:
            file_ext = ".webm"
        
        # Создаем временный файл
        tmp_in = tempfile.NamedTemporaryFile(delete=False, suffix=file_ext)
        tmp_in_path = Path(tmp_in.name)
        
        # Записываем данные в файл
        try:
            file.file.seek(0)  # Убеждаемся, что мы в начале файла
            shutil.copyfileobj(file.file, tmp_in)
            tmp_in.flush()  # Принудительно записываем буфер
            os.fsync(tmp_in.fileno())  # Синхронизируем с диском
        except Exception as e:
            tmp_in.close()
            if tmp_in_path.exists():
                tmp_in_path.unlink(missing_ok=True)
            raise RuntimeError(f"Ошибка записи файла: {e}")
        
        # Закрываем файл, чтобы убедиться, что все данные записаны
        tmp_in.close()
        
        # Проверяем, что файл создан и не пустой
        if not tmp_in_path.exists():
            raise RuntimeError(f"Временный файл не был создан: {tmp_in_path}")
        
        file_size = tmp_in_path.stat().st_size
        if file_size == 0:
            raise RuntimeError("Загруженный файл пуст")
        
        print(f"Временный файл создан: {tmp_in_path}, размер: {file_size} байт")
        
        # 2) Пробуем конвертировать в mp3, если ffmpeg доступен
        # Если ffmpeg недоступен, сохраняем файл как есть
        unique_name = None
        output_path = None
        
        # Проверяем, доступен ли ffmpeg
        ffmpeg_exe = _find_ffmpeg()
        ffmpeg_available = False
        
        if ffmpeg_exe and ffmpeg_exe != "ffmpeg":
            # Если найден полный путь, проверяем существование
            ffmpeg_available = os.path.exists(ffmpeg_exe)
        else:
            # Если просто "ffmpeg", проверяем через which
            ffmpeg_available = shutil.which("ffmpeg") is not None
        
        if ffmpeg_available:
            try:
                # Конвертируем в mp3
                unique_name = f"{uuid.uuid4()}.mp3"
                output_path = UPLOAD_DIR / unique_name
                output_path.parent.mkdir(parents=True, exist_ok=True)
                
                print(f"Начинаем конвертацию в: {output_path} (используя {ffmpeg_exe})")
                _run_ffmpeg_convert(tmp_in_path, output_path)
                
                # Проверяем, что выходной файл создан и не пустой
                if not output_path.exists():
                    raise RuntimeError(f"Выходной файл не был создан: {output_path}")
                
                output_size = output_path.stat().st_size
                if output_size == 0:
                    raise RuntimeError("Выходной файл пуст после конвертации")
                
                print(f"Конвертация завершена успешно, размер выходного файла: {output_size} байт")
            except Exception as conv_error:
                # Если конвертация не удалась, сохраняем оригинал
                print(f"Ошибка конвертации: {conv_error}, сохраняем оригинальный файл")
                ffmpeg_available = False
        
        if not ffmpeg_available or not output_path or not output_path.exists():
            # Сохраняем оригинальный файл
            print("Сохраняем оригинальный файл без конвертации")
            file_ext = tmp_in_path.suffix or ".webm"
            unique_name = f"{uuid.uuid4()}{file_ext}"
            output_path = UPLOAD_DIR / unique_name
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Копируем оригинальный файл
            shutil.copy2(tmp_in_path, output_path)
            
            if not output_path.exists():
                raise RuntimeError(f"Не удалось скопировать файл: {output_path}")
            
            output_size = output_path.stat().st_size
            print(f"Файл сохранен без конвертации, размер: {output_size} байт")
        
    except HTTPException:
        # Пробрасываем HTTP исключения как есть
        raise
    except Exception as e:
        print(f"Ошибка обработки аудио: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        # Удаляем временный файл при ошибке
        if tmp_in_path and tmp_in_path.exists():
            try:
                tmp_in_path.unlink(missing_ok=True)
            except Exception:
                pass
        # Удаляем выходной файл при ошибке
        if output_path and output_path.exists():
            try:
                output_path.unlink(missing_ok=True)
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Ошибка обработки аудио: {str(e)}")
    finally:
        # Удаляем временный файл после обработки
        if tmp_in_path and tmp_in_path.exists():
            try:
                tmp_in_path.unlink(missing_ok=True)
            except Exception:
                pass

    # 3) Проверяем, что выходной файл был создан
    if not output_path or not output_path.exists():
        raise HTTPException(status_code=500, detail="Выходной аудио файл не был создан")
    
    # 4) Длительность: берем с клиента или пробуем определить через ffprobe
    seconds = 0.0
    if isinstance(duration, (int, float)) and float(duration) > 0:
        seconds = float(duration)
    if not seconds or seconds <= 0:
        seconds = _probe_duration_seconds(output_path)
    if not seconds or seconds <= 0:
        seconds = 1.0  # Минимальная длительность по умолчанию

    # 5) Создаем сообщение
    new_message = {
        "_id": ObjectId(),
        "sender_id": current_user["email"],
        "content": "",
        "timestamp": datetime.utcnow(),
        "type": "audio",
        "file_url": f"/static/uploads/{unique_name}",
        "filename": file.filename or unique_name,
        "audio_duration": seconds,
        "deleted_for_users": [],
        "read_by": []
    }

    # 5) Обновляем чат и непрочитанные
    update_unread_ops = {}
    other_participants = []
    for p_email in chat.get("participants", []):
        if p_email != current_user["email"]:
            other_participants.append(p_email)
            safe_email = p_email.replace(".", "_dot_")
            update_unread_ops[f"unread_count.{safe_email}"] = 1

    update_query = {
        "$push": {"messages": new_message},
        "$set": {"last_message_at": new_message["timestamp"]}
    }
    if update_unread_ops:
        update_query["$inc"] = update_unread_ops
    await chats_collection.update_one({"_id": chat_oid}, update_query)

    # 6) Рассылаем по WS
    new_message_for_response = new_message.copy()
    new_message_for_response["_id"] = str(new_message_for_response["_id"])
    new_message_for_response["timestamp"] = new_message_for_response["timestamp"].isoformat() + "Z"
    new_message_for_response["chat_id"] = chat_id
    # Убеждаемся, что sender_email есть для правильного отображения
    if "sender_email" not in new_message_for_response:
        new_message_for_response["sender_email"] = new_message_for_response.get("sender_id", current_user["email"])
    
    # Для групповых чатов добавляем информацию об отправителе
    chat_type = chat.get("chat_type", "private")
    if chat_type == "group":
        sender_email = current_user["email"]
        sender_user = await users_collection.find_one(
            {"email": sender_email},
            {"username": 1, "full_name": 1, "profile_picture": 1}
        )
        if sender_user:
            new_message_for_response["sender_name"] = sender_user.get("full_name") or sender_user.get("username") or sender_email
            new_message_for_response["sender_avatar"] = sender_user.get("profile_picture") or "/images/юзер.svg"
        else:
            new_message_for_response["sender_name"] = sender_email
            new_message_for_response["sender_avatar"] = "/images/юзер.svg"
    
    await manager.broadcast_to_participants(chat.get("participants", []), new_message_for_response)

    # 7) Обновляем счетчики у участников
    updated_chat = await chats_collection.find_one({"_id": chat_oid}, {"unread_count": 1})
    unread_counts = updated_chat.get("unread_count", {})
    tasks = []
    for email in other_participants:
        safe_email = email.replace(".", "_dot_")
        tasks.append(
            manager.send_to_user(email, {
                "type": "unread_count_update",
                "chat_id": chat_id,
                "count": unread_counts.get(safe_email, 1)
            })
        )
    if tasks:
        await asyncio.gather(*tasks)

    return JSONResponse(content={"message_data": new_message_for_response})


# ===================================================================
# === delete_message (Без изменений) ================================
# ===================================================================
@router.delete("/api/delete_message/{message_id}", summary="Удалить сообщение из чата")
async def delete_message(
    message_id: str,
    delete_body: DeleteMessageBody,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    chats_collection = db_module.get_chats_collection()
    try:
        message_oid = ObjectId(message_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат ID сообщения.")
    
    chat = await chats_collection.find_one({"messages._id": message_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Сообщение или чат не найден.")
    if current_user["email"] not in chat["participants"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этому чату.")

    message_obj = next((msg for msg in chat.get("messages", []) if msg.get("_id") == message_oid), None)
    if not message_obj:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Сообщение не найдено.")
    
    is_sender = message_obj["sender_id"] == current_user["email"]
    chat_id = str(chat["_id"])
    participants = chat.get("participants", [])
    
    if delete_body.delete_for_all:
        if not is_sender:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Вы можете удалить для всех только свои сообщения.")
        
        if message_obj.get("file_url") and message_obj["file_url"].startswith("/static/uploads/"):
            file_path = UPLOAD_DIR / Path(message_obj["file_url"]).name
            if file_path.exists(): file_path.unlink()
        
        await chats_collection.update_one({"_id": chat["_id"]}, {"$pull": {"messages": {"_id": message_oid}}})
        
        updated_chat = await chats_collection.find_one({"_id": chat["_id"]})
        all_messages = updated_chat.get("messages", [])
        
        new_last_message = all_messages[-1] if all_messages else None
        new_last_content = "Нет сообщений"
        new_last_timestamp = updated_chat["created_at"]
        if new_last_message:
            msg_type = new_last_message.get("type") or "text"
            if msg_type == "audio":
                new_last_content = "Голосовое сообщение"
            elif msg_type == "image":
                new_last_content = "Фотография"
            elif msg_type == "video":
                new_last_content = "Видео"
            elif msg_type == "file":
                new_last_content = new_last_message.get("filename") or "Файл"
            else:
                new_last_content = new_last_message.get("content", "")
            new_last_timestamp = new_last_message["timestamp"]
            
        new_counts = {}
        for p_email in participants:
            count = 0
            for msg in all_messages:
                if msg.get("sender_id") != p_email and p_email not in msg.get("read_by", []):
                    count += 1
            new_counts[p_email] = count
        
        await chats_collection.update_one(
            {"_id": chat["_id"]}, 
            {"$set": {
                "last_message_at": new_last_timestamp,
                "unread_count": new_counts
            }}
        )

        delete_broadcast_data = {"type": "delete_message", "message_id": message_id, "chat_id": chat_id}
        await manager.broadcast_to_participants(participants, delete_broadcast_data)
        
        tasks = []
        for email in participants:
            current_last_message_status = None
            if new_last_message and new_last_message.get("sender_id") == email:
                read_by_others = any(p != email for p in new_last_message.get("read_by", []))
                current_last_message_status = "read" if read_by_others else "sent"
            
            tasks.append(
                manager.send_to_user(email, {
                    "type": "chat_list_update", 
                    "chat_id": chat_id, 
                    "last_message_content": new_last_content, 
                    "last_message_timestamp": new_last_timestamp.isoformat() + "Z",
                    "last_message_status": current_last_message_status
                })
            )
            
            tasks.append(
                manager.send_to_user(email, {
                    "type": "unread_count_update",
                    "chat_id": chat_id,
                    "count": new_counts.get(email, 0)
                })
            )
        if tasks:
            await asyncio.gather(*tasks)

        return JSONResponse(content={"status": "success", "message": "Сообщение удалено у всех."})
    
    else:
        await chats_collection.update_one(
            {"_id": chat["_id"], "messages._id": message_oid}, 
            {"$addToSet": {"messages.$.deleted_for_users": current_user["email"]}}
        )
        return JSONResponse(content={"status": "success", "message": "Сообщение удалено у вас."})

# ===================================================================
# === pin_message (НОВЫЙ) ===========================================
# ===================================================================
@router.post("/api/pin_message/{message_id}", summary="Закрепить/открепить сообщение в чате")
async def pin_message(
    message_id: str,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    chats_collection = db_module.get_chats_collection()
    try:
        message_oid = ObjectId(message_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат ID сообщения.")
    
    chat = await chats_collection.find_one({"messages._id": message_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Сообщение или чат не найдено.")
    if current_user["email"] not in chat["participants"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этому чату.")

    message_obj = next((msg for msg in chat.get("messages", []) if msg.get("_id") == message_oid), None)
    if not message_obj:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Сообщение не найдено.")
    
    chat_id = str(chat["_id"])
    participants = chat.get("participants", [])
    current_pinned = chat.get("pinned_message_id")
    
    # Если сообщение уже закреплено, открепляем его
    if current_pinned == message_oid:
        await chats_collection.update_one(
            {"_id": chat["_id"]},
            {"$unset": {"pinned_message_id": ""}}
        )
        action = "unpinned"
        pinned_message_id = None
    else:
        # Закрепляем новое сообщение
        await chats_collection.update_one(
            {"_id": chat["_id"]},
            {"$set": {"pinned_message_id": message_oid}}
        )
        action = "pinned"
        pinned_message_id = message_id
    
    # Отправляем уведомление всем участникам
    pin_broadcast_data = {
        "type": "pin_message",
        "chat_id": chat_id,
        "message_id": message_id,
        "action": action,
        "pinned_message_id": pinned_message_id
    }
    await manager.broadcast_to_participants(participants, pin_broadcast_data)
    
    return JSONResponse(content={
        "status": "success",
        "message": f"Сообщение {'закреплено' if action == 'pinned' else 'откреплено'}.",
        "action": action,
        "pinned_message_id": pinned_message_id
    })

# ===================================================================
# === КОНЕЦ БЛОКА ===================================================
# ===================================================================


# --- (clear_chat и delete_chat - БЕЗ ИЗМЕНЕНИЙ) ---
@router.delete("/api/clear_chat/{chat_id}", summary="Очистить историю чата")
async def clear_chat(chat_id: str, request: Request, current_user: Annotated[Dict[str, Any], Depends(get_current_user)]):
    chats_collection = db_module.get_chats_collection()
    try: chat_oid = ObjectId(chat_id)
    except Exception: raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный Chat ID")
    chat = await chats_collection.find_one({"_id": chat_oid})
    if not chat: raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Чат не найден")
    if current_user["email"] not in chat["participants"]: raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Нет доступа к чату")
    body = await request.json()
    delete_for_all = body.get("delete_for_all", False)
    participants = chat.get("participants", [])
    
    if delete_for_all:
        for msg in chat.get("messages", []):
            file_url = msg.get("file_url")
            if file_url and file_url.startswith("/static/uploads/"):
                file_path = UPLOAD_DIR / Path(file_url).name
                if file_path.exists(): file_path.unlink()
        await chats_collection.update_one({"_id": chat_oid}, {"$set": {"messages": [], "last_message_at": datetime.utcnow(), "unread_count": {}}})
        # Отправляем уведомление всем участникам через WebSocket
        await manager.broadcast_to_participants(participants, {
            "type": "chat_cleared",
            "chat_id": chat_id
        })
        return JSONResponse({"status": "success", "message": "Чат очищен у всех"})
    else:
        hidden_for = set(chat.get("hidden_for", []))
        hidden_for.add(current_user["email"])
        await chats_collection.update_one({"_id": chat_oid}, {"$set": {"hidden_for": list(hidden_for)}})
        # Отправляем уведомление пользователю через WebSocket
        await manager.send_to_user(current_user["email"], {
            "type": "chat_hidden",
            "chat_id": chat_id
        })
        return JSONResponse({"status": "success", "message": "Чат скрыт у вас"})

@router.delete("/api/delete_chat/{chat_id}", summary="Удалить чат")
async def delete_chat(chat_id: str, request: Request, current_user: Annotated[Dict[str, Any], Depends(get_current_user)]):
    chats_collection = db_module.get_chats_collection()
    try: chat_oid = ObjectId(chat_id)
    except Exception: raise HTTPException(status_code=400, detail="Неверный Chat ID")
    chat = await chats_collection.find_one({"_id": chat_oid})
    if not chat: raise HTTPException(status_code=404, detail="Чат не найден")
    if current_user["email"] not in chat["participants"]: raise HTTPException(status_code=403, detail="Нет доступа к чату")
    
    body = await request.json()
    delete_for_all = body.get("delete_for_all", False)
    
    if delete_for_all:
        # Удаляем чат полностью (только для приватных чатов или если пользователь владелец группы)
        chat_type = chat.get("chat_type", "private")
        if chat_type == "private":
            await chats_collection.delete_one({"_id": chat_oid})
            # Отправляем уведомление участникам через WebSocket
            participants = chat.get("participants", [])
            await manager.broadcast_to_participants(participants, {
                "type": "chat_deleted",
                "chat_id": chat_id
            })
            return JSONResponse({"status": "success", "message": "Чат удален у всех"})
        elif chat_type == "group":
            # Для групп удаляем только если пользователь владелец
            owner = chat.get("owner")
            if owner == current_user["email"]:
                await chats_collection.delete_one({"_id": chat_oid})
                # Отправляем уведомление участникам через WebSocket
                participants = chat.get("participants", [])
                await manager.broadcast_to_participants(participants, {
                    "type": "chat_deleted",
                    "chat_id": chat_id
                })
                return JSONResponse({"status": "success", "message": "Группа удалена у всех"})
            else:
                raise HTTPException(status_code=403, detail="Только владелец группы может удалить её для всех")
        else:
            # Для других типов чатов (боты, избранное) удаляем только у пользователя
            hidden_for = set(chat.get("hidden_for", []))
            hidden_for.add(current_user["email"])
            await chats_collection.update_one({"_id": chat_oid}, {"$set": {"hidden_for": list(hidden_for)}})
            return JSONResponse({"status": "success", "message": "Чат скрыт у вас"})
    else:
        # Удаляем чат только у текущего пользователя (скрываем)
        hidden_for = set(chat.get("hidden_for", []))
        hidden_for.add(current_user["email"])
        await chats_collection.update_one({"_id": chat_oid}, {"$set": {"hidden_for": list(hidden_for)}})
        # Отправляем уведомление пользователю через WebSocket
        await manager.send_to_user(current_user["email"], {
            "type": "chat_hidden",
            "chat_id": chat_id
        })
        return JSONResponse({"status": "success", "message": "Чат скрыт у вас"})

# ===================================================================
# === create_group (НОВЫЙ) =========================================
# ===================================================================
@router.post("/api/groups/create", summary="Создать новую группу")
async def create_group(
    request: Request,
    avatar_file: Annotated[Optional[UploadFile], File()] = None,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)] = None
):
    """Создает новую группу с указанным названием, аватаром и участниками."""
    if current_user is None:
        from backend.dependencies import get_current_user
        current_user = await get_current_user()
    
    # Получаем данные из формы
    form_data = await request.form()
    name = form_data.get("name", "").strip()
    
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Название группы обязательно."
        )
    
    # Получаем список participant_emails из формы (может быть несколько значений с одинаковым ключом)
    # В Starlette FormData множественные значения нужно получать через getlist()
    participant_emails = []
    participant_usernames = []
    
    # Получаем все значения для ключа "participant_emails"
    try:
        # Starlette FormData имеет метод getlist() для получения всех значений с одинаковым ключом
        emails_list = form_data.getlist("participant_emails")
        if emails_list:
            participant_emails = [str(e).strip() for e in emails_list if e and str(e).strip()]
    except Exception as e:
        print(f"[create_group] Error getting participant_emails: {e}")
        # Fallback: пытаемся получить одно значение
        single_email = form_data.get("participant_emails")
        if single_email:
            participant_emails = [str(single_email).strip()]
    
    # Получаем все значения для ключа "participant_usernames"
    try:
        usernames_list = form_data.getlist("participant_usernames")
        if usernames_list:
            participant_usernames = [str(u).strip() for u in usernames_list if u and str(u).strip()]
    except Exception as e:
        print(f"[create_group] Error getting participant_usernames: {e}")
        single_username = form_data.get("participant_usernames")
        if single_username:
            participant_usernames = [str(single_username).strip()]
    
    # Логируем для отладки
    print(f"[create_group] Received name: {name}")
    print(f"[create_group] Received participant_emails (raw): {form_data.get('participant_emails')}")
    print(f"[create_group] Received participant_emails (processed): {participant_emails}")
    print(f"[create_group] Received participant_usernames: {participant_usernames}")
    print(f"[create_group] Received avatar_file: {avatar_file}")
    
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    current_user_email = current_user["email"]
    current_user_email_norm = current_user_email.strip().lower()
    
    # Собираем всех участников
    participants = [current_user_email_norm]  # Создатель всегда участник
    
    print(f"[create_group] Starting with participants: {participants}")
    print(f"[create_group] Processing {len(participant_emails)} participant emails")
    
    # Добавляем участников по email
    email_pattern = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
    valid_emails_added = 0
    for email in participant_emails:
        if not email:
            continue
        
        email_trimmed = email.strip()
        email_lower = email_trimmed.lower()
        
        # Пропускаем самого создателя и уже добавленных (без учета регистра)
        if email_lower == current_user_email_norm or email_lower in [p.lower() for p in participants]:
            continue
        
        # 1) Стандартная проверка формата
        if email_pattern.match(email_trimmed):
            participants.append(email_lower)
            valid_emails_added += 1
            print(f"[create_group] Added participant: {email_trimmed}")
            continue
        
        # 2) Фолбэк: ищем пользователя в базе даже с «нестандартным» email
        user = await users_collection.find_one({
            "email": {"$regex": f"^{re.escape(email_trimmed)}$", "$options": "i"}
        })
        if user:
            user_email = user.get("email", email_trimmed)
            user_email_lower = user_email.strip().lower()
            if user_email_lower != current_user_email_norm and user_email_lower not in [p.lower() for p in participants]:
                participants.append(user_email_lower)
                valid_emails_added += 1
                print(f"[create_group] Added participant from DB: {user_email}")
        else:
            print(f"[create_group] Skipped invalid email: {email}")
    
    # Проверяем, что добавлен хотя бы один валидный участник
    if valid_emails_added == 0 and len(participant_emails) > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Не удалось добавить участников. Проверьте правильность email адресов."
        )
    
    print(f"[create_group] Final participants list: {participants}")
    
    # Добавляем участников по username
    for username in participant_usernames:
        if username:
            user = await users_collection.find_one({"username": username})
            if user:
                email = user.get("email")
                email_norm = email.strip().lower() if email else None
                if email_norm and email_norm != current_user_email_norm and email_norm not in [p.lower() for p in participants]:
                    participants.append(email_norm)
    
    # Должно быть минимум 2 участника (создатель + хотя бы один)
    # Проверяем, что добавлен хотя бы один валидный участник (кроме создателя)
    if len(participants) < 2:
        # Если нет участников, но были переданы email, значит они были невалидными
        if len(participant_emails) > 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Не удалось добавить участников. Проверьте правильность email адресов."
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Группа должна содержать минимум 2 участника (включая создателя)."
            )
    
    # Обрабатываем аватар
    group_avatar = "/images/юзер.svg"
    if avatar_file and avatar_file.filename:
        # Сохраняем файл
        file_ext = Path(avatar_file.filename).suffix
        unique_filename = f"{uuid.uuid4()}{file_ext}"
        file_path = UPLOAD_DIR / unique_filename
        
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(avatar_file.file, buffer)
        
        group_avatar = f"/static/uploads/{unique_filename}"
    
    # Получаем имя создателя группы
    creator_user = await users_collection.find_one(
        {"email": current_user_email},
        {"username": 1, "full_name": 1}
    )
    creator_name = creator_user.get("full_name") or creator_user.get("username") or current_user_email if creator_user else current_user_email
    
    # Получаем имена добавленных участников (кроме создателя)
    added_participants = [p for p in participants if p != current_user_email]
    added_users_info = []
    for email in added_participants:
        user = await users_collection.find_one(
            {"email": email},
            {"username": 1, "full_name": 1}
        )
        if user:
            user_name = user.get("full_name") or user.get("username") or email
            added_users_info.append(user_name)
        else:
            added_users_info.append(email)
    
    # Формируем текст системного сообщения
    if len(added_users_info) == 0:
        system_message_text = f"{creator_name} создал(а) группу"
    elif len(added_users_info) == 1:
        system_message_text = f"{creator_name} создал(а) группу и добавил(а) {added_users_info[0]}"
    else:
        users_list = ", ".join(added_users_info[:-1]) + " и " + added_users_info[-1]
        system_message_text = f"{creator_name} создал(а) группу и добавил(а) {users_list}"
    
    # Создаем системное сообщение
    system_message = {
        "_id": ObjectId(),
        "sender_id": "system",
        "content": system_message_text,
        "timestamp": datetime.utcnow(),
        "type": "system",
        "deleted_for_users": [],
        "read_by": []
    }
    
    # Создаем группу
    new_group_document = {
        "participants": participants,
        "messages": [system_message],
        "created_at": datetime.utcnow(),
        "last_message_at": datetime.utcnow(),
        "chat_type": "group",
        "group_name": name,
        "group_avatar": group_avatar,
        "owner": current_user_email,
        "admins": [],  # Список админов группы (пустой при создании)
        "unread_count": {},
        "allow_members_edit_settings": False  # По умолчанию только владелец может менять настройки
    }
    
    insert_result = await chats_collection.insert_one(new_group_document)
    chat_id = str(insert_result.inserted_id)

    # Оповещаем всех участников о создании группы, чтобы она появилась без перезагрузки
    try:
        await manager.broadcast_to_participants(participants, {
            "type": "chat_created",
            "chat_id": chat_id,
            "chat_type": "group"
        })
    except Exception as e:
        print(f"[create_group] Failed to broadcast chat_created: {e}")

    return JSONResponse(content={
        "chat_id": chat_id,
        "group_name": name,
        "group_avatar": group_avatar,
        "participants": participants
    })

@router.get("/api/groups", summary="Получить список групп пользователя")
async def get_groups(
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Возвращает список всех групп, в которых участвует пользователь."""
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    current_user_email = current_user["email"]
    current_user_email_norm = current_user_email.strip().lower()
    
    # Находим все группы пользователя
    groups_raw = await chats_collection.find({
        "participants": {"$regex": f"^{re.escape(current_user_email_norm)}$", "$options": "i"},
        "chat_type": "group"
    }).to_list(100)
    
    formatted_groups = []
    for group_doc in groups_raw:
        filtered_messages = [msg for msg in group_doc.get("messages", []) 
                           if current_user_email_norm not in [u.lower() for u in msg.get("deleted_for_users", [])]]
        
        last_message = filtered_messages[-1] if filtered_messages else None
        
        if last_message:
            last_timestamp = last_message.get("timestamp") or group_doc.get("last_message_at")
        else:
            last_timestamp = group_doc.get("created_at", datetime.min)
        
        # Формируем превью последнего сообщения
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
                sender_email = last_message.get("sender_id") or last_message.get("sender_email")
                if sender_email and sender_email.lower() == current_user_email_norm:
                    last_message_content = last_message.get("content") or None
                else:
                    # Получаем имя отправителя
                    sender_user = await users_collection.find_one(
                        {"email": sender_email},
                        {"username": 1, "full_name": 1}
                    )
                    sender_name = "Неизвестный"
                    if sender_user:
                        sender_name = sender_user.get("full_name") or sender_user.get("username") or sender_email
                    last_message_content = f"{sender_name}: {last_message.get('content', '')}"
        
        # Подсчитываем количество участников
        participant_count = len(group_doc.get("participants", []))
        
        formatted_groups.append({
            "chat_id": str(group_doc["_id"]),
            "group_name": group_doc.get("group_name", "Группа"),
            "group_avatar": group_doc.get("group_avatar", "/images/юзер.svg"),
            "participant_count": participant_count,
            "last_message_content": last_message_content,
            "last_message_timestamp": last_message.isoformat() + "Z" if isinstance(last_message, datetime) else (last_timestamp.isoformat() + "Z" if isinstance(last_timestamp, datetime) else str(last_timestamp)),
            "unread_count": group_doc.get("unread_count", {}).get(current_user_email_norm, 0),
            "owner": group_doc.get("owner"),
            "is_owner": (group_doc.get("owner") or "").lower() == current_user_email_norm
        })
    
    # Сортируем по времени последнего сообщения
    formatted_groups.sort(key=lambda x: x.get("last_message_timestamp", ""), reverse=True)
    
    return JSONResponse(content={"groups": formatted_groups})

# ===================================================================
# === get_group_settings - Получить настройки группы ===============
# ===================================================================
@router.get("/api/groups/{chat_id}/settings", summary="Получить настройки группы")
async def get_group_settings(
    chat_id: str,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Возвращает настройки группы и проверяет права пользователя на их изменение."""
    chats_collection = db_module.get_chats_collection()
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Группа не найдена.")
    
    if chat.get("chat_type") != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Это не группа.")
    
    current_user_email_norm = current_user["email"].strip().lower()
    participants_norm = [p.lower() for p in chat.get("participants", [])]
    if current_user_email_norm not in participants_norm:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этой группе.")
    
    owner_email = chat.get("owner")
    is_owner = (owner_email or "").lower() == current_user_email_norm
    allow_members_edit = chat.get("allow_members_edit_settings", False)
    can_edit_settings = is_owner or allow_members_edit
    
    return JSONResponse(content={
        "chat_id": str(chat["_id"]),
        "group_name": chat.get("group_name", "Группа"),
        "group_avatar": chat.get("group_avatar", "/images/юзер.svg"),
        "owner": owner_email,
        "is_owner": is_owner,
        "allow_members_edit_settings": allow_members_edit,
        "can_edit_settings": can_edit_settings,
        "participants_count": len(chat.get("participants", []))
    })

# ===================================================================
# === update_group_settings - Обновить настройки группы ============
# ===================================================================
@router.put("/api/groups/{chat_id}/settings", summary="Обновить настройки группы")
async def update_group_settings(
    chat_id: str,
    request: Request,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Обновляет настройки группы. Только владелец или участники (если разрешено) могут изменять настройки."""
    chats_collection = db_module.get_chats_collection()
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Группа не найдена.")
    
    if chat.get("chat_type") != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Это не группа.")
    
    if current_user["email"] not in chat.get("participants", []):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этой группе.")
    
    # Проверяем права на изменение настроек
    owner_email = chat.get("owner")
    is_owner = owner_email == current_user["email"]
    allow_members_edit = chat.get("allow_members_edit_settings", False)
    
    print(f"[update_group_settings] Проверка прав: user={current_user['email']}, owner={owner_email}, is_owner={is_owner}, allow_members_edit={allow_members_edit}")
    
    if not is_owner and not allow_members_edit:
        print(f"[update_group_settings] Доступ запрещен для пользователя {current_user['email']}")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Владелец группы не разрешил участникам изменять настройки."
        )
    
    try:
        body = await request.json()
    except Exception as e:
        print(f"[update_group_settings] Ошибка парсинга JSON: {e}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат данных запроса.")
    
    # Если body пустой или None, это не ошибка - просто нет данных для обновления
    if not body:
        print(f"[update_group_settings] Пустое тело запроса для группы {chat_id}, пользователь {current_user['email']}")
        return JSONResponse(content={
            "status": "success",
            "message": "Нет данных для обновления",
            "settings": {}
        })
    
    update_data = {}
    old_name = chat.get("group_name", "Группа")
    old_avatar = chat.get("group_avatar", "/images/юзер.svg")
    
    # Обновление названия группы
    if "group_name" in body:
        new_name = body["group_name"].strip() if body["group_name"] else ""
        if new_name and new_name != old_name:
            update_data["group_name"] = new_name
        elif new_name == old_name:
            # Название не изменилось, но это не ошибка - просто ничего не обновляем
            print(f"[update_group_settings] Название не изменилось: {old_name}")
    
    # Обновление аватара группы (требует отдельный endpoint с файлом)
    # Здесь мы только обновляем URL, если он передан
    
    # Обновление разрешения участникам менять настройки (только для владельца)
    # Если пользователь не владелец, игнорируем это поле
    if "allow_members_edit_settings" in body:
        if is_owner:
            new_value = bool(body["allow_members_edit_settings"])
            old_value = chat.get("allow_members_edit_settings", False)
            if new_value != old_value:
                update_data["allow_members_edit_settings"] = new_value
        else:
            # Если не владелец, просто игнорируем это поле (не добавляем в update_data)
            print(f"[update_group_settings] Пользователь {current_user['email']} не владелец, игнорируем allow_members_edit_settings")
    
    # Если нет изменений, возвращаем успех без обновления БД
    if not update_data:
        print(f"[update_group_settings] Нет изменений для группы {chat_id}, пользователь {current_user['email']}")
        return JSONResponse(content={
            "status": "success",
            "message": "Настройки не изменились",
            "settings": {}
        })
    
    print(f"[update_group_settings] Обновление группы {chat_id}: {update_data}, пользователь {current_user['email']}, is_owner: {is_owner}, allow_members_edit: {allow_members_edit}")
    
    # Получаем имя пользователя для системного сообщения
    users_collection = db_module.get_users_collection()
    user_doc = await users_collection.find_one({"email": current_user["email"]}, {"username": 1, "full_name": 1})
    user_name = user_doc.get("full_name") or user_doc.get("username") or current_user["email"] if user_doc else current_user["email"]
    
    # Создаем системное сообщение об изменении названия
    system_messages = []
    if "group_name" in update_data:
        system_message = {
            "_id": ObjectId(),
            "sender_id": "system",
            "content": f"{user_name} изменил(а) название группы на «{update_data['group_name']}»",
            "timestamp": datetime.utcnow(),
            "type": "system",
            "deleted_for_users": [],
            "read_by": []
        }
        system_messages.append(system_message)
    
    # Обновляем группу в БД
    update_query = {"$set": update_data}
    if system_messages:
        update_query["$push"] = {"messages": {"$each": system_messages}}
        update_query["$set"]["last_message_at"] = datetime.utcnow()
    
    await chats_collection.update_one({"_id": chat_oid}, update_query)
    
    # Отправляем обновление через WebSocket
    participants = chat.get("participants", [])
    
    # Отправляем системные сообщения через WebSocket
    for sys_msg in system_messages:
        sys_msg_for_response = sys_msg.copy()
        sys_msg_for_response["_id"] = str(sys_msg_for_response["_id"])
        sys_msg_for_response["timestamp"] = sys_msg_for_response["timestamp"].isoformat() + "Z"
        sys_msg_for_response["chat_id"] = chat_id
        await manager.broadcast_to_participants(participants, sys_msg_for_response)
    
    # Отправляем обновление настроек через WebSocket
    await manager.broadcast_to_participants(participants, {
        "type": "group_settings_updated",
        "chat_id": chat_id,
        "settings": update_data,
        "old_name": old_name if "group_name" in update_data else None,
        "old_avatar": old_avatar if "group_avatar" in update_data else None
    })
    
    # Подготавливаем данные для ответа (убеждаемся, что все сериализуемо)
    response_settings = {}
    for key, value in update_data.items():
        if isinstance(value, (str, int, float, bool, type(None))):
            response_settings[key] = value
        else:
            response_settings[key] = str(value)
    
    return JSONResponse(content={
        "status": "success",
        "message": "Настройки группы обновлены",
        "settings": response_settings
    })

# ===================================================================
# === update_group_avatar - Обновить аватар группы ==================
# ===================================================================
@router.post("/api/groups/{chat_id}/avatar", summary="Обновить аватар группы")
async def update_group_avatar(
    chat_id: str,
    avatar_file: Annotated[UploadFile, File()],
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)] = None
):
    """Обновляет аватар группы. Только владелец или участники (если разрешено) могут изменять аватар."""
    chats_collection = db_module.get_chats_collection()
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Группа не найдена.")
    
    if chat.get("chat_type") != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Это не группа.")
    
    if current_user["email"] not in chat.get("participants", []):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этой группе.")
    
    # Проверяем права на изменение настроек
    owner_email = chat.get("owner")
    is_owner = owner_email == current_user["email"]
    allow_members_edit = chat.get("allow_members_edit_settings", False)
    
    if not is_owner and not allow_members_edit:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Владелец группы не разрешил участникам изменять настройки."
        )
    
    if not avatar_file or not avatar_file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Файл не был передан.")
    
    # Сохраняем новый аватар
    if avatar_file and avatar_file.filename:
        old_avatar = chat.get("group_avatar", "/images/юзер.svg")
        file_ext = Path(avatar_file.filename).suffix
        unique_filename = f"{uuid.uuid4()}{file_ext}"
        file_path = UPLOAD_DIR / unique_filename
        
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(avatar_file.file, buffer)
        
        new_avatar_url = f"/static/uploads/{unique_filename}"
        
        # Получаем имя пользователя для системного сообщения
        users_collection = db_module.get_users_collection()
        user_doc = await users_collection.find_one({"email": current_user["email"]}, {"username": 1, "full_name": 1})
        user_name = user_doc.get("full_name") or user_doc.get("username") or current_user["email"] if user_doc else current_user["email"]
        
        # Создаем системное сообщение об изменении аватара
        system_message = {
            "_id": ObjectId(),
            "sender_id": "system",
            "content": f"{user_name} изменил(а) фото группы",
            "timestamp": datetime.utcnow(),
            "type": "system",
            "system_action": "avatar_changed",
            "new_avatar": new_avatar_url,
            "deleted_for_users": [],
            "read_by": []
        }
        
        # Обновляем аватар в БД и добавляем системное сообщение
        await chats_collection.update_one(
            {"_id": chat_oid},
            {
                "$set": {
                    "group_avatar": new_avatar_url,
                    "last_message_at": datetime.utcnow()
                },
                "$push": {"messages": system_message}
            }
        )
        
        # Отправляем системное сообщение через WebSocket
        participants = chat.get("participants", [])
        system_msg_for_response = system_message.copy()
        system_msg_for_response["_id"] = str(system_msg_for_response["_id"])
        system_msg_for_response["timestamp"] = system_msg_for_response["timestamp"].isoformat() + "Z"
        system_msg_for_response["chat_id"] = chat_id
        await manager.broadcast_to_participants(participants, system_msg_for_response)
        
        # Отправляем обновление настроек через WebSocket
        await manager.broadcast_to_participants(participants, {
            "type": "group_settings_updated",
            "chat_id": chat_id,
            "settings": {"group_avatar": new_avatar_url},
            "old_avatar": old_avatar
        })
        
        return JSONResponse(content={
            "status": "success",
            "message": "Аватар группы обновлен",
            "group_avatar": new_avatar_url
        })
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Файл не был передан.")

# ===================================================================
# === add_group_members - Добавить участников в группу =============
# ===================================================================
@router.post("/api/groups/{chat_id}/add_members", summary="Добавить участников в группу")
async def add_group_members(
    chat_id: str,
    request: Request,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)] = None
):
    """Добавляет участников в группу. Только участники группы могут добавлять других."""
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Группа не найдена.")
    
    if chat.get("chat_type") != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Это не группа.")
    
    current_user_email = current_user["email"]
    if current_user_email not in chat.get("participants", []):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этой группе.")
    
    body = await request.json()
    participant_emails = body.get("participant_emails", [])
    
    if not participant_emails or not isinstance(participant_emails, list):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Укажите список email участников для добавления.")
    
    # Нормализуем существующих участников к lowercase для сравнения
    existing_participants_lower = {p.lower() for p in chat.get("participants", [])}
    existing_participants = set(chat.get("participants", []))
    new_participants = []
    skipped_emails = []
    
    # Проверяем валидность email и добавляем участников
    email_pattern = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
    
    for email in participant_emails:
        if not email or not isinstance(email, str):
            skipped_emails.append(f"{email} (неверный формат)")
            continue
        
        email_trimmed = email.strip()
        if not email_trimmed:
            skipped_emails.append(f"{email} (пустой)")
            continue
        
        # Нормализуем email к lowercase для проверки
        email_lower = email_trimmed.lower()
        
        if email_lower == current_user_email.lower():
            skipped_emails.append(f"{email_trimmed} (это вы)")
            continue
        
        # Проверяем, не является ли участником (с учетом регистра)
        if email_lower in existing_participants_lower or email_trimmed in existing_participants:
            skipped_emails.append(f"{email_trimmed} (уже в группе)")
            continue
        
        # Проверяем валидность email.
        # Если формат не проходит, но такой email уже есть в базе (регистрация допускает свободный формат),
        # разрешаем добавление по email из базы.
        if not email_pattern.match(email_trimmed):
            user = await users_collection.find_one({"email": {"$regex": f"^{re.escape(email_trimmed)}$", "$options": "i"}})
            if user:
                user_email = user.get("email", email_trimmed)
                user_email_lower = user_email.strip().lower()
                if user_email_lower not in existing_participants_lower and user_email not in existing_participants:
                    new_participants.append(user_email_lower)
                else:
                    skipped_emails.append(f"{email_trimmed} (уже в группе как {user_email})")
            else:
                skipped_emails.append(f"{email_trimmed} (неверный формат email)")
            continue
        
        # Проверяем, что пользователь существует в базе
        # Ищем по email в любом регистре
        user = await users_collection.find_one({"email": {"$regex": f"^{re.escape(email_trimmed)}$", "$options": "i"}})
        if not user:
            # Если пользователя нет в базе, все равно добавляем email
            # (пользователь может зарегистрироваться позже)
            print(f"[add_group_members] Пользователь {email_trimmed} не найден в базе, но добавляем email")
            new_participants.append(email_lower)
        else:
            # Используем email из базы данных (правильный регистр)
            user_email = user.get("email", email_trimmed)
            user_email_lower = user_email.strip().lower()
            # Проверяем еще раз, не добавлен ли уже этот email
            if user_email_lower not in existing_participants_lower and user_email not in existing_participants:
                new_participants.append(user_email_lower)
            else:
                skipped_emails.append(f"{email_trimmed} (уже в группе как {user_email})")
    
    if not new_participants:
        error_detail = "Нет новых участников для добавления."
        if skipped_emails:
            error_detail += f" Пропущено: {', '.join(skipped_emails[:5])}"  # Показываем первые 5
            if len(skipped_emails) > 5:
                error_detail += f" и еще {len(skipped_emails) - 5}"
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_detail
        )
    
    # Добавляем новых участников
    updated_participants = list(existing_participants) + new_participants
    
    # Получаем имя пользователя, который добавляет
    adder_user = await users_collection.find_one(
        {"email": current_user_email},
        {"username": 1, "full_name": 1}
    )
    adder_name = adder_user.get("full_name") or adder_user.get("username") or current_user_email if adder_user else current_user_email
    
    # Получаем имена добавленных пользователей
    added_users_info = []
    for email in new_participants:
        user = await users_collection.find_one(
            {"email": email},
            {"username": 1, "full_name": 1}
        )
        if user:
            user_name = user.get("full_name") or user.get("username") or email
            added_users_info.append(user_name)
        else:
            added_users_info.append(email)
    
    # Формируем текст системного сообщения
    if len(added_users_info) == 1:
        system_message_text = f"{adder_name} добавил(а) {added_users_info[0]} в чат"
    else:
        users_list = ", ".join(added_users_info[:-1]) + " и " + added_users_info[-1]
        system_message_text = f"{adder_name} добавил(а) {users_list} в чат"
    
    # Создаем системное сообщение
    system_message = {
        "_id": ObjectId(),
        "sender_id": "system",
        "content": system_message_text,
        "timestamp": datetime.utcnow(),
        "type": "system",
        "deleted_for_users": [],
        "read_by": []
    }
    
    # Обновляем группу в БД (добавляем участников и системное сообщение)
    await chats_collection.update_one(
        {"_id": chat_oid},
        {
            "$set": {
                "participants": updated_participants,
                "last_message_at": system_message["timestamp"]
            },
            "$push": {"messages": system_message}
        }
    )
    
    # Отправляем уведомление через WebSocket всем участникам группы
    await manager.broadcast_to_participants(updated_participants, {
        "type": "group_members_added",
        "chat_id": chat_id,
        "new_members": new_participants,
        "added_by": current_user_email
    })
    
    # Отправляем системное сообщение через WebSocket
    system_message_for_response = system_message.copy()
    system_message_for_response["_id"] = str(system_message_for_response["_id"])
    system_message_for_response["timestamp"] = system_message_for_response["timestamp"].isoformat() + "Z"
    system_message_for_response["chat_id"] = chat_id
    await manager.broadcast_to_participants(updated_participants, system_message_for_response)
    
    return JSONResponse(content={
        "status": "success",
        "message": f"Добавлено участников: {len(new_participants)}",
        "new_members": new_participants,
        "total_participants": len(updated_participants)
    })

# ===================================================================
# === get_group_participants - Получить список участников группы ===
# ===================================================================
@router.get("/api/groups/{chat_id}/participants", summary="Получить список участников группы")
async def get_group_participants(
    chat_id: str,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Возвращает список участников группы с их правами (владелец, админ, участник)."""
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Группа не найдена.")
    
    if chat.get("chat_type") != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Это не группа.")
    
    current_user_email = current_user["email"]
    if current_user_email not in chat.get("participants", []):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этой группе.")
    
    owner_email = chat.get("owner")
    admins = chat.get("admins", [])  # Список email админов
    admin_rights = chat.get("admin_rights", {})  # Права админов
    
    # Загружаем данные участников
    participants_data = []
    for email in chat.get("participants", []):
        try:
            user = await users_collection.find_one(
                {"email": email},
                {"username": 1, "full_name": 1, "profile_picture": 1}
            )
            
            is_owner = email == owner_email
            is_admin = email in admins
            is_current_user = email == current_user_email
            
            # Получаем права участника (для админов из admin_rights, для обычных из participant_rights)
            participant_rights = None
            if is_admin:
                # Ищем права админа по email (с учетом регистра)
                admin_email_key = next((a for a in admins if a.lower() == email.lower()), None)
                if admin_email_key and admin_email_key in admin_rights:
                    participant_rights = admin_rights[admin_email_key]
            else:
                # Ищем права обычного участника
                participant_email_key = next((p for p in chat.get("participants", []) if p.lower() == email.lower()), None)
                if participant_email_key and participant_email_key in participant_rights_dict:
                    participant_rights = participant_rights_dict[participant_email_key]
            
            participant_info = {
                "email": email,
                "name": user.get("full_name") or user.get("username") or email if user else email,
                "profile_picture": user.get("profile_picture") or "/images/юзер.svg" if user else "/images/юзер.svg",
                "is_owner": is_owner,
                "is_admin": is_admin,
                "is_current_user": is_current_user,
                "role": "owner" if is_owner else ("admin" if is_admin else "member"),
                "rights": participant_rights  # Добавляем права админа
            }
            participants_data.append(participant_info)
        except Exception as e:
            print(f"Ошибка загрузки данных участника {email}: {e}")
            participants_data.append({
                "email": email,
                "name": email,
                "profile_picture": "/images/юзер.svg",
                "is_owner": email == owner_email,
                "is_admin": email in admins,
                "is_current_user": email == current_user_email,
                "role": "owner" if email == owner_email else ("admin" if email in admins else "member")
            })
    
    # Сортируем: владелец первый, потом админы, потом участники
    participants_data.sort(key=lambda x: (x["is_owner"], not x["is_admin"], x["name"].lower()))
    
    is_owner = current_user_email == owner_email
    is_admin = current_user_email in admins
    
    return JSONResponse(content={
        "participants": participants_data,
        "is_owner": is_owner,
        "is_admin": is_admin,
        "can_manage_members": is_owner or is_admin  # Владелец или админ могут управлять участниками
    })

# ===================================================================
# === remove_group_member - Удалить участника из группы ============
# ===================================================================
@router.delete("/api/groups/{chat_id}/remove_member", summary="Удалить участника из группы")
async def remove_group_member(
    chat_id: str,
    request: Request,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Удаляет участника из группы. Только владелец или админ могут удалять участников. Владелец не может быть удален."""
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Группа не найдена.")
    
    if chat.get("chat_type") != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Это не группа.")
    
    current_user_email = current_user["email"]
    if current_user_email not in chat.get("participants", []):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этой группе.")
    
    owner_email = chat.get("owner")
    admins = chat.get("admins", [])
    is_owner = current_user_email == owner_email
    is_admin = current_user_email in admins
    
    # Только владелец или админ могут удалять участников
    if not is_owner and not is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Только владелец или админ могут удалять участников.")

    # Если удаляет админ (не владелец) — проверяем его права
    if is_admin and not is_owner:
        admin_rights = chat.get("admin_rights", {})
        # Ключ в admin_rights хранится в "оригинальном" регистре email из списка admins
        admin_email_key = next((a for a in admins if a.lower() == current_user_email.lower()), None)
        rights = admin_rights.get(admin_email_key) if admin_email_key else None

        # По умолчанию (если права не заданы) считаем, что админ может удалять
        can_remove = True
        if isinstance(rights, dict):
            # поддерживаем оба флага: can_remove_members и can_manage_members
            can_remove = rights.get("can_remove_members", True) and rights.get("can_manage_members", True)

        if not can_remove:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет прав удалять участников из группы.")
    
    body = await request.json()
    member_email = body.get("member_email", "").strip().lower()
    
    if not member_email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Укажите email участника для удаления.")
    
    participants = [p.lower() for p in chat.get("participants", [])]
    
    if member_email not in participants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Участник не найден в группе.")
    
    # Владелец не может быть удален
    if member_email == owner_email.lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Владелец группы не может быть удален.")
    
    # Админ не может удалять других админов (только владелец может)
    if not is_owner and member_email in [a.lower() for a in admins]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Только владелец может удалять админов.")
    
    # Удаляем участника из списка
    updated_participants = [p for p in chat.get("participants", []) if p.lower() != member_email]
    
    # Также удаляем из списка админов, если он был админом
    updated_admins = [a for a in admins if a.lower() != member_email]
    
    # Получаем имя удаляющего пользователя
    remover_user = await users_collection.find_one(
        {"email": current_user_email},
        {"username": 1, "full_name": 1}
    )
    remover_name = remover_user.get("full_name") or remover_user.get("username") or current_user_email if remover_user else current_user_email
    
    # Получаем имя удаляемого пользователя
    removed_user = await users_collection.find_one(
        {"email": member_email},
        {"username": 1, "full_name": 1}
    )
    removed_name = removed_user.get("full_name") or removed_user.get("username") or member_email if removed_user else member_email
    
    # Формируем текст системного сообщения
    system_message_text = f"{remover_name} удалил(а) {removed_name} из группы"
    
    # Создаем системное сообщение
    system_message = {
        "_id": ObjectId(),
        "sender_id": "system",
        "content": system_message_text,
        "timestamp": datetime.utcnow(),
        "type": "system",
        "deleted_for_users": [],
        "read_by": []
    }
    
    # Обновляем группу в БД
    update_data = {
        "$set": {
            "participants": updated_participants,
            "last_message_at": system_message["timestamp"]
        },
        "$push": {"messages": system_message}
    }
    
    if updated_admins != admins:
        update_data["$set"]["admins"] = updated_admins
    
    await chats_collection.update_one({"_id": chat_oid}, update_data)
    
    # Отправляем уведомление через WebSocket всем участникам группы
    await manager.broadcast_to_participants(updated_participants, {
        "type": "group_member_removed",
        "chat_id": chat_id,
        "removed_member": member_email,
        "removed_by": current_user_email
    })
    
    # Отправляем системное сообщение через WebSocket
    system_message_for_response = system_message.copy()
    system_message_for_response["_id"] = str(system_message_for_response["_id"])
    system_message_for_response["timestamp"] = system_message_for_response["timestamp"].isoformat() + "Z"
    system_message_for_response["chat_id"] = chat_id
    await manager.broadcast_to_participants(updated_participants, system_message_for_response)
    
    # Также отправляем уведомление удаленному пользователю
    await manager.broadcast_to_participants([member_email], {
        "type": "group_member_removed",
        "chat_id": chat_id,
        "removed_member": member_email,
        "removed_by": current_user_email
    })
    
    return JSONResponse(content={
        "status": "success",
        "message": f"Участник {removed_name} удален из группы",
        "removed_member": member_email,
        "total_participants": len(updated_participants)
    })

# ===================================================================
# === set_group_admin - Назначить админа группы ====================
# ===================================================================
@router.post("/api/groups/{chat_id}/set_admin", summary="Назначить админа группы")
async def set_group_admin(
    chat_id: str,
    request: Request,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Назначает участника админом группы. Только владелец может назначать админов."""
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Группа не найдена.")
    
    if chat.get("chat_type") != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Это не группа.")
    
    current_user_email = current_user["email"]
    owner_email = chat.get("owner")
    
    # Только владелец может назначать админов
    if current_user_email != owner_email:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Только владелец группы может назначать админов.")
    
    body = await request.json()
    member_email = body.get("member_email", "").strip().lower()
    
    if not member_email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Укажите email участника для назначения админом.")
    
    participants = [p.lower() for p in chat.get("participants", [])]
    
    if member_email not in participants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Участник не найден в группе.")
    
    # Владелец не может быть админом (он уже владелец)
    if member_email == owner_email.lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Владелец группы уже имеет все права.")
    
    admins = chat.get("admins", [])
    
    # Проверяем, не является ли участник уже админом
    if member_email in [a.lower() for a in admins]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Этот участник уже является админом.")
    
    # Добавляем в список админов (сохраняем оригинальный регистр email)
    original_email = next((p for p in chat.get("participants", []) if p.lower() == member_email), member_email)
    updated_admins = list(admins) + [original_email]
    
    # Получаем имя владельца
    owner_user = await users_collection.find_one(
        {"email": current_user_email},
        {"username": 1, "full_name": 1}
    )
    owner_name = owner_user.get("full_name") or owner_user.get("username") or current_user_email if owner_user else current_user_email
    
    # Получаем имя нового админа
    new_admin_user = await users_collection.find_one(
        {"email": member_email},
        {"username": 1, "full_name": 1}
    )
    new_admin_name = new_admin_user.get("full_name") or new_admin_user.get("username") or member_email if new_admin_user else member_email
    
    # Формируем текст системного сообщения
    system_message_text = f"{owner_name} назначил(а) {new_admin_name} администратором группы"
    
    # Создаем системное сообщение
    system_message = {
        "_id": ObjectId(),
        "sender_id": "system",
        "content": system_message_text,
        "timestamp": datetime.utcnow(),
        "type": "system",
        "deleted_for_users": [],
        "read_by": []
    }
    
    # Обновляем группу в БД
    await chats_collection.update_one(
        {"_id": chat_oid},
        {
            "$set": {"admins": updated_admins, "last_message_at": system_message["timestamp"]},
            "$push": {"messages": system_message}
        }
    )
    
    # Отправляем уведомление через WebSocket всем участникам группы
    participants = chat.get("participants", [])
    await manager.broadcast_to_participants(participants, {
        "type": "group_admin_set",
        "chat_id": chat_id,
        "admin_email": original_email,
        "set_by": current_user_email
    })
    
    # Отправляем системное сообщение через WebSocket
    system_message_for_response = system_message.copy()
    system_message_for_response["_id"] = str(system_message_for_response["_id"])
    system_message_for_response["timestamp"] = system_message_for_response["timestamp"].isoformat() + "Z"
    system_message_for_response["chat_id"] = chat_id
    await manager.broadcast_to_participants(participants, system_message_for_response)
    
    return JSONResponse(content={
        "status": "success",
        "message": f"{new_admin_name} назначен администратором",
        "admin_email": original_email
    })

# ===================================================================
# === remove_group_admin - Снять админа группы =====================
# ===================================================================
@router.delete("/api/groups/{chat_id}/remove_admin", summary="Снять админа группы")
async def remove_group_admin(
    chat_id: str,
    request: Request,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Снимает права админа у участника. Только владелец может снимать админов."""
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Группа не найдена.")
    
    if chat.get("chat_type") != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Это не группа.")
    
    current_user_email = current_user["email"]
    owner_email = chat.get("owner")
    
    # Только владелец может снимать админов
    if current_user_email != owner_email:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Только владелец группы может снимать админов.")
    
    body = await request.json()
    member_email = body.get("member_email", "").strip().lower()
    
    if not member_email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Укажите email админа для снятия прав.")
    
    admins = chat.get("admins", [])
    
    # Проверяем, является ли участник админом
    if member_email not in [a.lower() for a in admins]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Этот участник не является админом.")
    
    # Удаляем из списка админов
    original_email = next((a for a in admins if a.lower() == member_email), None)
    updated_admins = [a for a in admins if a.lower() != member_email]
    
    # Получаем имя владельца
    owner_user = await users_collection.find_one(
        {"email": current_user_email},
        {"username": 1, "full_name": 1}
    )
    owner_name = owner_user.get("full_name") or owner_user.get("username") or current_user_email if owner_user else current_user_email
    
    # Получаем имя снятого админа
    removed_admin_user = await users_collection.find_one(
        {"email": member_email},
        {"username": 1, "full_name": 1}
    )
    removed_admin_name = removed_admin_user.get("full_name") or removed_admin_user.get("username") or member_email if removed_admin_user else member_email
    
    # Формируем текст системного сообщения
    system_message_text = f"{owner_name} снял(а) {removed_admin_name} с должности администратора"
    
    # Создаем системное сообщение
    system_message = {
        "_id": ObjectId(),
        "sender_id": "system",
        "content": system_message_text,
        "timestamp": datetime.utcnow(),
        "type": "system",
        "deleted_for_users": [],
        "read_by": []
    }
    
    # Обновляем группу в БД
    await chats_collection.update_one(
        {"_id": chat_oid},
        {
            "$set": {"admins": updated_admins, "last_mess   age_at": system_message["timestamp"]},
            "$push": {"messages": system_message}
        }
    )
    
    # Отправляем уведомление через WebSocket всем участникам группы
    participants = chat.get("participants", [])
    await manager.broadcast_to_participants(participants, {
        "type": "group_admin_removed",
        "chat_id": chat_id,
        "admin_email": original_email,
        "removed_by": current_user_email
    })
    
    # Отправляем системное сообщение через WebSocket
    system_message_for_response = system_message.copy()
    system_message_for_response["_id"] = str(system_message_for_response["_id"])
    system_message_for_response["timestamp"] = system_message_for_response["timestamp"].isoformat() + "Z"
    system_message_for_response["chat_id"] = chat_id
    await manager.broadcast_to_participants(participants, system_message_for_response)
    
    return JSONResponse(content={
        "status": "success",
        "message": f"{removed_admin_name} больше не является администратором",
        "admin_email": original_email
    })

# ===================================================================
# === update_participant_rights - Обновить права участника =========
# ===================================================================
@router.put("/api/groups/{chat_id}/participant_rights", summary="Обновить права доступа участника")
async def update_participant_rights(
    chat_id: str,
    request: Request,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Обновляет права доступа для участника группы (админа или обычного участника). Только владелец может изменять права."""
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат Chat ID.")
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Группа не найдена.")
    
    if chat.get("chat_type") != "group":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Это не группа.")
    
    current_user_email = current_user["email"]
    owner_email = chat.get("owner")
    
    # Только владелец может изменять права участников
    if current_user_email != owner_email:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Только владелец группы может изменять права участников.")
    
    body = await request.json()
    participant_email = body.get("participant_email", "").strip().lower()
    rights = body.get("rights", {})
    
    if not participant_email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Укажите email участника.")
    
    participants_list = chat.get("participants", [])
    
    # Проверяем, является ли участник членом группы
    if participant_email not in [p.lower() for p in participants_list]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Этот участник не является членом группы.")
    
    # Нельзя изменять права владельца
    if participant_email == owner_email.lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Нельзя изменять права владельца группы.")
    
    # Получаем оригинальный email (с правильным регистром)
    original_email = next((p for p in participants_list if p.lower() == participant_email), participant_email)
    
    admins = chat.get("admins", [])
    is_admin = original_email in admins
    
    # Получаем текущие права участников или создаем новый словарь
    participant_rights = chat.get("participant_rights", {})
    admin_rights = chat.get("admin_rights", {})
    
    # Базовые права для всех участников
    base_rights = {
        "can_send_messages": rights.get("can_send_messages", True),
        "can_send_media": rights.get("can_send_media", True),
        "can_delete_messages": rights.get("can_delete_messages", False)
    }
    
    # Если это админ, добавляем права админа
    if is_admin:
        admin_rights[original_email] = {
            **base_rights,
            "can_manage_members": rights.get("can_manage_members", True),
            "can_remove_members": rights.get("can_remove_members", True),
            "can_add_members": rights.get("can_add_members", True),
            "can_edit_group_info": rights.get("can_edit_group_info", False)
        }
    else:
        # Для обычных участников сохраняем только базовые права
        participant_rights[original_email] = base_rights
    
    # Обновляем группу в БД
    update_data = {}
    if is_admin:
        update_data["admin_rights"] = admin_rights
    else:
        update_data["participant_rights"] = participant_rights
    
    await chats_collection.update_one(
        {"_id": chat_oid},
        {"$set": update_data}
    )
    
    # Отправляем уведомление через WebSocket всем участникам группы
    participants = chat.get("participants", [])
    await manager.broadcast_to_participants(participants, {
        "type": "group_participant_rights_updated",
        "chat_id": chat_id,
        "participant_email": original_email,
        "rights": admin_rights.get(original_email) if is_admin else participant_rights.get(original_email),
        "updated_by": current_user_email
    })
    
    return JSONResponse(content={
        "status": "success",
        "message": "Права доступа участника успешно обновлены",
        "participant_email": original_email,
        "rights": admin_rights.get(original_email) if is_admin else participant_rights.get(original_email)
    })

# ===================================================================
# === update_admin_rights - Обновить права админа (старый API для совместимости) ==================
# ===================================================================
@router.put("/api/groups/{chat_id}/admin_rights", summary="Обновить права доступа администратора")
async def update_admin_rights(
    chat_id: str,
    request: Request,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Обновляет права доступа для администратора группы. Только владелец может изменять права админов."""
    # Перенаправляем на новый API
    body = await request.json()
    admin_email = body.get("admin_email", "")
    rights = body.get("rights", {})
    
    # Создаем новый запрос для нового API
    from fastapi import Request as FastAPIRequest
    new_body = {
        "participant_email": admin_email,
        "rights": rights
    }
    
    # Используем новый endpoint
    return await update_participant_rights(chat_id, request, current_user)

# ===================================================================
# === edit_message (НОВЫЙ) =========================================
# ===================================================================
@router.put("/api/edit_message/{message_id}", summary="Редактировать сообщение")
async def edit_message(
    message_id: str,
    request: Request,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    chats_collection = db_module.get_chats_collection()
    try:
        message_oid = ObjectId(message_id)
    except Exception:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Неверный формат ID сообщения.")
    
    body = await request.json()
    new_content = body.get("content", "").strip()
    if not new_content:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Содержимое сообщения не может быть пустым.")
    
    # Находим чат с этим сообщением
    chat = await chats_collection.find_one({"messages._id": message_oid})
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Сообщение или чат не найден.")
    
    if current_user["email"] not in chat["participants"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="У вас нет доступа к этому чату.")
    
    # Находим сообщение
    message_obj = None
    for msg in chat.get("messages", []):
        if msg.get("_id") == message_oid:
            message_obj = msg
            break
    
    if not message_obj:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Сообщение не найдено.")
    
    # Проверяем, что это сообщение пользователя
    if message_obj.get("sender_id") != current_user["email"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Вы можете редактировать только свои сообщения.")
    
    # Обновляем сообщение
    chat_id = str(chat["_id"])
    await chats_collection.update_one(
        {"_id": chat["_id"], "messages._id": message_oid},
        {
            "$set": {
                "messages.$.content": new_content,
                "messages.$.edited_at": datetime.utcnow()
            }
        }
    )
    
    # Обновляем last_message_at, если это было последнее сообщение
    updated_chat = await chats_collection.find_one({"_id": chat["_id"]})
    all_messages = updated_chat.get("messages", [])
    if all_messages and all_messages[-1].get("_id") == message_oid:
        await chats_collection.update_one(
            {"_id": chat["_id"]},
            {"$set": {"last_message_at": datetime.utcnow()}}
        )
    
    # Отправляем обновление через WebSocket
    participants = chat.get("participants", [])
    updated_message_data = message_obj.copy()
    updated_message_data["content"] = new_content
    updated_message_data["edited_at"] = datetime.utcnow()
    updated_message_data["_id"] = str(updated_message_data["_id"])
    updated_message_data["timestamp"] = updated_message_data["timestamp"].isoformat() + "Z" if isinstance(updated_message_data.get("timestamp"), datetime) else updated_message_data.get("timestamp")
    updated_message_data["edited_at"] = updated_message_data["edited_at"].isoformat() + "Z"
    updated_message_data["chat_id"] = chat_id
    updated_message_data["type"] = "message_edited"
    
    await manager.broadcast_to_participants(participants, updated_message_data)
    
    return JSONResponse(content={
        "status": "success",
        "message": "Сообщение отредактировано",
        "message_data": updated_message_data
    })
# ===================================================================
# === КОНЕЦ БЛОКА ===================================================
# ===================================================================
