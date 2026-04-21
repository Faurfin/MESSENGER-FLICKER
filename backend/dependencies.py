from fastapi import Depends, HTTPException, status, Request
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from typing import Annotated, Dict, Any, Optional
from datetime import datetime

import os
from dotenv import load_dotenv

import backend.db.database as db_module
from backend.auth.auth_utils import SECRET_KEY, ALGORITHM

load_dotenv()

async def update_user_last_seen(email: str):
    """Обновляет поле last_seen для пользователя."""
    users_collection = db_module.get_users_collection()
    await users_collection.update_one(
        {"email": email},
        {"$set": {"last_seen": datetime.utcnow()}}
    )

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login") 

async def get_current_user(request: Request) -> Dict[str, Any]:
    
    token: Optional[str] = request.cookies.get("access_token")

    if token is None:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
        else:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Не удалось проверить учетные данные: Токен отсутствует.",
                headers={"WWW-Authenticate": "Bearer"},
            )
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Не удалось проверить учетные данные: Неверный токен или истек.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_email: Optional[str] = payload.get("sub")
        username: Optional[str] = payload.get("username")
    
        if user_email is None or username is None:
            raise credentials_exception
    
        # Обновляем статус last_seen при успешной проверке токена
        await update_user_last_seen(user_email)
    
        return {"email": user_email, "username": username}
    except JWTError as e:
        raise credentials_exception
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Внутренняя ошибка сервера при проверке токена.")

