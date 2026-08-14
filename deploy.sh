#!/usr/bin/env bash
# ==============================================================================
# AITest Platform - Auto Deployment Script (Production Docker Compose)
# Usage: ./deploy.sh
# ==============================================================================

set -e

COMPOSE_FILE="docker-compose.production.yml"
ENV_FILE=".env.production"
ENV_EXAMPLE=".env.production.example"

echo "======================================================================"
echo " 🚀 BẮT ĐẦU TRIỂN KHAI BACKEND & DATABASE (AITEST PRODUCTION)"
echo "======================================================================"

# 1. Kiểm tra Docker & Docker Compose
if ! command -v docker &> /dev/null; then
    echo "❌ Lỗi: Docker chưa được cài đặt trên máy chủ này."
    exit 1
fi

if ! docker compose version &> /dev/null; then
    echo "❌ Lỗi: Docker Compose (v2) chưa được cài đặt."
    exit 1
fi

# 2. Kiểm tra tệp .env.production
if [ ! -f "$ENV_FILE" ]; then
    echo "⚠️  Cảnh báo: Không tìm thấy tệp $ENV_FILE!"
    if [ -f "$ENV_EXAMPLE" ]; then
        echo "💡 Tự động tạo $ENV_FILE từ $ENV_EXAMPLE..."
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        echo "❌ Đã tạo $ENV_FILE từ mẫu. Điền POSTGRES_PASSWORD, JWT_KEY, ENCRYPTION_KEY rồi chạy lại."
        exit 1
    else
        echo "❌ Lỗi: Không tìm thấy tệp mẫu $ENV_EXAMPLE."
        exit 1
    fi
fi

if grep -qE '<SET_ME' "$ENV_FILE"; then
    echo "❌ $ENV_FILE còn placeholder <SET_ME…>. Điền secret thật trước khi deploy."
    exit 1
fi

API_PORT=$(grep -E '^API_PORT=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r" ')
API_PORT=${API_PORT:-8000}

# 3. Khởi chạy Containers
echo "📦 1/3. Khởi chạy Containers bằng $COMPOSE_FILE..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

# 4. Chạy Alembic Migration CSDL
echo "🗄️  2/3. Thực thi Alembic DB Migrations..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T api alembic upgrade head

# 5. Kiểm tra trạng thái Services
echo "🔍 3/3. Kiểm tra trạng thái các Container Services..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps

echo "======================================================================"
echo " 🎉 TRIỂN KHAI HOÀN TẤT THÀNH CÔNG!"
echo " 🌐 API Server Endpoint: http://localhost:${API_PORT}/api"
echo "======================================================================"
