"""
Модуль для обработки голосовых и видео звонков через WebRTC.
Использует существующий WebSocket для сигналинга.
Поддерживает приватные звонки и аудио-чаты (как Clubhouse/Discord stage).
"""
from typing import Dict, Optional, List
from datetime import datetime
from bson import ObjectId
import json
import asyncio

from fastapi import APIRouter, Depends

import backend.db.database as db_module
from backend.routes.websocket_manager import manager
from backend.dependencies import get_current_user


# FastAPI router для HTTP-эндпоинтов звонков
router = APIRouter(tags=["Calls"])

# Хранилище активных звонков: {call_id: {caller, callee, chat_id, type, status}}
active_calls: Dict[str, Dict] = {}

# Хранилище активных аудио-чатов: {audio_room_id: {creator, chat_id, participants, created_at}}
active_audio_chats: Dict[str, Dict] = {}


# ========================================================
# === ПРИВАТНЫЕ ЗВОНКИ (без изменений) ==================
# ========================================================

async def handle_call_initiate(caller_email: str, data: dict) -> Optional[dict]:
    """
    Обрабатывает инициацию приватного звонка.
    data: {chat_id, call_type: 'audio'|'video', call_id?}
    """
    chats_collection = db_module.get_chats_collection()
    chat_id_str = data.get("chat_id")
    call_type = data.get("call_type", "audio")
    call_id = data.get("call_id")
    
    if not chat_id_str:
        return {"type": "call_error", "error": "chat_id required"}
    
    try:
        chat_oid = ObjectId(chat_id_str)
    except Exception:
        return {"type": "call_error", "error": "invalid chat_id"}
    
    chat = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        return {"type": "call_error", "error": "chat not found"}
    
    participants = chat.get("participants", [])
    if caller_email.lower() not in [p.lower() for p in participants]:
        return {"type": "call_error", "error": "not a participant"}
    
    # Проверяем, что это приватный чат (не группа)
    is_group = chat.get("chat_type") == "group" or len(participants) > 2
    if is_group:
        return {"type": "call_error", "error": "use create_audio_chat for groups"}
    
    # Находим получателя
    callee_email = next(
        (p for p in participants if p.lower() != caller_email.lower()),
        None
    )
    if not callee_email:
        return {"type": "call_error", "error": "no callee found"}
    
    # Генерируем call_id если не предоставлен
    if not call_id:
        call_id = str(ObjectId())
    
    # Проверяем, не звонит ли уже кто-то в этот чат
    existing_call = next(
        (c for c in active_calls.values() 
         if (c.get("chat_id") == chat_id_str and 
             (c.get("status") == "ringing" or c.get("status") == "active"))),
        None
    )
    if existing_call:
        existing_call_id = next((cid for cid, c in active_calls.items() if c == existing_call), None)
        return {
            "type": "call_already_active",
            "call_id": existing_call_id,
            "chat_id": chat_id_str,
            "status": existing_call.get("status"),
            "caller": existing_call.get("caller"),
            "callee": existing_call.get("callee"),
            "call_type": existing_call.get("type")
        }
    
    # Сохраняем активный звонок
    caller_email_lower = caller_email.lower()
    callee_email_lower = callee_email.lower()
    active_calls[call_id] = {
        "caller": caller_email_lower,
        "callee": callee_email_lower,
        "chat_id": chat_id_str,
        "type": call_type,
        "status": "ringing",
        "started_at": datetime.utcnow(),
    }
    
    # Отправляем уведомление получателю
    await manager.send_to_user(
            callee_email_lower,
            {
                "type": "incoming_call",
                "call_id": call_id,
                "chat_id": chat_id_str,
                "caller_email": caller_email,
                "call_type": call_type,
            }
        )
    
    # Запускаем таймер автоматического завершения (30 секунд)
    asyncio.create_task(auto_end_call_after_timeout(call_id, 30))
    
    return {
        "type": "call_initiated",
        "call_id": call_id,
        "chat_id": chat_id_str,
    }


