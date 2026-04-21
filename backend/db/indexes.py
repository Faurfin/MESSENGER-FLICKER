"""
Создание индексов для оптимизации запросов к MongoDB.
Индексы создаются при старте приложения.
"""
import asyncio
from typing import Optional
import backend.db.database as db_module


async def create_indexes():
    """
    Создает необходимые индексы для оптимизации производительности.
    Вызывается при старте приложения.
    """
    chats_collection = db_module.get_chats_collection()
    users_collection = db_module.get_users_collection()
    
    print("Создание индексов для оптимизации производительности...")
    
    try:
        # === ИНДЕКСЫ ДЛЯ ЧАТОВ ===
        
        # 1. Индекс на participants для быстрого поиска чатов пользователя
        # Используется в: find({"participants": user_email})
        await chats_collection.create_index("participants")
        print("✓ Индекс создан: chats.participants")
        
        # 2. Составной индекс для сортировки чатов по последнему сообщению
        # Используется в: find({"participants": user_email}).sort("last_message_at", -1)
        await chats_collection.create_index([("participants", 1), ("last_message_at", -1)])
        print("✓ Индекс создан: chats.participants + last_message_at")
        
        # 3. Индекс на last_message_at для сортировки
        await chats_collection.create_index("last_message_at")
        print("✓ Индекс создан: chats.last_message_at")
        
        # 4. Индекс на chat_type для фильтрации
        await chats_collection.create_index("chat_type")
        print("✓ Индекс создан: chats.chat_type")
        
        # 5. Индекс на bot_id для быстрого поиска ботов
        await chats_collection.create_index("bot_id")
        print("✓ Индекс создан: chats.bot_id")
        
        # 6. Индекс на owner для групповых чатов
        await chats_collection.create_index("owner")
        print("✓ Индекс создан: chats.owner")
        
        # === ИНДЕКСЫ ДЛЯ ПОЛЬЗОВАТЕЛЕЙ ===
        
        # 7. Индекс на email (уникальный) - должен быть, но проверим
        await users_collection.create_index("email", unique=True)
        print("✓ Индекс создан: users.email (unique)")
        
        # 8. Индекс на username для поиска
        await users_collection.create_index("username")
        print("✓ Индекс создан: users.username")
        
        # 9. Индекс на full_name для поиска
        await users_collection.create_index("full_name")
        print("✓ Индекс создан: users.full_name")
        
        # 10. Текстовый индекс для полнотекстового поиска
        # Позволяет искать по username, email, full_name одновременно
        try:
            await users_collection.create_index([
                ("username", "text"),
                ("email", "text"),
                ("full_name", "text")
            ])
            print("✓ Текстовый индекс создан: users (username, email, full_name)")
        except Exception as e:
            # Если текстовый индекс уже существует или не поддерживается
            print(f"⚠ Текстовый индекс не создан (возможно уже существует): {e}")
        
        print("✅ Все индексы успешно созданы!")
        
    except Exception as e:
        print(f"⚠ Ошибка при создании индексов: {e}")
        # Не прерываем работу приложения, если индексы не создались
        # (они могут уже существовать)


async def ensure_indexes():
    """
    Проверяет и создает индексы, если их нет.
    Безопасная версия, которая не выдает ошибки если индексы уже существуют.
    """
    try:
        await create_indexes()
    except Exception as e:
        print(f"⚠ Предупреждение при создании индексов: {e}")
