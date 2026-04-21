import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

# Берем параметры подключения из переменных окружения,
# чтобы не хранить чувствительные данные (логин/пароль) в коде.
# Обязательно задайте их в .env или окружении контейнера/сервера.
MONGODB_URL = os.getenv("MONGODB_URL")
DATABASE_NAME = os.getenv("MONGODB_DB", "flicker_messenger_db")

if not MONGODB_URL:
    raise RuntimeError(
        "Переменная окружения MONGODB_URL не задана. "
        "Укажите строку подключения к MongoDB в .env или docker-compose."
    )

client: AsyncIOMotorClient = None
db = None

async def connect_db():
    global client, db
    if client is None:
        client = AsyncIOMotorClient(MONGODB_URL)
        db = client[DATABASE_NAME]
        print("Connected to MongoDB!")

async def close_db():
    global client, db
    if client:
        client.close()
        client = None
        db = None
        print("Disconnected from MongoDB.")

def get_users_collection():
    if db is None:
        raise RuntimeError("База данных не подключена. Вызовите connect_db() перед использованием.")
    return db.users

def get_chats_collection():
    if db is None:
        raise RuntimeError("База данных не подключена. Вызовите connect_db() перед использованием.")
    return db.chats

def get_calls_collection():
    if db is None:
        raise RuntimeError("База данных не подключена. Вызовите connect_db() перед использованием.")
    return db.calls