async def auto_end_call_after_timeout(call_id: str, timeout_seconds: int):
    """Автоматически завершает звонок если не ответили в течение timeout_seconds."""
    await asyncio.sleep(timeout_seconds)
    
    call = active_calls.get(call_id)
    if not call:
        return
    
    if call.get("status") == "ringing":
        caller_email = call.get("caller")
        callee_email = call.get("callee")
        
        await manager.send_to_user(
            caller_email,
            {
                "type": "call_ended",
                "call_id": call_id,
                "duration": 0,
                "status": "missed",
                "reason": "timeout"
            }
        )
        
        await manager.send_to_user(
                callee_email,
                {
                    "type": "call_ended",
                    "call_id": call_id,
                    "duration": 0,
                    "status": "missed",
                    "reason": "timeout"
                }
            )
        
        await save_call_to_history(call_id, call, "missed")
        await save_call_message_to_chat(call_id, call, "missed", 0, caller_email)
        
        if call_id in active_calls:
            del active_calls[call_id]


async def handle_call_accept(accepter_email: str, data: dict) -> Optional[dict]:
    """Обрабатывает принятие приватного звонка."""
    call_id = data.get("call_id")
    if not call_id:
        return {"type": "call_error", "error": "call_id required"}
    
    call = active_calls.get(call_id)
    if not call:
        return {"type": "call_error", "error": "call not found"}
    
    accepter_email_lower = accepter_email.lower()
    caller_email = call.get("caller")
    callee_email = call.get("callee")
    
    if accepter_email_lower != callee_email:
        return {"type": "call_error", "error": "unauthorized"}
    
    if call.get("status") != "ringing":
        return {"type": "call_error", "error": "call not ringing"}
    
    call["status"] = "active"
    call["accepted_at"] = datetime.utcnow()
    
    await manager.send_to_user(
        caller_email,
        {
            "type": "call_accepted",
            "call_id": call_id,
        }
    )
    
    await manager.send_to_user(
        callee_email,
        {
            "type": "call_accepted",
            "call_id": call_id,
        }
    )
    
    return {
        "type": "call_accepted",
        "call_id": call_id,
    }


async def handle_call_reject(rejecter_email: str, data: dict) -> Optional[dict]:
    """Обрабатывает отклонение приватного звонка."""
    call_id = data.get("call_id")
    if not call_id:
        return {"type": "call_error", "error": "call_id required"}
    
    call = active_calls.get(call_id)
    if not call:
        return {"type": "call_error", "error": "call not found"}
    
    rejecter_email_lower = rejecter_email.lower()
    caller_email = call.get("caller")
    callee_email = call.get("callee")
    
    if rejecter_email_lower != callee_email:
        return {"type": "call_error", "error": "unauthorized"}
    
    await manager.send_to_user(
        caller_email,
        {
            "type": "call_rejected",
            "call_id": call_id,
        }
    )
    
    await save_call_to_history(call_id, call, "rejected")
    await save_call_message_to_chat(call_id, call, "rejected", 0, rejecter_email_lower)
    
    del active_calls[call_id]
    
    return {
        "type": "call_rejected",
        "call_id": call_id,
    }


async def handle_call_end(ender_email: str, data: dict) -> Optional[dict]:
    """Обрабатывает завершение приватного звонка."""
    call_id = data.get("call_id")
    if not call_id:
        return {"type": "call_error", "error": "call_id required"}
    
    call = active_calls.get(call_id)
    if not call:
        return {"type": "call_error", "error": "call not found"}
    
    ender_email_lower = ender_email.lower()
    caller_email = call.get("caller")
    callee_email = call.get("callee")
    
    if ender_email_lower not in [caller_email, callee_email]:
        return {"type": "call_error", "error": "unauthorized"}
    
    other_participant = callee_email if ender_email_lower == caller_email else caller_email
    
    duration = None
    if call.get("accepted_at") and call.get("started_at"):
        duration = int((datetime.utcnow() - call.get("accepted_at")).total_seconds())
    elif call.get("started_at"):
        duration = 0
    
    status = "completed" if call.get("status") == "active" else "missed"
    await save_call_to_history(call_id, call, status)
    await save_call_message_to_chat(call_id, call, status, duration, ender_email_lower)
    
    await manager.send_to_user(
        other_participant,
        {
            "type": "call_ended",
            "call_id": call_id,
            "duration": duration,
            "status": status
        }
    )
    
    del active_calls[call_id]
    
    return {
        "type": "call_ended",
        "call_id": call_id,
        "duration": duration,
        "status": status
    }


