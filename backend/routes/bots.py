from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from typing import Annotated, Dict, Any, List, Optional
from datetime import datetime
from bson import ObjectId
from pydantic import BaseModel
import base64
import aiohttp
import json
import os

import backend.db.database as db_module
from backend.dependencies import get_current_user
from backend.routes.websocket_manager import manager

router = APIRouter(
    tags=["Bots"],
)

# Токен GigaChat (в формате base64: client_id:client_secret), берем из .env
GIGACHAT_TOKEN = os.getenv("GIGACHAT_AUTH_BASE64", "")

# Кэш для access token (чтобы не запрашивать каждый раз)
_gigachat_token_cache = {"token": None, "expires_at": None}

# Токен DeepSeek (OpenAI-совместимый API), берем из .env
DEEPSEEK_TOKEN = os.getenv("DEEPSEEK_API_KEY", "")

# Токен Gemini, берем из .env
GEMINI_TOKEN = os.getenv("GEMINI_API_KEY", "")

# Токен OpenAI GPT (берем из переменной окружения OPENAI_API_KEY)
GPT_TOKEN = os.getenv("OPENAI_API_KEY", "")

# Список доступных ботов
AVAILABLE_BOTS = [
    {
        "bot_id": "gigachat",
        "name": "Гигачат",
        "username": "@gigachat",  # Специальный никнейм для поиска
        "avatar": "/images/avatars/gigachat.jpg",
        "description": "Нейросеть GigaChat для общения"
    },
    {
        "bot_id": "deepseek",
        "name": "DeepSeek",
        "username": "@deepseek",  # Специальный никнейм для поиска
        "avatar": "/images/avatars/deepseek.webp",
        "description": "Нейросеть DeepSeek для общения"
    },
    {
        "bot_id": "gemini",
        "name": "Gemini",
        "username": "@gemini",  # Специальный никнейм для поиска
        "avatar": "/images/avatars/gemini.jpg",
        "description": "Нейросеть Google Gemini для общения"
    },
    {
        "bot_id": "gpt",
        "name": "ChatGPT",
        "username": "@gpt",  # Специальный никнейм для поиска
        "avatar": "/images/avatars/gpt.jpg",
        "description": "Нейросеть OpenAI ChatGPT для общения"
    },
]


async def get_gigachat_access_token() -> str:
    """
    Получает access token для GigaChat API.
    Токен уже в формате base64, нужно декодировать и использовать для авторизации.
    """
    global _gigachat_token_cache
    
    print(f"\n[GigaChat Token] ========== ПОЛУЧЕНИЕ ACCESS TOKEN ==========")
    
    # Проверяем кэш (токен действителен 30 минут)
    if _gigachat_token_cache["token"] and _gigachat_token_cache["expires_at"]:
        if datetime.utcnow() < _gigachat_token_cache["expires_at"]:
            print(f"[GigaChat Token] Используем кэшированный токен")
            return _gigachat_token_cache["token"]
        else:
            print(f"[GigaChat Token] Кэшированный токен истек, получаем новый")
    
    try:
        # Декодируем токен из base64
        decoded = base64.b64decode(GIGACHAT_TOKEN).decode('utf-8')
        print(f"[GigaChat Token] Декодированный токен: {decoded[:50]}...")
        # Формат: client_id:client_secret
        if ':' not in decoded:
            print(f"[GigaChat Token] ОШИБКА: Токен не содержит ':' - возможно это уже access token?")
            # Попробуем использовать как access token напрямую
            return decoded
        client_id, client_secret = decoded.split(':', 1)
        print(f"[GigaChat Token] Client ID: {client_id[:20]}...")
        print(f"[GigaChat Token] Client Secret: {client_secret[:20]}...")
        
        # Получаем access token через OAuth
        async with aiohttp.ClientSession() as session:
            auth_string = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
            rq_uid = str(ObjectId())  # Уникальный идентификатор запроса
            
            # Используем правильный формат для GigaChat API
            # Пробуем оба варианта формата данных
            async with session.post(
                "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
                headers={
                    "Authorization": f"Basic {auth_string}",
                    "RqUID": rq_uid,
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                data={"scope": "GIGACHAT_API_PERS"},  # Передаем как словарь
                ssl=False,
                timeout=aiohttp.ClientTimeout(total=10)
            ) as response:
                response_text = await response.text()
                print(f"[GigaChat] Статус ответа: {response.status}")
                print(f"[GigaChat] Ответ сервера (первые 200 символов): {response_text[:200]}")
                
                if response.status == 200:
                    try:
                        data = await response.json()
                        print(f"[GigaChat] JSON ответ: {data}")
                        access_token = data.get("access_token", "")
                        # expires_at может быть в секундах или как timestamp
                        expires_in = data.get("expires_at")
                        if not expires_in:
                            expires_in = 1800  # По умолчанию 30 минут
                        elif expires_in > 1000000000:  # Если это timestamp
                            expires_in = expires_in - int(datetime.utcnow().timestamp())
                        
                        if access_token:
                            # Сохраняем в кэш
                            from datetime import timedelta
                            _gigachat_token_cache["token"] = access_token
                            _gigachat_token_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=expires_in - 60)  # -60 секунд для запаса
                            print(f"[GigaChat] Токен успешно получен, действителен до {_gigachat_token_cache['expires_at']}")
                        else:
                            print(f"[GigaChat] Токен не найден в ответе: {data}")
                        return access_token
                    except Exception as json_error:
                        print(f"[GigaChat] Ошибка парсинга JSON: {json_error}")
                        print(f"[GigaChat] Полный ответ: {response_text}")
                        return ""
                else:
                    error_text = await response.text()
                    print(f"[GigaChat] Ошибка получения токена: {response.status}")
                    print(f"[GigaChat] Ответ сервера: {error_text}")
                    # Пробуем распарсить JSON ошибки
                    try:
                        error_json = await response.json()
                        print(f"[GigaChat] Детали ошибки (JSON): {error_json}")
                    except:
                        pass
                    return ""
    except Exception as e:
        print(f"[GigaChat] Ошибка при получении токена: {e}")
        import traceback
        traceback.print_exc()
        return ""


