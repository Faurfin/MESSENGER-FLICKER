from fastapi import APIRouter
from pathlib import Path


router = APIRouter(tags=["Emojis"])


@router.get("/api/emojis")
async def get_emojis() -> dict:
    backend_dir = Path(__file__).resolve().parent.parent
    project_root = backend_dir.parent
    emoji_root = project_root / "images" / "emojy"

    result: dict[str, list[str]] = {}

    if not emoji_root.exists():
        return result

    allowed_ext = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}

    for category_dir in emoji_root.iterdir():
        if not category_dir.is_dir():
            continue
        category_name = category_dir.name
        items: list[str] = []
        for item in category_dir.iterdir():
            if item.is_file() and item.suffix.lower() in allowed_ext:
                items.append(f"/images/emojy/{category_name}/{item.name}")
        if items:
            items.sort()
            result[category_name] = items

    return result