async def handle_call_offer(offerer_email: str, data: dict) -> Optional[dict]:
    """Обрабатывает WebRTC SDP offer для приватных звонков."""
    call_id = data.get("call_id")
    offer = data.get("offer")
    
    if not call_id or not offer:
        return {"type": "call_error", "error": "call_id and offer required"}
    
    call = active_calls.get(call_id)
    if not call:
        return {"type": "call_error", "error": "call not found"}
    
    offerer_email_lower = offerer_email.lower()
    caller_email = call.get("caller")
    callee_email = call.get("callee")
    
    if offerer_email_lower == caller_email:
        recipient = callee_email
    elif offerer_email_lower == callee_email:
        recipient = caller_email
    else:
        return {"type": "call_error", "error": "unauthorized"}
    
    await manager.send_to_user(
            recipient,
            {
                "type": "call_offer",
                "call_id": call_id,
                "offer": offer,
            }
        )
    
    return None


async def handle_call_answer(answerer_email: str, data: dict) -> Optional[dict]:
    """Обрабатывает WebRTC SDP answer для приватных звонков."""
    call_id = data.get("call_id")
    answer = data.get("answer")
    
    if not call_id or not answer:
        return {"type": "call_error", "error": "call_id and answer required"}
    
    call = active_calls.get(call_id)
    if not call:
        return {"type": "call_error", "error": "call not found"}
    
    answerer_email_lower = answerer_email.lower()
    caller_email = call.get("caller")
    callee_email = call.get("callee")
    
    if answerer_email_lower == caller_email:
        recipient = callee_email
    elif answerer_email_lower == callee_email:
        recipient = caller_email
    else:
        return {"type": "call_error", "error": "unauthorized"}
    
    await manager.send_to_user(
            recipient,
            {
                "type": "call_answer",
                "call_id": call_id,
                "answer": answer,
            }
        )
    
    return None


async def handle_call_ice_candidate(sender_email: str, data: dict) -> Optional[dict]:
    """Обрабатывает WebRTC ICE candidate для приватных звонков."""
    call_id = data.get("call_id")
    candidate = data.get("candidate")
    
    if not call_id or candidate is None:
        return {"type": "call_error", "error": "call_id and candidate required"}
    
    call = active_calls.get(call_id)
    if not call:
        return {"type": "call_error", "error": "call not found"}
    
    sender_email_lower = sender_email.lower()
    caller_email = call.get("caller")
    callee_email = call.get("callee")
    
    if sender_email_lower == caller_email:
        recipient = callee_email
    elif sender_email_lower == callee_email:
        recipient = caller_email
    else:
        return {"type": "call_error", "error": "unauthorized"}
    
    await manager.send_to_user(
            recipient,
            {
                "type": "call_ice_candidate",
                "call_id": call_id,
                "candidate": candidate,
            }
        )
    
    return None


# ========================================================
# === АУДИО-ЧАТЫ (новая система) =========================
# ========================================================