async def send_message_to_gemini(message: str) -> Optional[str]:
    """
    Отправляет сообщение в Google Gemini API и получает ответ.
    """
    try:
        async with aiohttp.ClientSession() as session:
            request_data = {
                "contents": [
                    {
                        "parts": [
                            {
                                "text": message
                            }
                        ]
                    }
                ]
            }
            print(f"[Gemini] Отправка сообщения: {message[:50]}...")
            
            async with session.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key={GEMINI_TOKEN}",
                headers={
                    "Content-Type": "application/json"
                },
                json=request_data,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                response_text = await response.text()
                print(f"[Gemini] Статус ответа API: {response.status}")
                print(f"[Gemini] Ответ API (первые 300 символов): {response_text[:300]}")
                
                if response.status == 200:
                    try:
                        data = await response.json()
                        candidates = data.get("candidates", [])
                        if candidates:
                            content = candidates[0].get("content", {})
                            parts = content.get("parts", [])
                            if parts:
                                response_text = parts[0].get("text", "")
                                print(f"[Gemini] Получен ответ: {response_text[:100]}...")
                                return response_text
                        print(f"[Gemini] Нет candidates в ответе: {data}")
                        return None
                    except Exception as json_error:
                        print(f"[Gemini] Ошибка парсинга JSON ответа: {json_error}")
                        print(f"[Gemini] Полный ответ: {response_text}")
                        return None
                else:
                    print(f"[Gemini] Ошибка API: {response.status}")
                    print(f"[Gemini] Полный ответ ошибки: {response_text}")
                    # Пробуем получить детали ошибки
                    try:
                        error_data = await response.json()
                        error_message = error_data.get("error", {}).get("message", "Неизвестная ошибка")
                        print(f"[Gemini] Детали ошибки: {error_message}")
                    except:
                        pass
                    return None
    except Exception as e:
        print(f"[Gemini] Ошибка при отправке сообщения: {e}")
        import traceback
        traceback.print_exc()
        return None


