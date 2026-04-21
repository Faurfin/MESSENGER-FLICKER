from fastapi import APIRouter, Depends, Form, HTTPException, status, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from typing import Annotated, Optional, Dict, Any
import os

import backend.db.database as db_module
from backend.auth.auth_utils import hash_password, verify_password, create_access_token
from backend.db.models import UserLogin, UserRegister, Token
from backend.dependencies import get_current_user

# Инициализация шаблонов
auth_templates = Jinja2Templates(directory="auth")

router = APIRouter(tags=["Authentication"])

# В продакшене куки должны быть только по HTTPS.
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "").lower() == "true"

# --- ФУНКЦИЯ АВТО-ОБНОВЛЕНИЯ ВЕРСИЙ (Кэш-бастинг) ---
def static_versioned(url: str) -> str:
    """
    Принимает URL ресурса (например, /auth_static/auth.css),
    находит файл на диске, берет время его изменения
    и возвращает URL с параметром версии: /auth_static/auth.css?v=123456789
    """
    try:
        # В main.py рабочая директория установлена в 'frontend'
        # Маппинг URL -> Путь к файлу на диске:
        # /auth_static/file.css -> auth/file.css
        if url.startswith("/auth_static/"):
            file_path = f"auth/{url.replace('/auth_static/', '')}"
        elif url.startswith("/images/"):
             # Если нужно версионировать картинки, но они лежат в ../images
             # Нужно выйти из frontend на уровень вверх
             file_path = f"../images/{url.replace('/images/', '')}"
        else:
            return url
        
        # Получаем время последнего изменения файла
        timestamp = int(os.path.getmtime(file_path))
        return f"{url}?v={timestamp}"
    except Exception as e:
        # Если файл не найден или ошибка — возвращаем как есть
        # print(f"Error versioning static file {url}: {e}")
        return url


# ------------------------------
#  ЕДИНАЯ СТРАНИЦА АВТОРИЗАЦИИ
# ------------------------------
@router.get("/auth_page", response_class=HTMLResponse, summary="Единая страница входа и регистрации")
async def get_auth_page(
    request: Request,
    tab: Optional[str] = "register",
    error_message: Optional[str] = None,
    success_message: Optional[str] = None
):
    """
    Показывает страницу с формами регистрации и входа.
    """
    # Если пользователь уже авторизован — сразу в чаты
    try:
        current_user = await get_current_user(request)
        if current_user:
            return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)
    except Exception:
        pass

    return auth_templates.TemplateResponse("auth.html", {
        "request": request,
        "tab": tab,
        "error_message": error_message,
        "success_message": success_message,
        "static_url": static_versioned  # <--- ПЕРЕДАЕМ ФУНКЦИЮ В ШАБЛОН
    })