async def handle_create_audio_chat(creator_email: str, data: dict) -> Optional[dict]:
    """
    Создает аудио-чат (комнату) в группе.
    data: {chat_id}
    """
    chats_collection = db_module.get_chats_collection()
    chat_id_str = data.get("chat_id")
    
    if not chat_id_str:
        return {"type": "audio_chat_error", "error": "chat_id required"}
    
    try:
        chat_oid = ObjectId(chat_id_str)
    except Exception:
        return {"type": "audio_chat_error", "error": "invalid chat_id"}
    
    chat = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        return {"type": "audio_chat_error", "error": "chat not found"}
    
    participants = chat.get("participants", [])
    creator_email_lower = creator_email.lower()
    
    if creator_email_lower not in [p.lower() for p in participants]:
        return {"type": "audio_chat_error", "error": "not a participant"}
    
    # Проверяем, что это группа
    is_group = chat.get("chat_type") == "group" or len(participants) > 2
    if not is_group:
        return {"type": "audio_chat_error", "error": "audio chats only for groups"}
    
    # Проверяем, нет ли уже активного аудио-чата в этом чате
    existing_room = next(
        (r for r in active_audio_chats.values() 
         if r.get("chat_id") == chat_id_str),
        None
    )
    if existing_room:
        existing_room_id = next((rid for rid, r in active_audio_chats.items() if r == existing_room), None)
        return {
            "type": "audio_chat_already_exists",
            "audio_room_id": existing_room_id,
            "chat_id": chat_id_str,
            "creator": existing_room.get("creator"),
            "participants": existing_room.get("participants", [])
        }
    
    # Генерируем ID комнаты
    audio_room_id = str(ObjectId())
    
    # Получаем информацию о создателе
    users_collection = db_module.get_users_collection()
    creator_user = await users_collection.find_one(
        {"email": creator_email},
        {"full_name": 1, "username": 1, "profile_picture": 1}
    )
    creator_name = (creator_user.get("full_name") or creator_user.get("username") or creator_email) if creator_user else creator_email
    
    # Создаем аудио-чат
    active_audio_chats[audio_room_id] = {
        "creator": creator_email_lower,
        "chat_id": chat_id_str,
        "participants": [creator_email_lower],  # Создатель уже в комнате
        "created_at": datetime.utcnow(),
    }
    
    # Создаем системное сообщение
    system_message_text = f"{creator_name} создал(а) аудио-чат"
    system_message = {
        "_id": ObjectId(),
        "sender_id": "system",
        "content": system_message_text,
        "timestamp": datetime.utcnow(),
        "type": "system",
        "deleted_for_users": [],
        "read_by": [],
        "audio_room_id": audio_room_id,
        "audio_chat_created": True,
        "creator_email": creator_email,
        "creator_name": creator_name,
        "creator_avatar": creator_user.get("profile_picture") if creator_user else None
    }
    
    # Сохраняем системное сообщение в чат
    await chats_collection.update_one(
        {"_id": chat_oid},
        {
            "$push": {"messages": system_message},
            "$set": {"last_message_at": system_message["timestamp"]}
        }
    )
    
    # Отправляем системное сообщение всем участникам
    system_message_for_response = system_message.copy()
    system_message_for_response["_id"] = str(system_message_for_response["_id"])
    system_message_for_response["timestamp"] = system_message_for_response["timestamp"].isoformat() + "Z"
    system_message_for_response["chat_id"] = chat_id_str
    
    await manager.broadcast_to_participants(participants, system_message_for_response)
    
    # Отправляем уведомление о создании аудио-чата всем участникам
    await manager.broadcast_to_participants(
        participants,
        {
            "type": "audio_chat_created",
            "audio_room_id": audio_room_id,
            "chat_id": chat_id_str,
            "creator_email": creator_email,
            "creator_name": creator_name,
            "creator_avatar": creator_user.get("profile_picture") if creator_user else None,
            "group_name": chat.get("group_name", "Группа"),
        }
    )
    
    return {
        "type": "audio_chat_created",
        "audio_room_id": audio_room_id,
        "chat_id": chat_id_str,
    }


async def handle_join_audio_chat(user_email: str, data: dict) -> Optional[dict]:
    """
    Присоединяет пользователя к аудио-чату.
    data: {audio_room_id}
    """
    audio_room_id = data.get("audio_room_id")
    if not audio_room_id:
        return {"type": "audio_chat_error", "error": "audio_room_id required"}
    
    room = active_audio_chats.get(audio_room_id)
    if not room:
        return {"type": "audio_chat_error", "error": "audio chat not found"}
    
    user_email_lower = user_email.lower()
    chat_id_str = room.get("chat_id")
    participants = room.get("participants", [])
    
    # Проверяем, что пользователь в чате
    chats_collection = db_module.get_chats_collection()
    try:
        chat_oid = ObjectId(chat_id_str)
    except Exception:
        return {"type": "audio_chat_error", "error": "invalid chat_id"}
    
    chat = await chats_collection.find_one({"_id": chat_oid})
    if not chat:
        return {"type": "audio_chat_error", "error": "chat not found"}
    
    chat_participants = chat.get("participants", [])
    if user_email_lower not in [p.lower() for p in chat_participants]:
        return {"type": "audio_chat_error", "error": "not a participant"}
    
    # Проверяем, не присоединился ли уже
    if user_email_lower in participants:
        return {
            "type": "audio_chat_joined",
            "audio_room_id": audio_room_id,
            "participants": participants,
        }
    
    # Получаем информацию о пользователе
    users_collection = db_module.get_users_collection()
    user = await users_collection.find_one(
        {"email": user_email},
        {"full_name": 1, "username": 1, "profile_picture": 1}
    )
    user_name = (user.get("full_name") or user.get("username") or user_email) if user else user_email
    user_avatar = user.get("profile_picture") if user else None
    
    # Добавляем участника
    participants.append(user_email_lower)
    room["participants"] = participants
    
    # Уведомляем всех участников чата о присоединении
    await manager.broadcast_to_participants(
        chat_participants,
        {
            "type": "audio_chat_participant_joined",
            "audio_room_id": audio_room_id,
            "chat_id": chat_id_str,
            "participant_email": user_email,
            "participant_name": user_name,
            "participant_avatar": user_avatar,
            "participants": participants,
        }
    )
    
    return {
        "type": "audio_chat_joined",
        "audio_room_id": audio_room_id,
        "chat_id": chat_id_str,
        "participants": participants,
    }