async def send_message_to_deepseek(message: str) -> Optional[str]:
    """
    Отправляет сообщение в DeepSeek API и получает ответ.
    DeepSeek использует OpenAI-совместимый API.
    """
    try:
        async with aiohttp.ClientSession() as session:
            request_data = {
                "model": "deepseek-chat",
                "messages": [
                    {
                        "role": "user",
                        "content": message
                    }
                ],
                "temperature": 0.7,
                "max_tokens": 512
            }
            print(f"[DeepSeek] Отправка сообщения: {message[:50]}...")
            
            async with session.post(
                "https://api.deepseek.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {DEEPSEEK_TOKEN}",
                    "Content-Type": "application/json"
                },
                json=request_data,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                response_text = await response.text()
                print(f"[DeepSeek] Статус ответа API: {response.status}")
                print(f"[DeepSeek] Ответ API (первые 300 символов): {response_text[:300]}")
                
                if response.status == 200:
                    try:
                        data = await response.json()
                        choices = data.get("choices", [])
                        if choices:
                            response_text = choices[0].get("message", {}).get("content", "")
                            print(f"[DeepSeek] Получен ответ: {response_text[:100]}...")
                            return response_text
                        else:
                            print(f"[DeepSeek] Нет choices в ответе: {data}")
                            return None
                    except Exception as json_error:
                        print(f"[DeepSeek] Ошибка парсинга JSON ответа: {json_error}")
                        print(f"[DeepSeek] Полный ответ: {response_text}")
                        return None
                else:
                    print(f"[DeepSeek] Ошибка API: {response.status}")
                    print(f"[DeepSeek] Полный ответ ошибки: {response_text}")
                    # Пробуем получить детали ошибки
                    try:
                        error_data = await response.json()
                        error_message = error_data.get("error", {}).get("message", "Неизвестная ошибка")
                        print(f"[DeepSeek] Детали ошибки: {error_message}")
                    except:
                        pass
                    return None
    except Exception as e:
        print(f"[DeepSeek] Ошибка при отправке сообщения: {e}")
        import traceback
        traceback.print_exc()
        return None


async def send_message_to_gpt(message: str) -> Optional[str]:
    """
    Отправляет сообщение в OpenAI ChatGPT API и получает ответ.
    Использует стандартный chat-completions эндпоинт.
    """
    if not GPT_TOKEN:
        print("[GPT] ОШИБКА: Не задан OPENAI_API_KEY в переменных окружения (.env)")
        return None

    try:
        async with aiohttp.ClientSession() as session:
            request_data = {
                "model": "gpt-4o-mini",
                "messages": [
                    {
                        "role": "user",
                        "content": message,
                    }
                ],
                "temperature": 0.7,
                "max_tokens": 512,
            }
            print(f"[GPT] Отправка сообщения: {message[:50]}...")

            async with session.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {GPT_TOKEN}",
                    "Content-Type": "application/json",
                },
                json=request_data,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as response:
                response_text = await response.text()
                print(f"[GPT] Статус ответа API: {response.status}")
                print(f"[GPT] Ответ API (первые 300 символов): {response_text[:300]}")

                if response.status == 200:
                    try:
                        data = await response.json()
                        choices = data.get("choices", [])
                        if choices:
                            bot_text = (
                                choices[0]
                                .get("message", {})
                                .get("content", "")
                            )
                            print(f"[GPT] Получен ответ: {bot_text[:100]}...")
                            return bot_text
                        else:
                            print(f"[GPT] Нет choices в ответе: {data}")
                            return None
                    except Exception as json_error:
                        print(f"[GPT] Ошибка парсинга JSON ответа: {json_error}")
                        print(f"[GPT] Полный ответ: {response_text}")
                        return None
                else:
                    print(f"[GPT] Ошибка API: {response.status}")
                    print(f"[GPT] Полный ответ ошибки: {response_text}")
                    try:
                        error_data = await response.json()
                        error_message = (
                            error_data.get("error", {}).get("message", "Неизвестная ошибка")
                        )
                        print(f"[GPT] Детали ошибки: {error_message}")
                    except Exception:
                        pass
                    return None
    except Exception as e:
        print(f"[GPT] Ошибка при отправке сообщения: {e}")
        import traceback

        traceback.print_exc()
        return None


