#!/bin/bash

# Скрипт автоматического деплоя Flicker Messenger
# Использование: ./deploy.sh yourdomain.com

set -e  # Остановка при ошибке

DOMAIN=${1:-"web-flicker.ru"}

echo "🚀 Начинаем деплой Flicker Messenger для домена: $DOMAIN"
echo ""

# Проверка наличия .env файла
if [ ! -f .env ]; then
    echo "❌ Файл .env не найден!"
    echo "📝 Создайте .env файл из env.example:"
    echo "   cp env.example .env"
    echo "   nano .env  # Заполните реальными значениями"
    exit 1
fi

echo "✅ Файл .env найден"

# Обновление домена в nginx.conf
if [ -f nginx/nginx.conf ]; then
    echo "📝 Обновление домена в nginx.conf..."
    sed -i "s/server_name .*/server_name $DOMAIN;/g" nginx/nginx.conf
    sed -i "s|ssl_certificate.*live/.*/fullchain.pem|ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;|g" nginx/nginx.conf
    sed -i "s|ssl_certificate_key.*live/.*/privkey.pem|ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;|g" nginx/nginx.conf
    echo "✅ Домен обновлен в nginx.conf"
else
    echo "⚠️  Файл nginx/nginx.conf не найден"
fi

# Проверка SSL сертификатов
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "⚠️  SSL сертификаты не найдены для домена $DOMAIN"
    echo "📝 Получите сертификаты командой:"
    echo "   sudo certbot certonly --standalone -d $DOMAIN"
    echo ""
    read -p "Продолжить без SSL? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "✅ SSL сертификаты найдены"
fi

# Остановка существующих контейнеров
echo "🛑 Остановка существующих контейнеров..."
docker-compose down 2>/dev/null || true

# Сборка и запуск
echo "🔨 Сборка и запуск контейнеров..."
docker-compose up -d --build

# Ожидание запуска
echo "⏳ Ожидание запуска сервисов..."
sleep 5

# Проверка статуса
echo ""
echo "📊 Статус контейнеров:"
docker-compose ps

echo ""
echo "✅ Деплой завершен!"
echo ""
echo "📝 Проверьте логи:"
echo "   docker-compose logs -f"
echo ""
echo "🌐 Откройте в браузере: https://$DOMAIN"
echo ""