async def handle_leave_audio_chat(user_email: str, data: dict) -> Optional[dict]:
    """
    Удаляет пользователя из аудио-чата.
    data: {audio_room_id}
    """
    audio_room_id = data.get("audio_room_id")
    if not audio_room_id:
        return {"type": "audio_chat_error", "error": "audio_room_id required"}
    
    room = active_audio_chats.get(audio_room_id)
    if not room:
        return {"type": "audio_chat_error", "error": "audio chat not found"}
    
    user_email_lower = user_email.lower()
    participants = room.get("participants", [])
    
    if user_email_lower not in participants:
        return {"type": "audio_chat_error", "error": "not in audio chat"}
    
    # Удаляем участника
    participants = [p for p in participants if p != user_email_lower]
    room["participants"] = participants
    
    chat_id_str = room.get("chat_id")
    creator = room.get("creator")
    
    # Если никого не осталось, закрываем комнату
    if len(participants) == 0:
        # Получаем информацию о вышедшем пользователе
        users_collection = db_module.get_users_collection()
        user = await users_collection.find_one(
            {"email": user_email},
            {"full_name": 1, "username": 1}
        )
        user_name = (user.get("full_name") or user.get("username") or user_email) if user else user_email
        
        # Создаем системное сообщение о закрытии
        chats_collection = db_module.get_chats_collection()
        try:
            chat_oid = ObjectId(chat_id_str)
            chat = await chats_collection.find_one({"_id": chat_oid})
            if chat:
                system_message_text = f"Аудио-чат завершен"
                system_message = {
                    "_id": ObjectId(),
                    "sender_id": "system",
                    "content": system_message_text,
                    "timestamp": datetime.utcnow(),
                    "type": "system",
                    "deleted_for_users": [],
                    "read_by": [],
                    "audio_room_id": audio_room_id,
                    "audio_chat_ended": True,
                }
                
                await chats_collection.update_one(
                    {"_id": chat_oid},
                    {
                        "$push": {"messages": system_message},
                        "$set": {"last_message_at": system_message["timestamp"]}
                    }
                )
                
                system_message_for_response = system_message.copy()
                system_message_for_response["_id"] = str(system_message_for_response["_id"])
                system_message_for_response["timestamp"] = system_message_for_response["timestamp"].isoformat() + "Z"
                system_message_for_response["chat_id"] = chat_id_str
                
                await manager.broadcast_to_participants(chat.get("participants", []), system_message_for_response)
        except Exception as e:
            print(f"[AudioChat] Error saving end message: {e}")
        
        # Уведомляем всех участников чата о закрытии
        if chat:
            await manager.broadcast_to_participants(
                chat.get("participants", []),
                {
                    "type": "audio_chat_ended",
                    "audio_room_id": audio_room_id,
                    "chat_id": chat_id_str,
                }
            )
        
        # Удаляем комнату
        del active_audio_chats[audio_room_id]
    else:
        # Уведомляем остальных участников о выходе
        chats_collection = db_module.get_chats_collection()
        try:
            chat_oid = ObjectId(chat_id_str)
            chat = await chats_collection.find_one({"_id": chat_oid})
            if chat:
                users_collection = db_module.get_users_collection()
                user = await users_collection.find_one(
                    {"email": user_email},
                    {"full_name": 1, "username": 1, "profile_picture": 1}
                )
                user_name = (user.get("full_name") or user.get("username") or user_email) if user else user_email
                user_avatar = user.get("profile_picture") if user else None
                
                await manager.broadcast_to_participants(
                    chat.get("participants", []),
                    {
                        "type": "audio_chat_participant_left",
                        "audio_room_id": audio_room_id,
                        "chat_id": chat_id_str,
                        "participant_email": user_email,
                        "participant_name": user_name,
                        "participant_avatar": user_avatar,
                        "participants": participants,
                    }
                )
        except Exception as e:
            print(f"[AudioChat] Error notifying participants: {e}")
    
    # Получаем информацию о создателе и чате для ответа
    chat_id_str = room.get("chat_id")
    creator = room.get("creator")
    creator_name = None
    creator_avatar = None
    
    if chat_id_str and creator:
        try:
            chats_collection = db_module.get_chats_collection()
            chat_oid = ObjectId(chat_id_str)
            chat = await chats_collection.find_one({"_id": chat_oid})
            if chat:
                users_collection = db_module.get_users_collection()
                creator_user = await users_collection.find_one(
                    {"email": creator},
                    {"full_name": 1, "username": 1, "profile_picture": 1}
                )
                if creator_user:
                    creator_name = creator_user.get("full_name") or creator_user.get("username") or creator
                    creator_avatar = creator_user.get("profile_picture")
        except Exception as e:
            print(f"[AudioChat] Error getting creator info: {e}")
    
    return {
        "type": "audio_chat_left",
        "audio_room_id": audio_room_id,
        "chat_id": chat_id_str,
        "participants": participants,
        "creator_email": creator,
        "creator_name": creator_name,
        "creator_avatar": creator_avatar,
    }