async def send_message_to_gigachat(message: str, access_token: str) -> Optional[str]:
    """
    Отправляет сообщение в GigaChat и получает ответ.
    """
    try:
        async with aiohttp.ClientSession() as session:
            request_data = {
                "model": "GigaChat",
                "messages": [
                    {
                        "role": "user",
                        "content": message
                    }
                ],
                "temperature": 0.7,
                "max_tokens": 512
            }
            print(f"[GigaChat] Отправка сообщения: {message[:50]}...")
            print(f"[GigaChat] Используемый токен (первые 20 символов): {access_token[:20]}...")
            
            async with session.post(
                "https://gigachat.devices.sberbank.ru/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json"
                },
                json=request_data,
                ssl=False,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                response_text = await response.text()
                print(f"[GigaChat] Статус ответа API: {response.status}")
                print(f"[GigaChat] Ответ API (первые 300 символов): {response_text[:300]}")
                
                if response.status == 200:
                    try:
                        data = await response.json()
                        choices = data.get("choices", [])
                        if choices:
                            response_text = choices[0].get("message", {}).get("content", "")
                            print(f"[GigaChat] Получен ответ: {response_text[:100]}...")
                            return response_text
                        else:
                            print(f"[GigaChat] Нет choices в ответе: {data}")
                            return None
                    except Exception as json_error:
                        print(f"[GigaChat] Ошибка парсинга JSON ответа: {json_error}")
                        print(f"[GigaChat] Полный ответ: {response_text}")
                        return None
                else:
                    print(f"[GigaChat] Ошибка API: {response.status}")
                    print(f"[GigaChat] Полный ответ ошибки: {response_text}")
                    # Пробуем получить детали ошибки
                    try:
                        error_data = await response.json()
                        error_message = error_data.get("error", {}).get("message", "Неизвестная ошибка")
                        print(f"[GigaChat] Детали ошибки: {error_message}")
                    except:
                        pass
                    return None
    except Exception as e:
        print(f"[GigaChat] Ошибка при отправке сообщения: {e}")
        import traceback
        traceback.print_exc()
        return None


@router.get("/api/bots", summary="Получить список доступных ботов")
async def get_bots_list(
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)],
    search_query: Optional[str] = None
):
    """Возвращает список всех доступных ботов с информацией о чатах. Поддерживает поиск."""
    chats_collection = db_module.get_chats_collection()
    current_user_email = current_user["email"]
    
    # Получаем информацию о чатах с ботами для текущего пользователя
    bots_with_chat_info = []
    
    search_term = search_query.strip().lower() if search_query else ""
    
    for bot in AVAILABLE_BOTS:
        bot_id = bot["bot_id"]
        bot_email = f"bot_{bot_id}@flicker.local"
        
        # Фильтрация по поисковому запросу
        if search_term:
            bot_name = bot.get("name", "").lower()
            bot_username = bot.get("username", "").lower()
            bot_description = bot.get("description", "").lower()
            
            # Ищем по имени, никнейму или описанию
            if (search_term not in bot_name and 
                search_term not in bot_username and 
                search_term not in bot_description):
                continue  # Пропускаем бота, если не подходит под поиск
        
        # Ищем существующий чат с ботом
        participants = sorted([current_user_email, bot_email])
        existing_chat: Optional[Dict[str, Any]] = await chats_collection.find_one({
            "participants": participants,
            "chat_type": "bot"
        })
        
        bot_info = bot.copy()
        
        if existing_chat:
            # Получаем последнее сообщение
            messages = existing_chat.get("messages", [])
            filtered_messages = [msg for msg in messages if current_user_email not in msg.get("deleted_for_users", [])]
            last_message = filtered_messages[-1] if filtered_messages else None
            
            if last_message:
                bot_info["chat_id"] = str(existing_chat["_id"])
                bot_info["last_message"] = last_message.get("content", "") or last_message.get("filename", "")
                last_timestamp = last_message.get("timestamp", existing_chat.get("last_message_at", datetime.min))
                # Конвертируем datetime в строку для JSON
                if isinstance(last_timestamp, datetime):
                    bot_info["last_message_timestamp"] = last_timestamp.isoformat() + "Z"
                else:
                    bot_info["last_message_timestamp"] = str(last_timestamp)
                bot_info["last_message_sender"] = last_message.get("sender_id", "")
                bot_info["has_chat"] = True
            else:
                bot_info["chat_id"] = str(existing_chat["_id"])
                bot_info["last_message"] = None
                last_timestamp = existing_chat.get("last_message_at", existing_chat.get("created_at", datetime.min))
                # Конвертируем datetime в строку для JSON
                if isinstance(last_timestamp, datetime):
                    bot_info["last_message_timestamp"] = last_timestamp.isoformat() + "Z"
                else:
                    bot_info["last_message_timestamp"] = str(last_timestamp)
                bot_info["last_message_sender"] = None
                bot_info["has_chat"] = True
        else:
            bot_info["chat_id"] = None
            bot_info["last_message"] = None
            bot_info["last_message_timestamp"] = datetime.min.isoformat() + "Z"
            bot_info["last_message_sender"] = None
            bot_info["has_chat"] = False
        
        bots_with_chat_info.append(bot_info)
    
    # Сортируем по времени последнего сообщения (новые сверху)
    # Преобразуем строки обратно в datetime для сортировки
    def get_sort_key(bot_info):
        timestamp_str = bot_info.get("last_message_timestamp", "")
        if isinstance(timestamp_str, str) and timestamp_str:
            try:
                # Убираем 'Z' в конце если есть
                ts_str = timestamp_str.rstrip('Z')
                return datetime.fromisoformat(ts_str.replace('Z', ''))
            except:
                return datetime.min
        return datetime.min
    
    bots_with_chat_info.sort(key=get_sort_key, reverse=True)
    
    # Конвертируем все timestamp обратно в строки для JSON
    for bot_info in bots_with_chat_info:
        if "last_message_timestamp" in bot_info and isinstance(bot_info["last_message_timestamp"], datetime):
            bot_info["last_message_timestamp"] = bot_info["last_message_timestamp"].isoformat() + "Z"
    
    return JSONResponse(content={"bots": bots_with_chat_info})


