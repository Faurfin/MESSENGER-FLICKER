"""
Модуль для управления WebSocket подключениями.
Вынесен в отдельный файл для избежания циклических импортов.
"""
from fastapi import WebSocket
from typing import Dict, List
import json
import asyncio


class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, user_email: str, websocket: WebSocket):
        await websocket.accept()
        email_key = user_email.strip().lower()
        self.active_connections[email_key] = websocket
        print(f"[WS] connect: {email_key}")

    def disconnect(self, user_email: str):
        email_key = user_email.strip().lower()
        if email_key in self.active_connections:
            del self.active_connections[email_key]
        print(f"[WS] disconnect: {email_key}")

    async def send_to_user(self, user_email: str, message_data: dict):
        email_key = user_email.strip().lower()
        websocket = self.active_connections.get(email_key)
        if websocket:
            try:
                data = json.dumps(message_data, default=str)
                await websocket.send_text(data)
            except Exception as e:
                print(f"[WS] failed send to {email_key}: {e}")
                self.disconnect(email_key)

    async def broadcast_to_participants(self, participants: List[str], message_data: dict):
        if not participants:
            return
        data = json.dumps(message_data, default=str)
        tasks = []
        for email in participants:
            email_key = email.strip().lower()
            websocket = self.active_connections.get(email_key)
            if websocket:
                tasks.append(self._send_text_safe(websocket, data, email_key))
        if tasks:
            await asyncio.gather(*tasks)

    async def _send_text_safe(self, websocket: WebSocket, data: str, user_email: str):
        try:
            await websocket.send_text(data)
        except Exception as e:
            print(f"[WS] failed send to {user_email}: {e}")
            self.disconnect(user_email)


# Глобальный экземпляр менеджера
manager = ConnectionManager()