# ========================================================
# === WebRTC для аудио-чатов =============================
# ========================================================

async def handle_audio_chat_offer(offerer_email: str, data: dict) -> Optional[dict]:
    """
    Обрабатывает WebRTC SDP offer для аудио-чата.
    data: {audio_room_id, offer: {...}, target_email}
    """
    audio_room_id = data.get("audio_room_id")
    offer = data.get("offer")
    target_email = data.get("target_email")
    
    if not audio_room_id or not offer or not target_email:
        return {"type": "audio_chat_error", "error": "audio_room_id, offer and target_email required"}
    
    room = active_audio_chats.get(audio_room_id)
    if not room:
        return {"type": "audio_chat_error", "error": "audio chat not found"}
    
    offerer_email_lower = offerer_email.lower()
    target_email_lower = target_email.lower()
    participants = room.get("participants", [])
    
    # Проверяем, что оба участника в комнате
    if offerer_email_lower not in participants or target_email_lower not in participants:
        return {"type": "audio_chat_error", "error": "participants not in room"}
    
    # Пересылаем offer целевому участнику
    await manager.send_to_user(
        target_email_lower,
        {
            "type": "audio_chat_offer",
            "audio_room_id": audio_room_id,
            "offer": offer,
            "from_email": offerer_email,
        }
    )
    
    return None


async def handle_audio_chat_answer(answerer_email: str, data: dict) -> Optional[dict]:
    """
    Обрабатывает WebRTC SDP answer для аудио-чата.
    data: {audio_room_id, answer: {...}, target_email}
    """
    audio_room_id = data.get("audio_room_id")
    answer = data.get("answer")
    target_email = data.get("target_email")
    
    if not audio_room_id or not answer or not target_email:
        return {"type": "audio_chat_error", "error": "audio_room_id, answer and target_email required"}
    
    room = active_audio_chats.get(audio_room_id)
    if not room:
        return {"type": "audio_chat_error", "error": "audio chat not found"}
    
    answerer_email_lower = answerer_email.lower()
    target_email_lower = target_email.lower()
    participants = room.get("participants", [])
    
    # Проверяем, что оба участника в комнате
    if answerer_email_lower not in participants or target_email_lower not in participants:
        return {"type": "audio_chat_error", "error": "participants not in room"}
    
    # Пересылаем answer целевому участнику
    await manager.send_to_user(
        target_email_lower,
        {
            "type": "audio_chat_answer",
            "audio_room_id": audio_room_id,
            "answer": answer,
            "from_email": answerer_email,
        }
    )
    
    return None