# ------------------------------
#  РЕГИСТРАЦИЯ
# ------------------------------
@router.post("/register", response_class=HTMLResponse, summary="Обработка регистрации нового пользователя")
async def register_user_from_form(
    request: Request,
    username: Annotated[str, Form()],
    email: Annotated[str, Form()],
    password: Annotated[str, Form()]
):
    try:
        # Гарантируем, что подключение к БД установлено
        if db_module.db is None:
            await db_module.connect_db()
        
        users_collection = db_module.get_users_collection()

        # Проверяем существование пользователя по email
        existing_user_by_email: Optional[Dict[str, Any]] = await users_collection.find_one({"email": email})
        if existing_user_by_email:
            return auth_templates.TemplateResponse("auth.html", {
                "request": request,
                "tab": "register",
                "error_message": "Пользователь с таким email уже зарегистрирован.",
                "static_url": static_versioned
            }, status_code=status.HTTP_409_CONFLICT)

        # Проверяем существование пользователя по username
        existing_user_by_username: Optional[Dict[str, Any]] = await users_collection.find_one({"username": username})
        if existing_user_by_username:
            return auth_templates.TemplateResponse("auth.html", {
                "request": request,
                "tab": "register",
                "error_message": "Пользователь с таким никнеймом уже существует.",
                "static_url": static_versioned
            }, status_code=status.HTTP_409_CONFLICT)

        # Хешируем пароль
        hashed_password = hash_password(password)
        
        # Создаем документ пользователя (не включаем поля со значением None)
        user_document = {
            "username": username,
            "email": email,
            "hashed_password": hashed_password,
            "full_name": username,
            "contacts": [],
            "privacy_settings": {},
            "blocked_users": []
        }
        
        # Добавляем опциональные поля только если они не None
        # (MongoDB не принимает None для некоторых полей, особенно если есть текстовые индексы)

        # Сохраняем пользователя в БД
        await users_collection.insert_one(user_document)
        
        # Создаем токен доступа
        access_token = create_access_token(data={"sub": email, "username": username})
        
        # Создаем ответ с редиректом и устанавливаем cookie
        response = RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)
        response.set_cookie(
            key="access_token",
            value=access_token,
            httponly=True,
            samesite="Lax",
            secure=COOKIE_SECURE,
            path="/",
            max_age=365 * 24 * 60 * 60,
        )
        return response
        
    except Exception as e:
        import traceback
        error_traceback = traceback.format_exc()
        print(f"Ошибка при регистрации пользователя: {e}")
        print(f"Traceback: {error_traceback}")
        
        # Определяем более конкретное сообщение об ошибке
        error_message = "Ошибка при регистрации пользователя."
        if "duplicate key" in str(e).lower() or "E11000" in str(e):
            error_message = "Пользователь с таким email или никнеймом уже существует."
        elif "connection" in str(e).lower() or "timeout" in str(e).lower():
            error_message = "Ошибка подключения к базе данных. Попробуйте позже."
        
        return auth_templates.TemplateResponse("auth.html", {
            "request": request,
            "tab": "register",
            "error_message": error_message,
            "static_url": static_versioned
        }, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ------------------------------
#  ВХОД
# ------------------------------
@router.post("/login", response_class=HTMLResponse, summary="Обработка входа пользователя")
async def login_user_from_form(
    request: Request,
    email: Annotated[str, Form()],
    password: Annotated[str, Form()]
):
    try:
        # Гарантируем, что подключение к БД установлено
        if db_module.db is None:
            await db_module.connect_db()
        users_collection = db_module.get_users_collection()

        user_data: Optional[Dict[str, Any]] = await users_collection.find_one({"email": email})

        if not user_data or not verify_password(password, user_data["hashed_password"]):
            return auth_templates.TemplateResponse("auth.html", {
                "request": request,
                "tab": "login",
                "error_message": "Неправильный email или пароль.",
                "static_url": static_versioned
            }, status_code=status.HTTP_401_UNAUTHORIZED)

        access_token = create_access_token(data={"sub": user_data["email"], "username": user_data["username"]})
        response = RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)
        response.set_cookie(
            key="access_token",
            value=access_token,
            httponly=True,
            samesite="Lax",
            secure=COOKIE_SECURE,
            path="/",
            max_age=365 * 24 * 60 * 60,
        )
        return response
    except Exception as e:
        import traceback
        error_traceback = traceback.format_exc()
        print(f"Ошибка при входе пользователя: {e}")
        print(f"Traceback: {error_traceback}")
        
        return auth_templates.TemplateResponse("auth.html", {
            "request": request,
            "tab": "login",
            "error_message": "Ошибка при входе. Попробуйте позже.",
            "static_url": static_versioned
        }, status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


# ------------------------------
#  ВЫХОД
# ------------------------------
@router.get("/logout", summary="Выход пользователя")
async def logout_user():
    response = RedirectResponse(url="/auth_page?tab=login", status_code=status.HTTP_303_SEE_OTHER)
    response.delete_cookie(
        key="access_token",
        httponly=True,
        samesite="Lax",
        secure=COOKIE_SECURE,
    )
    return response

# ------------------------------
#  API ENDPOINTS FOR MOBILE APP
# ------------------------------
@router.post("/api/auth/register", response_model=Token, summary="API Registration")
async def register_user_api(user_data: UserRegister):
    # Гарантируем, что подключение к БД установлено
    if db_module.db is None:
        await db_module.connect_db()
    
    users_collection = db_module.get_users_collection()

    # Проверяем существование пользователя по email
    existing_user_by_email = await users_collection.find_one({"email": user_data.email})
    if existing_user_by_email:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User with this email already exists"
        )

    # Проверяем существование пользователя по username
    existing_user_by_username = await users_collection.find_one({"username": user_data.username})
    if existing_user_by_username:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User with this username already exists"
        )

    # Хешируем пароль
    hashed_password = hash_password(user_data.password)
    
    # Создаем документ пользователя
    user_document = {
        "username": user_data.username,
        "email": user_data.email,
        "hashed_password": hashed_password,
        "full_name": user_data.username,
        "contacts": [],
        "privacy_settings": {},
        "blocked_users": []
    }
    
    # Сохраняем пользователя в БД
    await users_collection.insert_one(user_document)
    
    # Создаем токен доступа
    access_token = create_access_token(data={"sub": user_data.email, "username": user_data.username})
    
    return {"access_token": access_token, "token_type": "bearer"}

@router.post("/api/auth/login", response_model=Token, summary="API Login")
async def login_user_api(user_data: UserLogin):
    # Гарантируем, что подключение к БД установлено
    if db_module.db is None:
        await db_module.connect_db()
    users_collection = db_module.get_users_collection()

    user = await users_collection.find_one({"email": user_data.email})
    
    if not user or not verify_password(user_data.password, user["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token = create_access_token(data={"sub": user["email"], "username": user["username"]})
    return {"access_token": access_token, "token_type": "bearer"}