@router.post("/api/bots/{bot_id}/start_chat", summary="Создать или открыть чат с ботом")
async def start_bot_chat(
    bot_id: str,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Создает или возвращает существующий чат с ботом."""
    # Проверяем, что бот существует
    bot = next((b for b in AVAILABLE_BOTS if b["bot_id"] == bot_id), None)
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Бот не найден."
        )
    
    chats_collection = db_module.get_chats_collection()
    current_user_email = current_user["email"]
    
    # Создаем специальный email для бота
    bot_email = f"bot_{bot_id}@flicker.local"
    
    # Ищем существующий чат с ботом
    participants = sorted([current_user_email, bot_email])
    existing_chat: Optional[Dict[str, Any]] = await chats_collection.find_one({
        "participants": participants,
        "chat_type": "bot"
    })
    
    if existing_chat:
        chat_id = str(existing_chat["_id"])
    else:
        # Создаем новый чат с ботом
        new_chat_document = {
            "participants": participants,
            "messages": [],
            "created_at": datetime.utcnow(),
            "last_message_at": datetime.utcnow(),
            "chat_type": "bot",
            "bot_id": bot_id,
            "unread_count": {}
        }
        insert_result = await chats_collection.insert_one(new_chat_document)
        chat_id = str(insert_result.inserted_id)
    
    return JSONResponse(content={
        "chat_id": chat_id,
        "bot": bot
    })


async def process_bot_message(
    bot_id: str,
    message: str,
    chat_id: str,
    current_user_email: str
):
    """
    Внутренняя функция для обработки сообщения боту.
    Вызывается из send_message в chats.py.
    """
    print(f"\n[Bot {bot_id}] ========== НАЧАЛО ОБРАБОТКИ СООБЩЕНИЯ ==========")
    print(f"[Bot {bot_id}] Chat ID: {chat_id}")
    print(f"[Bot {bot_id}] User: {current_user_email}")
    print(f"[Bot {bot_id}] Message: {message[:100]}...")
    
    chats_collection = db_module.get_chats_collection()
    
    try:
        chat_oid = ObjectId(chat_id)
    except Exception as e:
        print(f"[Bot {bot_id}] ОШИБКА: Неверный формат Chat ID: {chat_id}, {e}")
        return
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        print(f"[Bot {bot_id}] ОШИБКА: Чат не найден: {chat_id}")
        return
    
    if chat.get("chat_type") != "bot" or chat.get("bot_id") != bot_id:
        print(f"[Bot {bot_id}] ОШИБКА: Это не чат с ботом {bot_id}, chat_type={chat.get('chat_type')}, bot_id={chat.get('bot_id')}")
        return
    
    # Получаем ответ от бота в зависимости от bot_id
    bot_email = f"bot_{bot_id}@flicker.local"
    
    # Отправляем событие "typing" от бота (показываем троеточие)
    typing_event = {
        "type": "typing",
        "chat_id": chat_id,
        "sender_email": bot_email
    }
    await manager.broadcast_to_participants(chat.get("participants", []), typing_event)
    
    if bot_id == "gigachat":
        # Обработка для GigaChat
        print(f"[GigaChat] Получаем access token...")
        access_token = await get_gigachat_access_token()
        
        if not access_token:
            print(f"[GigaChat] КРИТИЧЕСКАЯ ОШИБКА: Не удалось получить access token!")
            bot_response_text = "❌ Ошибка: не удалось авторизоваться в GigaChat API. Проверьте токен в настройках. Токены GigaChat можно получить бесплатно на https://developers.sber.ru/."
        else:
            print(f"[GigaChat] Access token получен, отправляем сообщение в GigaChat API...")
            bot_response_text = await send_message_to_gigachat(message, access_token)
            if not bot_response_text:
                print(f"[GigaChat] КРИТИЧЕСКАЯ ОШИБКА: Не удалось получить ответ от GigaChat API")
                bot_response_text = "❌ Ошибка: GigaChat API не ответил. Возможные причины:\n• Неверный токен или токен истек\n• Превышен лимит запросов\n• Проблемы с сетью\n\nПроверьте токен на https://developers.sber.ru/"
            else:
                print(f"[GigaChat] УСПЕХ: Ответ получен: {bot_response_text[:100]}...")
    
    elif bot_id == "deepseek":
        # Обработка для DeepSeek
        print(f"[DeepSeek] Отправляем сообщение в DeepSeek API...")
        bot_response_text = await send_message_to_deepseek(message)
        if not bot_response_text:
            print(f"[DeepSeek] КРИТИЧЕСКАЯ ОШИБКА: Не удалось получить ответ от DeepSeek API")
            bot_response_text = "❌ Ошибка: DeepSeek API не ответил. Возможные причины:\n• Неверный токен (API ключ)\n• Превышен бесплатный лимит запросов\n• Проблемы с сетью\n\nПолучите бесплатный токен на https://platform.deepseek.com/"
        else:
            print(f"[DeepSeek] УСПЕХ: Ответ получен: {bot_response_text[:100]}...")
    
    elif bot_id == "gemini":
        # Обработка для Gemini
        print(f"[Gemini] Отправляем сообщение в Gemini API...")
        bot_response_text = await send_message_to_gemini(message)
        if not bot_response_text:
            print(f"[Gemini] КРИТИЧЕСКАЯ ОШИБКА: Не удалось получить ответ от Gemini API")
            bot_response_text = "❌ Ошибка: Gemini API не ответил. Возможные причины:\n• Неверный API ключ\n• Превышен бесплатный лимит запросов\n• Проблемы с сетью\n\nПолучите бесплатный API ключ на https://makersuite.google.com/app/apikey"
        else:
            print(f"[Gemini] УСПЕХ: Ответ получен: {bot_response_text[:100]}...")
    
    elif bot_id == "gpt":
        # Обработка для OpenAI ChatGPT
        print(f"[GPT] Отправляем сообщение в OpenAI ChatGPT API...")
        bot_response_text = await send_message_to_gpt(message)
        if not bot_response_text:
            print(f"[GPT] КРИТИЧЕСКАЯ ОШИБКА: Не удалось получить ответ от OpenAI API")
            bot_response_text = (
                "❌ Ошибка: OpenAI API не ответил. Возможные причины:\n"
                "• Неверный API ключ\n"
                "• Превышен лимит запросов или закончился баланс\n"
                "• Проблемы с сетью\n\n"
                "Проверьте ключ в настройках OpenAI."
            )
        else:
            print(f"[GPT] УСПЕХ: Ответ получен: {bot_response_text[:100]}...")
    
    else:
        print(f"[Bot {bot_id}] ОШИБКА: Неизвестный бот")
        bot_response_text = "Извините, этот бот пока не поддерживается."
    
    # Отправляем событие "stopped_typing" от бота (убираем троеточие перед отправкой ответа)
    stopped_typing_event = {
        "type": "stopped_typing",
        "chat_id": chat_id,
        "sender_email": bot_email
    }
    await manager.broadcast_to_participants(chat.get("participants", []), stopped_typing_event)
    
    # Сохраняем ответ бота
    bot_message = {
        "_id": ObjectId(),
        "sender_id": bot_email,
        "content": bot_response_text,
        "timestamp": datetime.utcnow(),
        "type": "text",
        "file_url": None,
        "filename": None,
        "deleted_for_users": [],
        "read_by": [current_user_email]  # Автоматически помечаем как прочитанное
    }
    
    await chats_collection.update_one(
        {"_id": chat_oid},
        {
            "$push": {"messages": bot_message},
            "$set": {"last_message_at": bot_message["timestamp"]}
        }
    )
    
    # Отправляем ответ бота через WebSocket
    bot_message_for_response = bot_message.copy()
    bot_message_for_response["_id"] = str(bot_message_for_response["_id"])
    bot_message_for_response["timestamp"] = bot_message_for_response["timestamp"].isoformat() + "Z"
    bot_message_for_response["chat_id"] = chat_id
    await manager.broadcast_to_participants(chat.get("participants", []), bot_message_for_response)


@router.post("/api/bots/{bot_id}/send_message", summary="Отправить сообщение боту и получить ответ")
async def send_message_to_bot(
    bot_id: str,
    message: str,
    chat_id: str,
    current_user: Annotated[Dict[str, Any], Depends(get_current_user)]
):
    """Отправляет сообщение боту и получает ответ через GigaChat API."""
    # Проверяем, что бот существует
    bot = next((b for b in AVAILABLE_BOTS if b["bot_id"] == bot_id), None)
    if not bot:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Бот не найден."
        )
    
    # Проверяем, что бот поддерживает отправку сообщений
    if bot_id not in ["gigachat", "deepseek", "gemini"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Этот бот не поддерживает отправку сообщений."
        )
    
    chats_collection = db_module.get_chats_collection()
    current_user_email = current_user["email"]
    
    try:
        chat_oid = ObjectId(chat_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Неверный формат Chat ID."
        )
    
    chat: Optional[Dict[str, Any]] = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Чат не найден."
        )
    
    if current_user_email not in chat["participants"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="У вас нет доступа к этому чату."
        )
    
    if chat.get("chat_type") != "bot" or chat.get("bot_id") != bot_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Это не чат с этим ботом."
        )
    
    # Сохраняем сообщение пользователя
    user_message = {
        "_id": ObjectId(),
        "sender_id": current_user_email,
        "content": message,
        "timestamp": datetime.utcnow(),
        "type": "text",
        "file_url": None,
        "filename": None,
        "deleted_for_users": [],
        "read_by": []
    }
    
    await chats_collection.update_one(
        {"_id": chat_oid},
        {
            "$push": {"messages": user_message},
            "$set": {"last_message_at": user_message["timestamp"]}
        }
    )
    
    # Отправляем сообщение пользователя через WebSocket
    user_message_for_response = user_message.copy()
    user_message_for_response["_id"] = str(user_message_for_response["_id"])
    user_message_for_response["timestamp"] = user_message_for_response["timestamp"].isoformat() + "Z"
    user_message_for_response["chat_id"] = chat_id
    await manager.broadcast_to_participants(chat.get("participants", []), user_message_for_response)
    
    # Получаем ответ от GigaChat
    bot_email = f"bot_{bot_id}@flicker.local"
    access_token = await get_gigachat_access_token()
    
    if not access_token:
        bot_response_text = "Извините, сейчас я недоступен. Попробуйте позже."
    else:
        bot_response_text = await send_message_to_gigachat(message, access_token)
        if not bot_response_text:
            bot_response_text = "Извините, произошла ошибка при обработке вашего сообщения."
    
    # Сохраняем ответ бота
    bot_message = {
        "_id": ObjectId(),
        "sender_id": bot_email,
        "content": bot_response_text,
        "timestamp": datetime.utcnow(),
        "type": "text",
        "file_url": None,
        "filename": None,
        "deleted_for_users": [],
        "read_by": [current_user_email]  # Автоматически помечаем как прочитанное
    }
    
    await chats_collection.update_one(
        {"_id": chat_oid},
        {
            "$push": {"messages": bot_message},
            "$set": {"last_message_at": bot_message["timestamp"]}
        }
    )
    
    # Отправляем ответ бота через WebSocket
    bot_message_for_response = bot_message.copy()
    bot_message_for_response["_id"] = str(bot_message_for_response["_id"])
    bot_message_for_response["timestamp"] = bot_message_for_response["timestamp"].isoformat() + "Z"
    bot_message_for_response["chat_id"] = chat_id
    await manager.broadcast_to_participants(chat.get("participants", []), bot_message_for_response)
    
    return JSONResponse(content={
        "user_message": user_message_for_response,
        "bot_message": bot_message_for_response
    })