async def handle_audio_chat_ice_candidate(sender_email: str, data: dict) -> Optional[dict]:
    """
    Обрабатывает WebRTC ICE candidate для аудио-чата.
    data: {audio_room_id, candidate: {...}, target_email}
    """
    audio_room_id = data.get("audio_room_id")
    candidate = data.get("candidate")
    target_email = data.get("target_email")
    
    if not audio_room_id or candidate is None or not target_email:
        return {"type": "audio_chat_error", "error": "audio_room_id, candidate and target_email required"}
    
    room = active_audio_chats.get(audio_room_id)
    if not room:
        return {"type": "audio_chat_error", "error": "audio chat not found"}
    
    sender_email_lower = sender_email.lower()
    target_email_lower = target_email.lower()
    participants = room.get("participants", [])
    
    # Проверяем, что оба участника в комнате
    if sender_email_lower not in participants or target_email_lower not in participants:
        return {"type": "audio_chat_error", "error": "participants not in room"}
    
    # Пересылаем candidate целевому участнику
    await manager.send_to_user(
        target_email_lower,
        {
            "type": "audio_chat_ice_candidate",
            "audio_room_id": audio_room_id,
            "candidate": candidate,
            "from_email": sender_email,
        }
    )
    
    return None


# ========================================================
# === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===========================
# ========================================================

async def save_call_to_history(call_id: str, call_data: dict, final_status: str):
    """Сохраняет завершенный звонок в историю."""
    calls_collection = db_module.get_calls_collection()
    
    duration = None
    if call_data.get("accepted_at") and call_data.get("started_at"):
        duration = int((datetime.utcnow() - call_data.get("accepted_at")).total_seconds())
    elif call_data.get("started_at"):
        duration = 0
    
    call_doc = {
        "_id": ObjectId(call_id) if len(call_id) == 24 else ObjectId(),
        "call_id": call_id,
        "caller": call_data.get("caller"),
        "callee": call_data.get("callee"),
        "chat_id": call_data.get("chat_id"),
        "type": call_data.get("type", "audio"),
        "status": final_status,
        "started_at": call_data.get("started_at"),
        "accepted_at": call_data.get("accepted_at"),
        "ended_at": datetime.utcnow(),
        "duration": duration,
    }
    
    try:
        await calls_collection.insert_one(call_doc)
    except Exception as e:
        print(f"[Calls] Error saving call to history: {e}")


async def save_call_message_to_chat(call_id: str, call_data: dict, final_status: str, duration: Optional[int], ender_email: str):
    """Сохраняет системное сообщение о звонке в чат."""
    try:
        chats_collection = db_module.get_chats_collection()
        users_collection = db_module.get_users_collection()
        
        chat_id = call_data.get("chat_id")
        if not chat_id:
            return
        
        try:
            chat_oid = ObjectId(chat_id)
        except Exception:
            return
        
        chat = await chats_collection.find_one({"_id": chat_oid})
        if not chat:
            return
        
        caller_email = call_data.get("caller")
        callee_email = call_data.get("callee")
        
        caller_user = await users_collection.find_one({"email": caller_email}, {"full_name": 1, "username": 1})
        callee_user = await users_collection.find_one({"email": callee_email}, {"full_name": 1, "username": 1})
        
        caller_name = (caller_user.get("full_name") or caller_user.get("username") or caller_email) if caller_user else caller_email
        callee_name = (callee_user.get("full_name") or callee_user.get("username") or callee_email) if callee_user else callee_email
        
        call_type_text = "видеозвонок" if call_data.get("type") == "video" else "звонок"
        
        if final_status == "completed" and duration is not None:
            minutes = duration // 60
            seconds = duration % 60
            if minutes > 0:
                duration_text = f"{minutes} мин {seconds} сек"
            else:
                duration_text = f"{seconds} сек"
            
                message_text = f"📞 {call_type_text.capitalize()}: {caller_name} → {callee_name} ({duration_text})"
        elif final_status == "missed":
            if ender_email == caller_email:
                message_text = f"📞 {call_type_text.capitalize()} не отвечен: {caller_name} → {callee_name}"
            else:
                message_text = f"📞 Пропущенный {call_type_text}: {caller_name} → {callee_name}"
        elif final_status == "rejected":
            message_text = f"📞 {call_type_text.capitalize()} отклонен: {caller_name} → {callee_name}"
        else:
            message_text = f"📞 {call_type_text.capitalize()}: {caller_name} → {callee_name}"
        
        system_message = {
            "_id": ObjectId(),
            "sender_id": "system",
            "content": message_text,
            "timestamp": datetime.utcnow(),
            "type": "system",
            "deleted_for_users": [],
            "read_by": [],
            "call_id": call_id,
            "call_duration": duration
        }
        
        await chats_collection.update_one(
            {"_id": chat_oid},
            {
                "$push": {"messages": system_message},
                "$set": {"last_message_at": system_message["timestamp"]}
            }
        )
        
        system_message_for_response = system_message.copy()
        system_message_for_response["_id"] = str(system_message_for_response["_id"])
        system_message_for_response["timestamp"] = system_message_for_response["timestamp"].isoformat() + "Z"
        system_message_for_response["chat_id"] = chat_id
        
        await manager.broadcast_to_participants(chat.get("participants", []), system_message_for_response)
        
    except Exception as e:
        print(f"[Calls] Error saving call message to chat: {e}")


