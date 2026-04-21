from fastapi import APIRouter, Depends, HTTPException, status, Request
from typing import Annotated, Optional

from backend.auth.auth_utils import get_current_user
import backend.db.database as db_module

router = APIRouter(
    prefix="/api/users", 
    tags=["Users & Chat"], 
)

@router.get("/search", summary="Поиск пользователей по имени, username или email")
async def search_users(
    request: Request,
    query: str,
    current_user: Annotated[dict, Depends(get_current_user)] 
):
    if not query or len(query.strip()) < 1: 
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Поисковый запрос не может быть пустым.")

    users_collection = db_module.get_users_collection()
    search_term = query.strip()

    # Ищем среди ВСЕХ пользователей (кроме самого себя) по username, email И full_name
    found_users = await users_collection.find(
        {
            "$and": [
                {
                    "$or": [
                        {"username": {"$regex": search_term, "$options": "i"}},
                        {"email": {"$regex": search_term, "$options": "i"}},
                        {"full_name": {"$regex": search_term, "$options": "i"}},
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