@router.get(
    "/api/calls/history",
    summary="Получить историю звонков текущего пользователя",
)
async def get_calls_history(
    limit: int = 50,
    current_user: dict = Depends(get_current_user),
):
    """
    Возвращает список последних звонков (входящих и исходящих) для текущего пользователя.
    Список отсортирован по времени начала звонка (от новых к старым).
    """
    calls_collection = db_module.get_calls_collection()
    users_collection = db_module.get_users_collection()

    user_email = current_user["email"].lower()

    cursor = (
        calls_collection.find(
            {
                "$or": [
                    {"caller": user_email},
                    {"callee": user_email},
                ]
            }
        )
        .sort("started_at", -1)
        .limit(int(limit))
    )

    calls: List[Dict] = []
    peer_emails: set[str] = set()

    async for doc in cursor:
        caller = (doc.get("caller") or "").lower()
        callee = (doc.get("callee") or "").lower()

        if caller == user_email:
            direction = "outgoing"
            peer_email = callee
        else:
            direction = "incoming"
            peer_email = caller

        if peer_email:
            peer_emails.add(peer_email)

        calls.append(
            {
                "id": str(doc.get("_id")),
                "call_id": doc.get("call_id"),
                "caller": caller,
                "callee": callee,
                "chat_id": doc.get("chat_id"),
                "type": doc.get("type", "audio"),
                "status": doc.get("status", "completed"),
                "started_at": doc.get("started_at"),
                "accepted_at": doc.get("accepted_at"),
                "ended_at": doc.get("ended_at"),
                "duration": doc.get("duration"),
                "direction": direction,
                "peer_email": peer_email,
            }
        )

    # Подтягиваем имена и аватары собеседников одним запросом
    peers_map: Dict[str, Dict] = {}
    if peer_emails:
        async for user in users_collection.find(
            {"email": {"$in": list(peer_emails)}},
            {
                "email": 1,
                "full_name": 1,
                "username": 1,
                "profile_picture": 1,
                "_id": 0,
            },
        ):
            email = (user.get("email") or "").lower()
            if not email:
                continue
            peers_map[email] = {
                "name": user.get("full_name")
                or user.get("username")
                or user.get("email"),
                "avatar": user.get("profile_picture"),
            }

    def _to_iso(dt: Optional[datetime]) -> Optional[str]:
        if not isinstance(dt, datetime):
            return None
        # Храним в UTC, отдаем в ISO-формате
        return dt.replace(tzinfo=None).isoformat() + "Z"

    # Обогащаем результат человекочитаемыми данными
    result_calls: List[Dict] = []
    for item in calls:
        peer_info = peers_map.get(item["peer_email"] or "", {})

        result_calls.append(
            {
                "id": item["id"],
                "call_id": item.get("call_id"),
                "chat_id": item.get("chat_id"),
                "type": item.get("type", "audio"),
                "status": item.get("status", "completed"),
                "direction": item["direction"],
                "duration": item.get("duration"),
                "started_at": _to_iso(item.get("started_at")),
                "accepted_at": _to_iso(item.get("accepted_at")),
                "ended_at": _to_iso(item.get("ended_at")),
                "peer_email": item.get("peer_email"),
                "peer_name": peer_info.get("name") or item.get("peer_email"),
                "peer_avatar": peer_info.get("avatar"),
            }
        )

    return {"calls": result_calls}
